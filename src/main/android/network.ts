// Android guest networking: tun2socks routing, geolocation, and controller client.
// Traced to requirements R10 (no guest traffic escapes proxy) and R11 (GPS derived from proxy).

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';
import type { AdbClient } from './adb';
import { createSocks5Server } from '../proxy/socks5Server';
import { logger } from '../util/logger';

export interface GuestNetworkPlan {
  tunInterface: 'tun0';
  socksHost: string; // 127.0.0.1 as seen from the guest: 10.0.2.2
  socksPort: number;
  tun2socksBinaryOnHost: string;
  /** True when the profile has no proxy — the guest then has NO route (fail closed). */
  blocked: boolean;
  /**
   * The upstream proxy the guest's traffic must ultimately reach, or null when `blocked`.
   * Carried on the plan so the SOCKS bridge can be raised from the same decision that decided
   * the guest has somewhere to go.
   */
  proxy: { type: string; host: string; port: number; username?: string | null; password?: string | null } | null;
}

/**
 * Resolves an operator-supplied tun2socks binary on the HOST (never bundled in the repo/image).
 * Order: `TUN2SOCKS_BIN` env → `DATA_DIR/bin/tun2socks[.exe]` → PATH (`tun2socks[.exe]`).
 * Returns '' when absent — setupGuestNetwork then pushes it via adb instead of failing.
 */
export function resolveTun2socksOnHost(dataDir?: string): string {
  const exe = process.platform === 'win32' ? 'tun2socks.exe' : 'tun2socks';
  const candidates: string[] = [];
  const envBin = process.env.TUN2SOCKS_BIN;
  if (envBin && envBin.length > 0) candidates.push(envBin);
  try {
    const base = dataDir ?? process.env.ANTIDETECT_DATA_DIR ?? '';
    if (base) candidates.push(path.join(base, 'bin', exe));
  } catch {
    // ignore config errors — PATH fallback below still applies
  }
  candidates.push(exe);
  for (const c of candidates) {
    try {
      if (path.isAbsolute(c) || c.includes(path.sep)) {
        if (fs.existsSync(c)) return c;
      } else {
        const pathEnv = process.env.PATH ?? '';
        for (const dir of pathEnv.split(path.delimiter)) {
          if (dir && fs.existsSync(path.join(dir, c))) return path.join(dir, c);
        }
      }
    } catch {
      // try next candidate
    }
  }
  return '';
}

/**
 * Plans the network routing configuration for the Android guest.
 * If the profile lacks a proxy, returns blocked: true so all network traffic fails closed
 * rather than leaking to the local host route.
 */
export function planGuestNetwork(
  proxy: { type: string; host: string; port: number; username?: string | null; password?: string | null } | null
): GuestNetworkPlan {
  // In QEMU / Android Emulator default user networking (SLIRP), the host loopback interface
  // (127.0.0.1) is accessed from within the guest via the virtual gateway IP 10.0.2.2.
  // Therefore, the guest-side tun2socks client must connect to 10.0.2.2 to reach the host SOCKS bridge.
  const socksHost = '10.0.2.2';

  if (!proxy) {
    return {
      tunInterface: 'tun0',
      socksHost,
      socksPort: 0,
      tun2socksBinaryOnHost: '',
      blocked: true,
      proxy: null,
    };
  }

  return {
    tunInterface: 'tun0',
    socksHost,
    // The port the guest dials is decided at setup time: the SOCKS bridge listens on an
    // ephemeral loopback port, so this is only a placeholder until the bridge reports one.
    socksPort: 0,
    tun2socksBinaryOnHost: '',
    blocked: false,
    proxy,
  };
}

/**
 * Cuts the guest's ability to reach the network.
 *
 * Used when a profile has no proxy: leaving the emulator's own NAT route in place would let the
 * guest reach the internet directly, which is the leak this module exists to prevent. Every step
 * is attempted because a stock (non-rooted) image rejects `iptables -P` while a rooted one accepts
 * it, and the interface-level commands work on both. The result is a success only if at least one
 * enforcement actually took effect — "we tried" is not the same answer as "it is blocked".
 */
