// Transport policy & pre-launch probe engine for SOCKS5/HTTP/SSH proxies.
// Implements OpenSpec network-transport-policy and Table 6.1 matrix.

import * as net from 'net';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import * as os from 'os';

export type TransportPolicyStatus = 'NO_PROXY' | 'SOCKS5_FULL_PASS' | 'CONSTRAINED' | 'REFUSE';

export interface TransportProbeTarget {
  protocol: 'socks5' | 'http' | 'https' | 'ssh' | 'direct';
  host: string;
  port: number;
  username?: string;
  password?: string;
  cred_version?: string;
  interface_id?: string;
  dns_mode?: string;
}

export type ProbeFailureReason =
  | 'udp-associate-refused'
  | 'stun-timeout'
  | 'auth-failed'
  | 'network-unreachable'
  | 'none';

export interface TransportProbeResult {
  status: TransportPolicyStatus;
  reason?: ProbeFailureReason;
  stages: {
    tcpConnect: boolean;
    auth: boolean;
    proxyDns: boolean;
    udpAssociate?: boolean;
    stunIpv4?: boolean;
    stunIpv6?: boolean;
    quic?: boolean;
  };
  error?: {
    stage: string;
    code: string;
    message: string;
  };
  timestamp: number;
}

export interface ComposeFlagsOptions {
  status: TransportPolicyStatus;
  proxyServer?: string;
}

// 600s cache TTL per spec
const CACHE_TTL_MS = 600 * 1000;
// 15s timeout per stage, matching checkProxy in proxyManager: residential/mobile proxies
// and overseas hops frequently require 5-10s for initial TCP and routing handshakes.
const STAGE_TIMEOUT_MS = 15000;
const secretSalt = crypto.randomBytes(32).toString('hex');

// In-memory probe cache
const probeCache = new Map<string, TransportProbeResult>();
// Single-flight in-flight promise map
const singleFlightMap = new Map<string, Promise<TransportProbeResult>>();

// Registered active proxied profile listeners
const activeProfiles = new Map<string, { onTransportLoss?: (reason: string) => void }>();

/**
 * Compute HMAC-SHA256 key without raw passwords or tokens.
 */
export function deriveTransportCacheKey(target: TransportProbeTarget): string {
  const payload = `${target.protocol}:${target.host}:${target.port}:${target.username || ''}:${target.cred_version || '1'}:${target.interface_id || 'default'}:${target.dns_mode || 'remote'}`;
  return crypto.createHmac('sha256', secretSalt).update(payload).digest('hex');
}

/**
 * Get a hash/checksum of host network interfaces to detect IP/gateway changes.
 */
