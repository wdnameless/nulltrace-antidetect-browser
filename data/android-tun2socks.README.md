# Android `tun2socks` binary (operator-supplied, NOT in repo/image)

Stock `google_apis` system images (`src/main/android/packageManager.ts`)
ship **no** `tun2socks`. The guest needs it to force traffic through the
profile proxy (`src/main/android/network.ts:setupGuestNetwork`).

## Where to put it (first hit wins)

1. `TUN2SOCKS_BIN` env — full path to the binary
2. `<DATA_DIR>/bin/tun2socks[.exe]` (`DATA_DIR` from `src/main/config.ts`,
   portable `<portableBaseDir>/data`)
3. `tun2socks[.exe]` on `PATH`

Get a build from your vendor (e.g. heiher/natmap `tun2socks` releases —
match guest arch: `x86_64` normally, `arm64-v8a` on macOS-arm64 AVDs).

## Behavior

- Binary found (guest has it, or host one pushed via `adb push` to
  `/data/local/tmp/tun2socks`): full tunnel, status `network.proxied: true`.
- Binary on NEITHER side: profile still starts (no
  `ERR_ANDROID_NETWORK_NOT_ENFORCED`), host SOCKS bridge stays for
  diagnostics, status `network: { ok: true, proxied: false }` with an
  explicit "direct NAT, NOT proxied" warning in logs. Proxy-less profiles
  stay fail-closed (`blockGuestNetwork`).