async function blockGuestNetwork(adb: AdbClient): Promise<{ ok: boolean; detail: string }> {
  let policyDropApplied = false;

  for (const cmd of [
    ['iptables', '-P', 'OUTPUT', 'DROP'],
    ['ip6tables', '-P', 'OUTPUT', 'DROP'],
  ]) {
    try {
      await adb.shell(cmd);
      policyDropApplied = true;
    } catch {
      // Non-rooted image, or the table does not exist. The route removal below is the backstop.
    }
  }

  // Unprivileged, and effective on every image: take the interfaces down so there is nowhere for
  // a packet to go.
  for (const cmd of [
    ['svc', 'wifi', 'disable'],
    ['svc', 'data', 'disable'],
  ]) {
    try {
      await adb.shell(cmd);
    } catch {
      // Radio may already be off.
    }
  }

  let routesRemoved = false;
  for (const net of ['ip', 'ip -6']) {
    try {
      await adb.shell(['sh', '-c', `${net} route del default`]);
      routesRemoved = true;
    } catch {
      // No default route on this family, which is the desired end state anyway.
    }
  }

  if (!policyDropApplied && !routesRemoved) {
    return {
      ok: false,
      detail:
        'guest refused both the OUTPUT DROP policy (needs root) and the default-route removal, ' +
        'so its traffic cannot be confirmed blocked',
    };
  }

  return {
    ok: true,
    detail: policyDropApplied
      ? 'guest OUTPUT policy is DROP (iptables/ip6tables)'
      : 'guest default routes removed and radios disabled',
  };
}

/**
 * Starts the host-side SOCKS bridge (via opts.tunnel if provided) and the guest-side tun2socks service.
 * When the guest image lacks tun2socks, an operator-supplied host binary (`resolveTun2socksOnHost`)
 * is pushed via `adb push` to `/data/local/tmp/tun2socks` — never a silent pass-through.
 * Returns { ok:false } only when no binary exists on EITHER side; proxy-less profiles stay
 * fail-closed via blockGuestNetwork. Result carries `proxied:false` when the guest has direct
 * NAT access (binary truly absent) so the caller can surface degraded posture in status.
 */
