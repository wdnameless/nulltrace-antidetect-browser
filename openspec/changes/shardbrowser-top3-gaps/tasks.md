# Tasks — shardbrowser-top3-gaps (umbrella)

Umbrella only: no production code lands here. Each child is its own change with
its own tasks; this file tracks umbrella-level gates.

## 0. Umbrella artifacts (this change)

- [x] 0.1 Manifest with R## rows + verbatim user quotes (`manifest.md`).
- [x] 0.2 Proposal with Why/What/Capabilities/Goals/Non-Goals (`proposal.md`).
- [x] 0.3 Spec with sequential/test-gate/honest-recording contracts (`specs/`).
- [x] 0.4 Interfaces with serialization map + child boundaries (`interfaces.md`).
- [x] 0.5 Oracle blind verdict on the artifacts (ACCEPT, recorded in workflow lane).

## 1. Child 1 — quic-webrtc-fail-closed (DONE)

- [x] 1.1 Child change created with manifest/proposal/spec/tasks/interfaces.
- [x] 1.2 Probe coverage hardened (UDP_ASSOCIATE/STUN-v4-v6/QUIC stages, cache, single-flight).
- [x] 1.3 Flag matrix deterministic (`composeTransportFlags` + `chromium.ts` wiring).
- [x] 1.4 Relay-state tracking + verify evidence + VALIDATION section.
- [x] 1.5 Suite green + typecheck clean (`tests/unit/proxy/` 45 passed, tsc clean).

## 2. Child 2 — font-pinning-js-max (DONE)

- [x] 2.1 Child change created with manifest/proposal/spec/tasks/interfaces.
- [x] 2.2 Every measurable font surface closed in JS layer (check/measure/offset/queryLocalFonts).
- [x] 2.3 Voice-pool locale coherence where font-adjacent.
- [x] 2.4 Engine remainder recorded (`TODO(engine-parity: fonts)` + doc + probe).
- [x] 2.5 Suite green + typecheck clean (`fontPinning.test.ts` 12 → 15 passed, tsc clean).

## 3. Child 3 — tls-ja4-limitation-record (DONE)

- [x] 3.1 Child change created with manifest/proposal/spec/tasks/interfaces.
- [x] 3.2 `probe-tls.ts` as repeatable gate (both kernels, deterministic output).
- [x] 3.3 VALIDATION.md + STEALTH_PARITY.md TLS notes with measured JA4.
- [x] 3.4 Suite green + typecheck clean → merge → umbrella archived.
