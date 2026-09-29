## Why

ShardBrowser gap analysis ranks three network/stealth holes above the rest: QUIC/WebRTC
leak posture, font-enumeration pinning, and TLS/JA4. Feasibility survey confirms none of
the three can be closed at the engine level without a Chromium fork (`patches/` does not
exist, no source build): Chromium ignores SOCKS5 for QUIC, BoringSSL exposes no
ClientHello flags, and DirectWrite/Blink font fallback is unreachable from JS. Wave 0
interview scoped the work accordingly: harden (QUIC), JS-maximum (fonts), record (TLS).

This umbrella contains no production code. It groups three sequential children.

## What Changes

- **Child 1 — `quic-webrtc-fail-closed` (first):** harden the existing disable-QUIC
  posture: probe coverage (UDP_ASSOCIATE/STUN/QUIC stages in `transportPolicy.ts`),
  deterministic flag matrix in `composeTransportFlags`/`chromium.ts`
  (`--disable-quic`, `--webrtc-ip-handling-policy`), relay-state tracking in
  `udpRelay.ts`, verify evidence (`verify-*`/probe scripts), docs updated to state
  the posture honestly. No TUN/MASQUE bridge, no browser-UDP binding.
- **Child 2 — `font-pinning-js-max` (second):** close every measurable font surface in
  the JS layer (`stealthInjection.ts` font block + `fingerprints/fonts.ts` resolver):
  `document.fonts.check`/`FontFaceSet.check`, `measureText`, element probes
  (`offsetWidth`/`offsetHeight`), `queryLocalFonts` neutralisation, per-OS voice-pool
  coherence where it touches font-adjacent locale claims. Remainder recorded as
  explicit `TODO(engine-parity: fonts)` with a dated evidence note. No C++ patches.
- **Child 3 — `tls-ja4-limitation-record` (third):** record TLS/JA4 as an engine
  limitation: `scripts/probe-tls.ts` as a repeatable verify gate, `VALIDATION.md`
  stating the measured JA4, no MITM terminator, no engine switch, no fork.

Every child carries its own tests (repo Vitest conventions; baseline must stay green).

## Capabilities

### New Capabilities
- `quic-webrtc-fail-closed-evidence`: measured, fail-closed QUIC/WebRTC posture with probe + flag + verify coverage.
- `font-pinning-js-max`: JS-layer-maximum font enumeration cloaking with recorded engine remainder.
- `tls-ja4-limitation-record`: documented TLS/JA4 limitation with a repeatable probe gate.

### Modified Capabilities
None (children own their deltas; umbrella groups only).

## Impact

- `src/main/proxy/` (transportPolicy, udpRelay, stealthInjection), `src/main/fingerprints/fonts.ts`,
  `src/main/launcher/chromium.ts`, `scripts/probe-tls.ts` + verify scripts, `docs/VALIDATION.md`,
  `docs/STEALTH_PARITY.md`, `tests/unit/stealth/`, `tests/unit/proxy/`.
- Tests: per-child additions under `tests/unit/`; no child merges red.

### Goals

- Say honestly what the posture is on each of the three surfaces, with measured evidence.
- Close everything closable without a Chromium fork.
- Record the engine-owned remainder with markers, not silence.

### Non-Goals

- No Chromium fork, no `patches/` tree, no C++ build farm.
- No MITM TLS terminator, no proxy-side ClientHello normalization.
- No TUN interface, no MASQUE bridge, no browser-UDP-to-relay binding.
- No p0f, Widevine L1, or `x-client-data` (separately deferred).