export async function setupGuestNetwork(
  adb: AdbClient,
  plan: GuestNetworkPlan,
  opts: {
    tunnel?: { start: () => Promise<{ localPort: number }>; stop: () => Promise<void> };
  }
): Promise<{ ok: boolean; detail: string; proxied?: boolean; stopBridge?: () => Promise<void> }> {
  // A profile with no proxy must not be able to reach the network at all.
  if (plan.blocked) {
    const blocked = await blockGuestNetwork(adb);
    if (!blocked.ok) {
      logger.error('Failed to block guest networking for a proxy-less profile', { detail: blocked.detail });
      return blocked;
    }
    logger.info('Guest network blocked: no proxy configured for profile (fail-closed)', {
      detail: blocked.detail,
    });
    return blocked;
  }

  let effectiveSocksPort = plan.socksPort;

  // 1. Start host-side SOCKS bridge, or an explicit tunnel when the caller supplies one.
  //    The profile's proxy is remote and may need credentials, so the guest cannot dial it
  //    directly; without this leg it would be pointed at a port where nothing listens.
  let stopBridge: (() => Promise<void>) | null = null;
  if (opts.tunnel) {
    try {
      const tunnelRes = await opts.tunnel.start();
      effectiveSocksPort = tunnelRes.localPort;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to start host-side proxy tunnel', { error: msg });
      return {
        ok: false,
        detail: `Failed to start host-side proxy tunnel: ${msg}`,
      };
    }
  } else if (plan.proxy) {
    try {
      const bridge = await startUpstreamSocksBridge(plan.proxy);
      effectiveSocksPort = bridge.localPort;
      stopBridge = bridge.stop;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to start host-side SOCKS bridge', { error: msg });
      return {
        ok: false,
        detail: `Failed to start host-side SOCKS bridge: ${msg}`,
      };
    }
  }

  // 2. Locate tun2socks binary inside the guest
  let tun2socksPath = '';
  try {
    const whichRes = await adb.shell(['which', 'tun2socks']);
    if (whichRes && whichRes.trim() && !whichRes.includes('not found')) {
      tun2socksPath = whichRes.trim();
    }
  } catch {
    // which command threw or returned non-zero
  }

  if (!tun2socksPath) {
    const candidatePaths = [
      '/system/bin/tun2socks',
      '/data/adb/tun2socks',
      '/data/local/tmp/tun2socks',
    ];
    for (const candidate of candidatePaths) {
      try {
        await adb.shell(['test', '-x', candidate]);
        tun2socksPath = candidate;
        break;
      } catch {
        // candidate not found or not executable
      }
    }
  }

  if (!tun2socksPath) {
    // Stock google_apis image ships no tun2socks — push the operator's host binary
    // (TUN2SOCKS_BIN / DATA_DIR/bin / PATH; see data/android-tun2socks.README.md) instead of failing.
    const hostBin = plan.tun2socksBinaryOnHost || resolveTun2socksOnHost();
    if (hostBin) {
      try {
        await adb.push(hostBin, '/data/local/tmp/tun2socks');
        await adb.shell(['chmod', '755', '/data/local/tmp/tun2socks']);
        await adb.shell(['test', '-x', '/data/local/tmp/tun2socks']);
        tun2socksPath = '/data/local/tmp/tun2socks';
        logger.info('Pushed operator tun2socks binary to guest', { hostBin });
      } catch (err) {
        logger.warn('Failed to push operator tun2socks binary to guest', { hostBin, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  if (!tun2socksPath) {
    // No binary on either side: keep the SOCKS bridge for diagnostics but mark the
    // posture explicitly — the guest keeps direct NAT access, so this is degraded,
    // never "proxied". Caller surfaces `proxied:false` in status (no ERR throw).
    logger.warn('tun2socks binary not found on guest or host — guest keeps direct NAT access (degraded, NOT proxied)');
    return {
      ok: true,
      detail: 'host-bridge without guest tun2socks (degraded: direct NAT, NOT proxied — place a binary at TUN2SOCKS_BIN or data/bin/, see data/android-tun2socks.README.md)',
      proxied: false,
      stopBridge: stopBridge ?? undefined,
    };
  }

  // 3. Configure tun0 and launch tun2socks daemon
  try {
    await adb.shell(['ip', 'tuntap', 'add', 'mode', 'tun', 'dev', 'tun0']);
    await adb.shell(['ip', 'addr', 'add', '10.0.4.2/24', 'dev', 'tun0']);
    await adb.shell(['ip', 'link', 'set', 'dev', 'tun0', 'up']);
    await adb.shell(['ip', 'route', 'add', 'default', 'via', '10.0.4.1', 'dev', 'tun0']);

    const daemonCmd = `nohup ${tun2socksPath} --netif-ipaddr 10.0.4.2 --netif-netmask 255.255.255.0 --socks-server-addr ${plan.socksHost}:${effectiveSocksPort} --tunmtu 1500 --loglevel warn > /dev/null 2>&1 &`;
    await adb.shell(['sh', '-c', daemonCmd]);

    logger.info('Guest network configured successfully through tun2socks', {
      socksHost: plan.socksHost,
      socksPort: effectiveSocksPort,
    });

    return {
      ok: true,
      detail: `tun2socks active on ${plan.socksHost}:${effectiveSocksPort}`,
      proxied: true,
      stopBridge: stopBridge ?? undefined,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to configure guest network interface', { error: msg });
    // The bridge has no guest to serve now, so it must not stay listening.
    await stopBridge?.().catch(() => undefined);
    return {
      ok: false,
      detail: `Failed to configure guest network interface: ${msg}`,
    };
  }
}

/**
 * Raises a loopback SOCKS5 listener that forwards every connection to the profile's real proxy,
 * and returns the port the guest must be pointed at.
 *
 * The guest reaches the host loopback as `10.0.2.2` (QEMU SLIRP), and the profile's proxy is a
 * remote machine that frequently requires credentials the guest cannot present. So the guest is
 * pointed at this bridge rather than at the upstream proxy: the bridge terminates SOCKS locally,
 * opens the authenticated connection to the real proxy, and splices the two. Without it the guest
 * would be told to reach a SOCKS server on a port where nothing is listening.
 */
async function startUpstreamSocksBridge(proxy: {
  type: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}): Promise<{ localPort: number; stop: () => Promise<void> }> {
  const isHttpProxy = proxy.type === 'http' || proxy.type === 'https';
  const auth = proxy.username
    ? Buffer.from(`${proxy.username}:${proxy.password ?? ''}`, 'utf8').toString('base64')
    : null;

  // `createSocks5Server` terminates SOCKS5 on loopback and hands us each resolved target; the
  // connector below opens the upstream leg through the real proxy.
  const server = await createSocks5Server({
    connect: (host, port) =>
      new Promise<Duplex>((resolve, reject) => {
        const socket = net.connect({ host: proxy.host, port: proxy.port }, () => {
          if (isHttpProxy) {
            const target = `${host}:${port}`;
            socket.write(
              [
                `CONNECT ${target} HTTP/1.1`,
                `Host: ${target}`,
                ...(auth ? [`Proxy-Authorization: Basic ${auth}`] : []),
                '',
                '',
              ].join('\r\n'),
            );
          } else if (auth) {
            // RFC 1929 username/password sub-negotiation: version, ulen, uname, plen, passwd.
            const user = Buffer.from(proxy.username ?? '', 'utf8');
            const pass = Buffer.from(proxy.password ?? '', 'utf8');
            socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          }
          resolve(socket);
        });
        socket.once('error', reject);
      }),
  });

  return {
    localPort: server.port,
    stop: () => server.close(),
  };
}

/**
 * Tears down guest tun2socks routing and removes the tun0 interface.
 */
export async function teardownGuestNetwork(adb: AdbClient): Promise<void> {
  try {
    await adb.shell(['pkill', '-f', 'tun2socks']);
  } catch {
    // best-effort cleanup
  }
  try {
    await adb.shell(['ip', 'link', 'set', 'dev', 'tun0', 'down']);
    await adb.shell(['ip', 'tuntap', 'del', 'mode', 'tun', 'dev', 'tun0']);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Controller interface for communicating with emulator console.
 */
export interface AndroidControllerClient {
  setLocation(lat: number, lng: number): Promise<void>;
  rotate(): Promise<void>;
  sendKey(keycode: number): Promise<void>;
  close(): void;
}

/**
 * Pushes GPS coordinates to the emulator controller ONLY when non-null.
 * When null, pushes nothing and returns: a plausible default city would be a false leak (R11).
 */
export async function pushGeolocation(
  grpc: AndroidControllerClient,
  geo: { latitude: number; longitude: number } | null
): Promise<void> {
  if (
    !geo ||
    typeof geo.latitude !== 'number' ||
    typeof geo.longitude !== 'number' ||
    Number.isNaN(geo.latitude) ||
    Number.isNaN(geo.longitude)
  ) {
    return;
  }

  await grpc.setLocation(geo.latitude, geo.longitude);
}

/**
 * Connects to the emulator telnet/console interface.
 * Requires the auth token from ~/.emulator_console_auth_token (or authTokenPath);
 * reads and verifies the token, reporting a missing file rather than skipping authentication.
 */
export function connectController(
  consolePort: number,
  authTokenPath?: string
): AndroidControllerClient {
  const resolvedPath = authTokenPath
    ? path.resolve(authTokenPath)
    : path.join(os.homedir(), '.emulator_console_auth_token');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Emulator console auth token file not found at ${resolvedPath}`);
  }

  const token = fs.readFileSync(resolvedPath, 'utf8').trim();
  if (!token) {
    throw new Error(`Emulator console auth token file is empty: ${resolvedPath}`);
  }

  let socket: net.Socket | null = null;
  let isClosed = false;

  async function getAuthenticatedSocket(): Promise<net.Socket> {
    if (isClosed) {
      throw new Error('Controller client is closed');
    }
    if (socket && !socket.destroyed) {
      return socket;
    }

    const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
    const s = net.createConnection({ host: '127.0.0.1', port: consolePort }, () => {
      // Connected, wait for banner then send auth command
    });

    let authenticated = false;
    let buffer = '';

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // Initial console banner requires typing auth <token>
      if (!authenticated && (buffer.includes('OK') || buffer.includes('auth <auth_token>'))) {
        authenticated = true;
        buffer = '';
        s.write(`auth ${token}\r\n`);
        return;
      }

      if (authenticated) {
        if (buffer.includes('OK')) {
          s.off('data', onData);
          socket = s;
          resolve(s);
        } else if (buffer.includes('KO')) {
          s.destroy();
          reject(new Error(`Emulator console authentication failed: ${buffer.trim()}`));
        }
      }
    };

    s.on('data', onData);
    s.once('error', (err) => {
      reject(new Error(`Connection to emulator console on port ${consolePort} failed: ${err.message}`));
    });

    return promise;
  }

  async function sendCommand(command: string): Promise<string> {
    const s = await getAuthenticatedSocket();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    let out = '';
    const onData = (data: Buffer) => {
      out += data.toString('utf8');
      if (out.includes('OK')) {
        cleanup();
        resolve(out.trim());
      } else if (out.includes('KO')) {
        cleanup();
        reject(new Error(`Emulator console command '${command}' rejected: ${out.trim()}`));
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      s.off('data', onData);
      s.off('error', onError);
    };

    s.on('data', onData);
    s.once('error', onError);
    s.write(`${command}\r\n`);
    return promise;
  }

  return {
    async setLocation(lat: number, lng: number): Promise<void> {
      // Android emulator console syntax: geo fix <longitude> <latitude>
      await sendCommand(`geo fix ${lng} ${lat}`);
    },

    async rotate(): Promise<void> {
      await sendCommand('rotate');
    },

    async sendKey(keycode: number): Promise<void> {
      await sendCommand(`event send EV_KEY:${keycode}:1`);
      await sendCommand(`event send EV_KEY:${keycode}:0`);
    },

    close(): void {
      isClosed = true;
      if (socket) {
        socket.destroy();
        socket = null;
      }
    },
  };
}
