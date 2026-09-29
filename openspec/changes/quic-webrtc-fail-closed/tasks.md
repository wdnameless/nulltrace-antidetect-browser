# Tasks — quic-webrtc-fail-closed

## 1. Specifications & Planning
- [x] 1.1 Create child change directory and OpenSpec metadata (`.openspec.yaml`, `manifest.md`, `proposal.md`, `specs/quic-webrtc-fail-closed/spec.md`, `interfaces.md`, `tasks.md`).

## 2. Probe Pipeline & Flag Matrix Hardening
- [x] 2.1 Close gaps in probe stages in `src/main/proxy/transportPolicy.ts` (UDP_ASSOCIATE, STUN-v4, STUN-v6, QUIC) with fail-closed semantics and explicit `TODO(engine-parity)` annotations.
- [x] 2.2 Enforce deterministic flag matrix in `composeTransportFlags` (CONSTRAINED → `--disable-quic` + `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--disable-webrtc`; FULL_PASS → relay-bound).

## 3. Launcher Wiring & Diagnostics Visibility
- [x] 3.1 Deduplicate transport and WebRTC flags in `src/main/launcher/chromium.ts` (`buildChromiumArgs`).
- [x] 3.2 Reflect and expose `relay_state` from `src/main/proxy/udpRelay.ts` in `src/main/diagnostics/networkDiagnostics.ts` for `/api/v1/diagnostics/:profileId`.

## 4. Documentation & Verification
- [x] 4.1 Append dated QUIC section to `docs/VALIDATION.md` detailing the honest disable-QUIC posture.
- [x] 4.2 Add unit tests in `tests/unit/proxy/quicFailClosed.test.ts` covering flag composition, deduplication, probe stages, and relay state.
- [x] 4.3 Verify typecheck (`npx tsc -p tsconfig.main.json --noEmit`) and proxy test suite (`npx vitest run tests/unit/proxy/`).