export function getNetworkInterfacesFingerprint(): string {
  const nets = os.networkInterfaces();
  const serialized = Object.keys(nets)
    .sort()
    .map((name) => {
      const addrs = (nets[name] || [])
        .map((a) => `${a.address}/${a.family}/${a.internal}`)
        .sort()
        .join(',');
      return `${name}:${addrs}`;
    })
    .join(';');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

let lastInterfaceFingerprint = getNetworkInterfacesFingerprint();

/**
 * Invalidate in-memory probe cache.
 */
export function invalidateTransportCache(): void {
  probeCache.clear();
}

/**
 * Check if network interfaces changed; if so, clear cache and notify active proxied profiles.
 */
export function checkNetworkInterfaceChange(): boolean {
  const current = getNetworkInterfacesFingerprint();
  if (current !== lastInterfaceFingerprint) {
    lastInterfaceFingerprint = current;
    invalidateTransportCache();
    notifyTransportLoss('network_interface_changed');
    return true;
  }
  return false;
}

// Register profile for transport loss notifications
export function registerActiveProfile(profileId: string, listener?: (reason: string) => void): () => void {
  activeProfiles.set(profileId, { onTransportLoss: listener });
  return () => {
    activeProfiles.delete(profileId);
  };
}

export function unregisterActiveProfile(profileId: string): void {
  activeProfiles.delete(profileId);
}
export class StrictQuicRelayError extends Error {
  public readonly profileId?: string;
  public readonly cause?: unknown;

  constructor(message: string, options?: { profileId?: string; cause?: unknown }) {
    super(message);
    this.name = 'StrictQuicRelayError';
    this.profileId = options?.profileId;
    this.cause = options?.cause;
    Object.setPrototypeOf(this, StrictQuicRelayError.prototype);
  }
}


export function notifyTransportLoss(reason: string, profileId?: string): void {
  if (profileId) {
    const handler = activeProfiles.get(profileId);
    if (handler?.onTransportLoss) {
      handler.onTransportLoss(reason);
    }
  } else {
    for (const [, handler] of activeProfiles.entries()) {
      if (handler.onTransportLoss) {
        handler.onTransportLoss(reason);
      }
    }
  }
}

/**
 * Compose Chromium flags according to Table 6.1.
 */
export function composeTransportFlags(result: TransportProbeResult | { status: TransportPolicyStatus }, proxyServer?: string): string[] {
  const flags: string[] = [];

  if (result.status === 'NO_PROXY') {
    return flags;
  }

  if (proxyServer) {
    flags.push(`--proxy-server=${proxyServer}`);
    flags.push(`--proxy-bypass-list=<-loopback>`);
  }

  // The kernel exposes `--webrtc-ip-handling-policy` (verified against `chrome.dll` in the
  // pinned build). The `force-`-prefixed spelling these two lines used does NOT exist in the
  // binary: Chromium accepts unknown switches and ignores them, so the leak protection these
  // branches promise was never applied.
  if (result.status === 'SOCKS5_FULL_PASS') {
    flags.push(`--webrtc-ip-handling-policy=disable_non_proxied_udp`);
  } else if (result.status === 'CONSTRAINED') {
    flags.push(`--disable-quic`);
    flags.push(`--webrtc-ip-handling-policy=disable_non_proxied_udp`);
    flags.push(`--disable-webrtc`);
  }

  return flags;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Helper to run a probe stage with 5000ms timeout and exactly 1 jittered retry on timeout only.
 */
async function runProbeWithRetry<T>(
  stageName: string,
  fn: () => Promise<T>,
  timeoutMs: number = STAGE_TIMEOUT_MS
): Promise<T> {
  const attempt = async (): Promise<T> => {
    const { promise, resolve, reject } = createDeferred<T>();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const err = new Error(`Stage ${stageName} timed out after ${timeoutMs}ms`);
        err.name = 'TimeoutError';
        reject(err);
      }
    }, timeoutMs);

    fn()
      .then((res) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res);
        }
      })
      .catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

    return promise;
  };
  try {
    return await attempt();
  } catch (err: unknown) {
    const isTimeout =
      (err instanceof Error && (err.name === 'TimeoutError' || err.message.includes('timed out')));
    if (isTimeout) {
      // Exactly 1 jittered retry (50ms - 200ms)
      const jitter = 50 + Math.floor(Math.random() * 150);
      await new Promise<void>((r) => {
        setTimeout(r, jitter);
      });
      return await attempt();
    }
    throw err;
  }
}

/**
 * Probe SOCKS5 TCP connect, Auth, Proxy-DNS, UDP_ASSOCIATE, STUN, QUIC.
 */
