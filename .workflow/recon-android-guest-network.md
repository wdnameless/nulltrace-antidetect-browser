# Recon — Android guest network via profile proxy + bugfix round

T1 lane: user chose "only fix the proxy path" (fail-closed stays for
proxy-less profiles) and "drive it myself, fix what I find" for bugs.

## Touched files

- `src/main/android/network.ts`:
  - `startUpstreamSocksBridge` connector now completes the upstream
    handshake before the socket is spliced: `openHttpTunnel` (CONNECT +
    wait for `200`) and `openSocksTunnel` (greeting → method →
    RFC 1929 → CONNECT → reply) via `readUntil`. The old code resolved
    immediately after writing, splicing the proxy's own `HTTP/1.1 200`
    header into the guest's TCP stream (every connection started with
    garbage), and the SOCKS leg wrote an auth blob with no greeting.
  - Guest daemon is hev-socks5-tunnel via YAML config
    (`/data/local/tmp/nulltrace-tun2socks.yml`), not xjasonlyu CLI flags;
    it creates tun0 itself; tun0 presence is verified before success.
  - Default route is pointed at the tunnel (`wlan0` + `main` tables,
    gateway host route first, `replace` not `add`); failure to route
    fails the launch instead of leaking via direct NAT.
  - `enableGuestRoot` result is now required (new
    `ERR_ANDROID_TUN2SOCKS_ROOT`): without uid 0 the daemon cannot create
    tun0 and `ip route` is refused.
  - `resolveTun2socksOnHost` accepts extensionless `tun2socks` on Windows
    (the binary runs on the guest; it is an ELF, not an `.exe`).
  - Daemon spawn is a single argv element (adb joins `shell` argv; splitting
    the redirect re-tokenised it and the daemon got zero arguments).
  - `teardownGuestNetwork` also kills by config-path pattern.
  - New `AndroidNetworkError` for coded network failures.
- `tests/support/fakeAdb.ts`: `writeFile` double + `onWriteFile` hook.
- `tests/unit/androidFingerprint.test.ts`: fixtures updated for the root
  gate; +2 regression tests (root refused → fail; no table accepts the
  route → fail closed).

## Operator environment (not in repo)

- `D:/progg/NULLTRACE/bin/tun2socks` (+ `.exe` alias): hev-socks5-tunnel
  2.19.1 `android-x86_64` (247 288 bytes, ELF verified).
- Profile `p_31c8acbb-…` bound to working proxy
  `x_382cd2b6-…` (lime.proxyhub.team:8080; the German 88.99.90.19:9999 and
  two lime sids are dead/TIMEOUT).
- `.tmp/netprobe/classes.dex`: smali-built `dalvikvm` HTTPS probe
  (`IP=`/`FAIL`), since the guest has no curl/wget/busybox. Built with
  smali 2.5.2 + Temurin JRE 11 under `.tmp/` (gitignored).

## Acceptance check

- Full launch from scratch with proxy bound: `state=running`,
  `proxied=true`, `tun2socks active on 10.0.2.2:<port>`, tun0 UP, daemon
  RUNNING, guest HTTPS IP = `80.73.14.167` (proxy exit) vs `77.70.83.218
  direct — measured via NetProbe through the live tunnel.
- Host-side SOCKS bridge verified standalone: SOCKS5 handshake → CONNECT
  api.ipify.org:443 through lime → upstream bytes flow.
- TikTok 47.4.2 still launches on the networked guest (Terms/“Agree and
  continue” popup rendered, screencap `.tmp/net-tiktok.png`).
- `npx tsc -p tsconfig.main.json --noEmit` clean; 60/60 Android unit tests
  green (58 existing + 2 new regression tests).

## Known limits (not fixed this round)

- The SOCKS bridge dies with the launching process: it is owned by the
  `launchAndroidProfile` caller, so a CLI-launched emulator loses its
  bridge when the CLI exits (tunnel stays up, guest gets Connection
  reset). In the app the main process owns it for the session — correct
  by design, but CLI-driven automation must keep its launcher alive.
- No proxy health preflight at bind time: two of five saved proxies are
  dead; binding one fails the launch at network setup (fail-closed, loud).
- Guest has no curl/wget; automation IP checks should reuse the NetProbe
  dex approach or go through an app-level check.
