# Tasks — tls-ja4-limitation-record

## 1. Specifications & Planning
- [x] 1.1 Create child change directory `openspec/changes/tls-ja4-limitation-record/` (`.openspec.yaml`, `manifest.md`, `proposal.md`, `specs/tls-ja4-limitation-record/spec.md`, `interfaces.md`, `tasks.md`).

## 2. Repeatable Probe Gate & Deterministic Verdict
- [x] 2.1 Update `scripts/probe-tls.ts`: add timeout guards on fetch and page navigation, ensure profile stop/deletion in `finally`, deterministic output comparing JA4 signatures, and export evaluation/parsing/formatting functions.

## 3. Documentation & Unit Tests
- [x] 3.1 Create hermetic unit tests in `tests/unit/proxy/tlsLimitation.test.ts` covering verdict evaluation, output parsing, timeout handling, and lifecycle cleanup without live browser or network dependencies.
- [x] 3.2 Update `docs/VALIDATION.md` with TLS / JA4 fingerprint section dated 2026-09-29 and measured JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd`.
- [x] 3.3 Update `docs/STEALTH_PARITY.md` with TLS note dated 2026-09-29 documenting engine-parity remainder and dual-kernel strategy.
- [x] 3.4 Verify clean `npx tsc -p tsconfig.main.json --noEmit` and green `npx vitest run tests/unit/proxy/`.