async function probeSocks5(
  target: TransportProbeTarget,
  timeoutMs: number = STAGE_TIMEOUT_MS
): Promise<TransportProbeResult> {
  const stages: TransportProbeResult['stages'] = {
    tcpConnect: false,
    auth: false,
    proxyDns: false,
  };

  let socket: net.Socket | null = null;
  let udpRelayHost: string | null = null;
  let udpRelayPort: number | null = null;

  try {
    // 1. TCP Connect
    await runProbeWithRetry('tcpConnect', () => {
      const { promise, resolve, reject } = createDeferred<void>();
      const s = net.connect({ host: target.host, port: target.port });
      socket = s;
      s.once('connect', () => {
        stages.tcpConnect = true;
        resolve();
      });
      s.once('error', (err) => {
        s.destroy();
        reject(err);
      });
      return promise;
    }, timeoutMs);

    if (!socket) {
      throw new Error('TCP connection failed');
    }
    const currentSocket: net.Socket = socket;

    // 2. Auth verification
    await runProbeWithRetry('auth', () => {
      const { promise, resolve, reject } = createDeferred<void>();
      const hasAuth = !!(target.username && target.password);
      // SOCKS5 greeting
      const methods = hasAuth ? [0x00, 0x02] : [0x00];
      const greeting = Buffer.from([0x05, methods.length, ...methods]);

      const onData = (data: Buffer) => {
        if (data.length < 2 || data[0] !== 0x05) {
          return reject(new Error('Invalid SOCKS5 version in greeting reply'));
        }
        const chosenMethod = data[1];
        if (chosenMethod === 0xff) {
          return reject(new Error('No acceptable authentication methods'));
        }

        if (chosenMethod === 0x02) {
          if (!hasAuth) return reject(new Error('Server requested auth but none provided'));
          // RFC 1929 username/password auth
          const uLen = Buffer.byteLength(target.username!);
          const pLen = Buffer.byteLength(target.password!);
          const authBuf = Buffer.alloc(3 + uLen + pLen);
          authBuf[0] = 0x01; // auth version
          authBuf[1] = uLen;
          authBuf.write(target.username!, 2, uLen, 'utf8');
          authBuf[2 + uLen] = pLen;
          authBuf.write(target.password!, 3 + uLen, pLen, 'utf8');

          const onAuthReply = (authReply: Buffer) => {
            if (authReply.length < 2 || authReply[0] !== 0x01 || authReply[1] !== 0x00) {
              return reject(new Error('SOCKS5 authentication failed'));
            }
            stages.auth = true;
            resolve();
          };
          currentSocket.once('data', onAuthReply);
          currentSocket.write(authBuf);
        } else if (chosenMethod === 0x00) {
          stages.auth = true;
          resolve();
        } else {
          reject(new Error(`Unsupported SOCKS5 method: ${chosenMethod}`));
        }
      };

      currentSocket.once('data', onData);
      currentSocket.write(greeting);
      return promise;
    }, timeoutMs);

    // 3. Proxy DNS resolution check via domain CONNECT
    await runProbeWithRetry('proxyDns', () => {
      const { promise, resolve, reject } = createDeferred<void>();
      const domain = 'one.one.one.one';
      const dLen = domain.length;
      const port = 80;
      const req = Buffer.alloc(5 + dLen + 2);
      req[0] = 0x05; // SOCKS5
      req[1] = 0x01; // CONNECT
      req[2] = 0x00; // RSV
      req[3] = 0x03; // DOMAINNAME
      req[4] = dLen;
      req.write(domain, 5, dLen, 'utf8');
      req.writeUInt16BE(port, 5 + dLen);

      const onConnectReply = (data: Buffer) => {
        if (data.length < 4 || data[0] !== 0x05) {
          return reject(new Error('Invalid SOCKS5 reply for DNS connect probe'));
        }
        const rep = data[1];
        if (rep === 0x00) {
          stages.proxyDns = true;
          resolve();
        } else {
          reject(new Error(`SOCKS5 CONNECT domain failed with code ${rep}`));
        }
      };

      currentSocket.once('data', onConnectReply);
      currentSocket.write(req);
      return promise;
    }, timeoutMs);

    // After DNS connect succeeds, close socket and open new connection for UDP_ASSOCIATE
    if (socket) {
      try {
        (socket as net.Socket).destroy();
      } catch {
        // ignore
      }
      socket = null;
    }

    // 4. SOCKS5 UDP_ASSOCIATE
    let udpSocket: net.Socket | null = null;
    try {
      await runProbeWithRetry('udpAssociate', async () => {
        const { promise: connPromise, resolve: connResolve, reject: connReject } = createDeferred<net.Socket>();
        const s = net.connect({ host: target.host, port: target.port });
        s.once('connect', () => connResolve(s));
        s.once('error', (err) => connReject(err));
        udpSocket = await connPromise;

        // Greeting again on the new socket
        const hasAuth = !!(target.username && target.password);
        const methods = hasAuth ? [0x00, 0x02] : [0x00];
        const greeting = Buffer.from([0x05, methods.length, ...methods]);

        const { promise: greetPromise, resolve: greetResolve, reject: greetReject } = createDeferred<void>();
        udpSocket.once('data', (data) => {
          const chosen = data[1];
          if (chosen === 0x02) {
            const uLen = Buffer.byteLength(target.username!);
            const pLen = Buffer.byteLength(target.password!);
            const authBuf = Buffer.alloc(3 + uLen + pLen);
            authBuf[0] = 0x01;
            authBuf[1] = uLen;
            authBuf.write(target.username!, 2, uLen, 'utf8');
            authBuf[2 + uLen] = pLen;
            authBuf.write(target.password!, 3 + uLen, pLen, 'utf8');

            udpSocket!.once('data', (aRep) => {
              if (aRep[1] === 0x00) greetResolve();
              else greetReject(new Error('UDP socket auth failed'));
            });
            udpSocket!.write(authBuf);
          } else if (chosen === 0x00) {
            greetResolve();
          } else {
            greetReject(new Error('UDP socket method rejected'));
          }
        });
        udpSocket.write(greeting);
        await greetPromise;

        // Send UDP_ASSOCIATE command (CMD = 0x03)
        const req = Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        const { promise: assocPromise, resolve: assocResolve, reject: assocReject } = createDeferred<void>();
        udpSocket.once('data', (reply) => {
          if (reply.length < 10 || reply[0] !== 0x05 || reply[1] !== 0x00) {
            return assocReject(new Error(`UDP_ASSOCIATE failed with rep ${reply[1]}`));
          }
          const atyp = reply[3];
          if (atyp === 0x01) {
            udpRelayHost = `${reply[4]}.${reply[5]}.${reply[6]}.${reply[7]}`;
            udpRelayPort = reply.readUInt16BE(8);
          } else if (atyp === 0x03) {
            const dLen = reply[4];
            udpRelayHost = reply.subarray(5, 5 + dLen).toString('utf8');
            udpRelayPort = reply.readUInt16BE(5 + dLen);
          } else if (atyp === 0x04) {
            const parts: string[] = [];
            for (let i = 0; i < 8; i++) {
              parts.push(reply.readUInt16BE(4 + i * 2).toString(16));
            }
            udpRelayHost = parts.join(':');
            udpRelayPort = reply.readUInt16BE(20);
          }

          if (udpRelayHost === '0.0.0.0' || !udpRelayHost) {
            udpRelayHost = target.host;
          }
          stages.udpAssociate = true;
          assocResolve();
        });
        udpSocket.write(req);
        await assocPromise;
      }, timeoutMs);
    } catch {
      stages.udpAssociate = false;
    }

    if (!stages.udpAssociate || !udpRelayHost || !udpRelayPort) {
      if (udpSocket) {
        try {
          (udpSocket as net.Socket).destroy();
        } catch {
          // ignore
        }
      }
      return {
        status: 'CONSTRAINED',
        reason: 'udp-associate-refused',
        stages,
        timestamp: Date.now(),
      };
    }

    // 5. STUN Binding Request over SOCKS5 UDP relay
    try {
      await runProbeWithRetry('stunProbe', async () => {
        const { promise, resolve, reject } = createDeferred<void>();
        const client = dgram.createSocket('udp4');
        client.on('error', (err) => {
          try {
            client.close();
          } catch {
            // ignore
          }
          reject(err);
        });

        // STUN Binding Request (RFC 5389)
        const stunMsg = Buffer.alloc(20);
        stunMsg.writeUInt16BE(0x0001, 0); // Type
        stunMsg.writeUInt16BE(0x0000, 2); // Length
        stunMsg.writeUInt32BE(0x2112a442, 4); // Magic cookie
        crypto.randomBytes(12).copy(stunMsg, 8); // Transaction ID

        // SOCKS5 UDP header (RFC 1928 Section 7)
        const targetStunIp = [1, 1, 1, 1];
        const targetStunPort = 3478;
        const socksUdpHdr = Buffer.alloc(10);
        socksUdpHdr[0] = 0x00;
        socksUdpHdr[1] = 0x00;
        socksUdpHdr[2] = 0x00;
        socksUdpHdr[3] = 0x01;
        Buffer.from(targetStunIp).copy(socksUdpHdr, 4);
        socksUdpHdr.writeUInt16BE(targetStunPort, 8);

        const fullPacket = Buffer.concat([socksUdpHdr, stunMsg]);

        client.on('message', () => {
          stages.stunIpv4 = true;
          stages.stunIpv6 = true;
          try {
            client.close();
          } catch {
            // ignore
          }
          resolve();
        });

        client.send(fullPacket, udpRelayPort!, udpRelayHost!, (err) => {
          if (err) {
            try {
              client.close();
            } catch {
              // ignore
            }
            reject(err);
          }
        });

        return promise;
      }, timeoutMs);
    } catch {
      stages.stunIpv4 = false;
      stages.stunIpv6 = false;
    }
    // 6. QUIC probe
    try {
      await runProbeWithRetry('quicProbe', async () => {
        const { promise, resolve, reject } = createDeferred<void>();
        const client = dgram.createSocket('udp4');
        client.on('error', (err) => {
          try {
            client.close();
          } catch {
            // ignore
          }
          reject(err);
        });

        const quicPkt = Buffer.from([
          0xc0, // Long header, Initial packet
          0x00, 0x00, 0x00, 0x01, // Version 1
          0x08, // DCID length
          0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
          0x00, // SCID length
          0x00, // Token length
          0x05, // Length
          0x00, 0x00, 0x00, 0x01, 0x00, // Payload
        ]);

        const targetQuicIp = [1, 1, 1, 1];
        const targetQuicPort = 443;
        const socksUdpHdr = Buffer.alloc(10);
        socksUdpHdr[0] = 0x00;
        socksUdpHdr[1] = 0x00;
        socksUdpHdr[2] = 0x00;
        socksUdpHdr[3] = 0x01;
        Buffer.from(targetQuicIp).copy(socksUdpHdr, 4);
        socksUdpHdr.writeUInt16BE(targetQuicPort, 8);

        const fullPacket = Buffer.concat([socksUdpHdr, quicPkt]);

        client.on('message', () => {
          stages.quic = true;
          try {
            client.close();
          } catch {
            // ignore
          }
          resolve();
        });

        client.send(fullPacket, udpRelayPort!, udpRelayHost!, (err) => {
          if (err) {
            try {
              client.close();
            } catch {
              // ignore
            }
            reject(err);
          }
        });

        return promise;
      }, timeoutMs);
    } catch {
      stages.quic = false;
    } finally {
      if (udpSocket) {
        try {
          (udpSocket as net.Socket).destroy();
        } catch {
          // ignore
        }
      }
    }

    if (stages.udpAssociate && stages.stunIpv4 && stages.quic) {
      return {
        status: 'SOCKS5_FULL_PASS',
        reason: 'none',
        stages,
        timestamp: Date.now(),
      };
    }

    const reason: ProbeFailureReason = !stages.stunIpv4 ? 'stun-timeout' : 'none';
    return {
      status: 'CONSTRAINED',
      reason,
      stages,
      timestamp: Date.now(),
    };
  } catch (err: unknown) {
    if (socket) {
      try {
        (socket as net.Socket).destroy();
      } catch {
        // ignore
      }
    }

    const failedStage = !stages.tcpConnect
      ? 'tcpConnect'
      : !stages.auth
      ? 'auth'
      : !stages.proxyDns
      ? 'proxyDns'
      : 'unknown';

    const errObj = err as { code?: string; message?: string };
    let reason: ProbeFailureReason = 'network-unreachable';
    if (failedStage === 'auth') {
      reason = 'auth-failed';
    } else if (errObj.code === 'ECONNREFUSED' || errObj.code === 'ENOTFOUND' || errObj.code === 'ETIMEDOUT') {
      reason = 'network-unreachable';
    }

    return {
      status: 'REFUSE',
      reason,
      stages,
      error: {
        stage: failedStage,
        code: errObj.code || 'PROBE_FAILED',
        message: errObj.message || 'Probe failed',
      },
      timestamp: Date.now(),
    };
  }
}

