// Android guest networking: tun2socks routing, geolocation, and controller client.
// Traced to requirements R10 (no guest traffic escapes proxy) and R11 (GPS derived from proxy).

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';
import type { AdbClient } from './adb';
import { createSocks5Server } from '../proxy/socks5Server';
import { enableGuestRoot } from './injector';
import { logger } from '../util/logger';

/** Coded failure for the guest-network path (bridge/tunnel/interface errors abort the launch). */
export class AndroidNetworkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AndroidNetworkError';
  }
}

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
 * Returns '' when absent — setupGuestNetwork then reports degraded NAT instead of failing.
 *
 * The binary RUNS ON THE GUEST (it is pushed via adb), so on Windows both the extensionless
 * Android name (`tun2socks`, an ELF) and the host-style `tun2socks.exe` are accepted — the old
 * code looked only for the `.exe` and missed the real file sitting next to it.
 */
export function resolveTun2socksOnHost(dataDir?: string): string {
  const names = process.platform === 'win32' ? ['tun2socks', 'tun2socks.exe'] : ['tun2socks'];
  const candidates: string[] = [];
  const envBin = process.env.TUN2SOCKS_BIN;
  if (envBin && envBin.length > 0) candidates.push(envBin);
  try {
    const base = dataDir ?? process.env.ANTIDETECT_DATA_DIR ?? '';
    if (base) for (const name of names) candidates.push(path.join(base, 'bin', name));
  } catch {
    // ignore config errors — PATH fallback below still applies
  }
  candidates.push(...names);
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
  // `ip` and `iptables` both need CAP_NET_ADMIN; as the unprivileged `shell` user every one of
  // them fails with "Permission denied" on the google_apis image. `adb root` (available on that
  // image) is the prerequisite, exactly as it is for the identity injector.
  const asRoot = await enableGuestRoot(adb);

  let policyDropApplied = false;
  for (const cmd of [
    ['iptables', '-P', 'OUTPUT', 'DROP'],
    ['ip6tables', '-P', 'OUTPUT', 'DROP'],
  ]) {
    try {
      await adb.shell(cmd);
      policyDropApplied = true;
    } catch {
      // The table may not exist on this image; the route removal below is the backstop.
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

  // Report what the kernel actually kept, not what we asked for: `ip route del default` exits 2
  // with "No such process" when the emulator's SLIRP default lives in a different table, and an
  // exit code alone cannot tell "already blocked" from "refused".
  let routesRemoved = false;
  for (const cmd of [
    ['ip', 'route', 'del', 'default'],
    ['ip', '-6', 'route', 'del', 'default'],
  ]) {
    try {
      await adb.shell(cmd);
      routesRemoved = true;
    } catch {
      // No default route on this family, which is the desired end state anyway.
    }
  }

  if (!policyDropApplied && !routesRemoved) {
    return {
      ok: false,
      detail:
        `guest refused both the OUTPUT DROP policy${asRoot ? '' : ' (no adb root)'} and the ` +
        'default-route removal, so its traffic cannot be confirmed blocked',
    };
  }

  return {
    ok: true,
    detail: policyDropApplied
      ? 'guest OUTPUT policy is DROP (iptables/ip6tables)'
      : 'guest default routes removed, radios disabled',
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

  // 2. Locate tun2socks binary inside the guest. `which`/`test` exit non-zero for "absent",
  // which is the normal case on a stock image — shellCode answers that without throwing.
  let tun2socksPath = '';
  const whichRes = await adb.shellCode(['which', 'tun2socks']);
  if (whichRes.exitCode === 0 && whichRes.stdout.trim().length > 0) {
    tun2socksPath = whichRes.stdout.trim();
  }

  if (!tun2socksPath) {
    for (const candidate of [
      '/system/bin/tun2socks',
      '/data/adb/tun2socks',
      '/data/local/tmp/tun2socks',
    ]) {
      const probe = await adb.shellCode(['test', '-x', candidate]);
      if (probe.exitCode === 0) {
        tun2socksPath = candidate;
        break;
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

  // 3. Configure tun0 and launch the tun2socks daemon. Everything below needs CAP_NET_ADMIN,
  // which the unprivileged shell user does not have on the google_apis image — without root
  // the daemon cannot create tun0 and `ip route` answers "Operation not permitted".
  // The guest binary is hev-socks5-tunnel (see data/android-tun2socks.README.md): it takes a YAML
  // config file, not xjasonlyu-style `--netif-ipaddr` flags, and it creates tun0 itself.
  try {
    const rooted = await enableGuestRoot(adb);
    if (!rooted) {
      throw new AndroidNetworkError(
        'adb root refused: cannot create tun0 or route through the proxy without uid 0',
        'ERR_ANDROID_TUN2SOCKS_ROOT',
      );
    }
    const config = [
      'tunnel:',
      '  name: tun0',
      '  mtu: 1500',
      '  ipv4: 10.0.4.2',
      'socks5:',
      `  address: ${plan.socksHost}`,
      `  port: ${effectiveSocksPort}`,
      "  udp: 'tcp'",
      'misc:',
      '  task-stack-size: 24576',
      '  tcp-buffer-size: 4096',
      '  max-session-count: 1200',
      '',
    ].join('\n');
    const staged = await adb.writeFile('/data/local/tmp/nulltrace-tun2socks.yml', Buffer.from(config, 'utf8'));
    if (staged.exitCode !== 0) {
      throw new AndroidNetworkError(
        `cannot stage tun2socks config: ${staged.stderr.trim()}`,
        'ERR_ANDROID_TUN2SOCKS_CONFIG',
      );
    }
    // The whole command is ONE argv element: adb joins `shell` argv with spaces, so passing the
    // redirect as separate argv elements would re-tokenise it on the device (measured: the daemon
    // received zero arguments and answered its own usage line). Single quotes inside are safe —
    // the YAML values they wrap contain no quotes.
    const daemonCmd =
      `${tun2socksPath} /data/local/tmp/nulltrace-tun2socks.yml > /data/local/tmp/nulltrace-tun2socks.log 2>&1 < /dev/null &`;
    await adb.shell([daemonCmd]);
    // The daemon creates tun0 itself; confirm it exists before declaring success — a config
    // typo or a dead SOCKS bridge must fail the launch, not a silent no-network guest.
    let tunUp = false;
    for (let attempt = 0; attempt < 10 && !tunUp; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const probe = await adb.shellCode(['ip', 'link', 'show', 'dev', 'tun0']);
      tunUp = probe.exitCode === 0;
    }
    if (!tunUp) {
      const log = await adb.shellCode(['cat', '/data/local/tmp/nulltrace-tun2socks.log']);
      throw new AndroidNetworkError(
        `tun2socks did not raise tun0: ${(log.stdout.trim() || log.stderr.trim() || 'no log').slice(0, 300)}`,
        'ERR_ANDROID_TUN2SOCKS_START',
      );
    }

    // Point the default route at the tunnel. The daemon owns tun0 but does not touch the
    // routing tables, and netd keeps the wlan0 default — without this every packet still
    // leaves via direct NAT and the proxy sees nothing. The gateway host route comes first:
    // tun0 carries a /32, so `via 10.0.4.1` alone answers "Network is unreachable".
    // Tables: `wlan0` is the per-interface table netd actually consults (measured); `main`
    // is a backstop for images without it. `replace` (not `add`) — the SLIRP default is
    // already there. All best-effort per table: at least one must take effect.
    let routed = false;
    let lastRouteError = '';
    for (const table of ['wlan0', 'main']) {
      try {
        await adb.shell(['ip', 'route', 'add', '10.0.4.1/32', 'dev', 'tun0', 'table', table]);
      } catch {
        // Already present from a previous start.
      }
      try {
        await adb.shell(['ip', 'route', 'replace', 'default', 'via', '10.0.4.1', 'dev', 'tun0', 'table', table]);
        routed = true;
      } catch (err) {
        // Table missing on this image; the next one may exist. Kept for the error below —
        // swallowing it here is what once hid "Operation not permitted" behind a generic line.
        lastRouteError = err instanceof Error ? err.message : String(err);
      }
    }
    if (!routed) {
      throw new AndroidNetworkError(
        `could not point any routing table at tun0 (${lastRouteError.slice(0, 200) || 'no detail'}); ` +
          'guest would leak via direct NAT',
        'ERR_ANDROID_TUN2SOCKS_ROUTE',
      );
    }

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
            openHttpTunnel(socket, host, port, auth).then(
              () => resolve(socket),
              (err) => {
                socket.destroy();
                reject(err);
              },
            );
          } else {
            openSocksTunnel(socket, host, port, proxy.username ?? null, proxy.password ?? null).then(
              () => resolve(socket),
              (err) => {
                socket.destroy();
                reject(err);
              },
            );
          }
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
 * Reads from `socket` until `done(chunk)` is true or the deadline passes. The handshake bytes
 * are consumed from a one-shot buffer — callers must not lose bytes the proxy already sent.
 */
function readUntil(socket: net.Socket, done: (buf: Buffer) => boolean, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error(`upstream proxy handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onData = (chunk: Buffer): void => {
      acc = Buffer.concat([acc, chunk]);
      if (done(acc)) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(acc);
      }
    };
    socket.on('data', onData);
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      reject(err);
    });
  });
}

/**
 * Opens an HTTP CONNECT tunnel and waits for the `200` before the socket is spliced. Returning
 * the socket right after writing the request (the old behaviour) splices the proxy's own
 * `HTTP/1.1 200 …` header into the guest's TCP stream — every connection then starts with
 * garbage instead of the server's bytes.
 */
async function openHttpTunnel(
  socket: net.Socket,
  host: string,
  port: number,
  basicAuth: string | null,
): Promise<void> {
  const target = `${host}:${port}`;
  socket.write(
    [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      ...(basicAuth ? [`Proxy-Authorization: Basic ${basicAuth}`] : []),
      '',
      '',
    ].join('\r\n'),
  );
  const head = await readUntil(socket, (buf) => buf.includes('\r\n\r\n'), 15_000);
  const statusLine = head.toString('latin1').split('\r\n', 1)[0] ?? '';
  if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
    throw new Error(`upstream HTTP proxy refused CONNECT ${target}: ${statusLine.slice(0, 120) || '<empty>'}`);
  }
}

/**
 * Full upstream SOCKS5 handshake: greeting → method → optional RFC 1929 auth → CONNECT →
 * server reply. The old code wrote only the auth blob with no greeting and resolved without
 * reading anything, so no real SOCKS server could ever accept the connection.
 */
async function openSocksTunnel(
  socket: net.Socket,
  host: string,
  port: number,
  username: string | null,
  password: string | null,
): Promise<void> {
  const buf = (bytes: number[]): Buffer => Buffer.from(bytes);
  // Greeting: VER=5, NMETHODS=1, METHODS=[0x02 auth | 0x00 none].
  socket.write(buf(username ? [0x05, 0x01, 0x02] : [0x05, 0x01, 0x00]));
  const method = await readUntil(socket, (b) => b.length >= 2, 15_000);
  if (method[0] !== 0x05 || (method[1] !== 0x00 && method[1] !== 0x02)) {
    throw new Error(`upstream SOCKS5 proxy rejected the greeting (method ${method[1] ?? '?'})`);
  }
  if (method[1] === 0x02) {
    // RFC 1929 username/password sub-negotiation: version, ulen, uname, plen, passwd.
    const user = Buffer.from(username ?? '', 'utf8');
    const pass = Buffer.from(password ?? '', 'utf8');
    socket.write(Buffer.concat([buf([0x01, user.length]), user, buf([pass.length]), pass]));
    const authReply = await readUntil(socket, (b) => b.length >= 2, 15_000);
    if (authReply[0] !== 0x01 || authReply[1] !== 0x00) {
      throw new Error('upstream SOCKS5 proxy refused the username/password');
    }
  }
  // CONNECT request. Hostnames go as ATYP=0x03 so the proxy resolves them — resolving on the
  // host would leak DNS around the proxy.
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const name = Buffer.from(host, 'utf8');
  socket.write(
    Buffer.concat(
      /^\d+\.\d+\.\d+\.\d+$/.test(host)
        ? [buf([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split('.').map(Number)), portBuf]
        : [buf([0x05, 0x01, 0x00, 0x03, name.length]), name, portBuf],
    ),
  );
  const reply = await readUntil(socket, (b) => b.length >= 10, 15_000);
  if (reply[0] !== 0x05 || reply[1] !== 0x00) {
    throw new Error(`upstream SOCKS5 proxy refused CONNECT ${host}:${port} (rep ${reply[1] ?? '?'})`);
  }
}

/**
 * Tears down guest tun2socks routing and removes the tun0 interface.
 */
export async function teardownGuestNetwork(adb: AdbClient): Promise<void> {
  // Both the process name (the binary is pushed as `tun2socks`) and the config path, so a
  // renamed binary is still caught.
  for (const pattern of ['tun2socks', 'nulltrace-tun2socks.yml']) {
    try {
      await adb.shell(['pkill', '-f', pattern]);
    } catch {
      // best-effort cleanup
    }
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