/**
 * Probe HTTP/HTTPS proxy.
 */
async function probeHttp(
  target: TransportProbeTarget,
  timeoutMs: number = STAGE_TIMEOUT_MS
): Promise<TransportProbeResult> {
  const stages: TransportProbeResult['stages'] = {
    tcpConnect: false,
    auth: false,
    proxyDns: false,
  };

  let socket: net.Socket | null = null;
  try {
    // 1. TCP Connect
    await runProbeWithRetry('tcpConnect', () => {
      const { promise, resolve, reject } = createDeferred<void>();
      const s = net.connect({ host: target.host, port: target.port });
      socket = s;
      s.once('connect', () => {
        stages.tcpConnect = true;
        resolve();
      });
      s.once('error', (err) => {
        s.destroy();
        reject(err);
      });
      return promise;
    }, timeoutMs);

    if (!socket) throw new Error('TCP connect failed');
    const currentSocket: net.Socket = socket;

    // 2. Auth & Proxy DNS via CONNECT request
    await runProbeWithRetry('httpConnect', () => {
        const { promise, resolve, reject } = createDeferred<void>();
        const headers: string[] = [`CONNECT one.one.one.one:443 HTTP/1.1`, `Host: one.one.one.one:443`];
      if (target.username && target.password) {
        const creds = Buffer.from(`${target.username}:${target.password}`).toString('base64');
        headers.push(`Proxy-Authorization: Basic ${creds}`);
      }
      headers.push('\r\n');

      currentSocket.once('data', (data) => {
        const resp = data.toString('utf8');
        const [statusLine] = resp.split('\r\n');
        const parts = statusLine.split(' ');
        const statusCode = parseInt(parts[1], 10);

        if (statusCode === 407) {
          stages.auth = false;
          return reject(new Error('Proxy Authentication Required (407)'));
        }

        if (statusCode >= 200 && statusCode < 300) {
          stages.auth = true;
          stages.proxyDns = true;
          resolve();
        } else {
          reject(new Error(`HTTP proxy returned status ${statusCode}`));
        }
      });

      currentSocket.write(headers.join('\r\n'));
      return promise;
    }, timeoutMs);

    if (socket) {
      try {
        (socket as net.Socket).destroy();
      } catch {
        // ignore
      }
    }

    // HTTP proxies do not support UDP_ASSOCIATE -> CONSTRAINED per Table 6.1
    return {
      status: 'CONSTRAINED',
      reason: 'udp-associate-refused',
      stages,
      timestamp: Date.now(),
    };
  } catch (err: unknown) {
    if (socket) {
      try {
        (socket as net.Socket).destroy();
      } catch {
        // ignore
      }
    }
    const failedStage = !stages.tcpConnect ? 'tcpConnect' : 'auth';
    const errObj = err as { code?: string; message?: string };
    const reason: ProbeFailureReason = failedStage === 'auth' ? 'auth-failed' : 'network-unreachable';
    return {
      status: 'REFUSE',
      reason,
      stages,
      error: {
        stage: failedStage,
        code: errObj.code || 'PROBE_FAILED',
        message: errObj.message || 'Probe failed',
      },
      timestamp: Date.now(),
    };
  }
}

/**
 * Probe a proxy target with single-flight caching and HMAC keying.
 */
export async function probeTransportTarget(
  target: TransportProbeTarget,
  options: { bypassCache?: boolean; timeoutMs?: number } = {}
): Promise<TransportProbeResult> {
  if (target.protocol === 'direct') {
    return {
      status: 'NO_PROXY',
      stages: { tcpConnect: true, auth: true, proxyDns: true },
      timestamp: Date.now(),
    };
  }

  // Check network interface change
  checkNetworkInterfaceChange();

  const cacheKey = deriveTransportCacheKey(target);

  if (!options.bypassCache) {
    const cached = probeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached;
    }
  }

  // Single flight deduplication
  if (singleFlightMap.has(cacheKey)) {
    return singleFlightMap.get(cacheKey)!;
  }

  const probePromise = (async () => {
    try {
      let result: TransportProbeResult;
      const timeoutMs = options.timeoutMs ?? STAGE_TIMEOUT_MS;

      if (target.protocol === 'socks5') {
        result = await probeSocks5(target, timeoutMs);
      } else if (target.protocol === 'http' || target.protocol === 'https') {
        result = await probeHttp(target, timeoutMs);
      } else if (target.protocol === 'ssh') {
        // SSH proxies forward TCP via dynamic tunnel -> CONSTRAINED
        result = {
          status: 'CONSTRAINED',
          stages: { tcpConnect: true, auth: true, proxyDns: true },
          timestamp: Date.now(),
        };
      } else {
        result = {
          status: 'REFUSE',
          stages: { tcpConnect: false, auth: false, proxyDns: false },
          error: { stage: 'protocol', code: 'UNSUPPORTED_PROTOCOL', message: `Unsupported protocol ${target.protocol}` },
          timestamp: Date.now(),
        };
      }

      if (result.status !== 'REFUSE') {
        probeCache.set(cacheKey, result);
      }
      return result;
    } finally {
      singleFlightMap.delete(cacheKey);
    }
  })();

  singleFlightMap.set(cacheKey, probePromise);
  return probePromise;
}
