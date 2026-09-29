# Proposal: tls-ja4-limitation-record

## Why
TLS fingerprinting (JA3/JA4) inspects the initial `ClientHello` packet (TLS version, ciphers, extensions, elliptic curves, point formats, and ALPN). In Chromium, `ClientHello` is assembled by the statically linked BoringSSL C++ library long before any web page or content script JavaScript executes. There are no command-line flags or DevTools Protocol APIs in Chromium to customize these parameters. The only mechanisms to artificially mutate TLS fingerprints are running a local MITM proxy (which requires installing custom root CA certificates and decrypting user traffic) or maintaining a custom C++ fork of BoringSSL/Chromium. Both approaches contradict the security, performance, and maintainability requirements of the project.

This change documents the TLS fingerprint posture honestly as an engine-level limitation, establishes `scripts/probe-tls.ts` as a deterministic verification gate with proper timeouts and cleanup, and verifies verdict evaluation hermetically via automated unit tests.

## What Changes
1. **Repeatable TLS Probe Gate (`scripts/probe-tls.ts`)**:
   - Harden `scripts/probe-tls.ts` with timeout guards (`AbortSignal.timeout` on HTTP requests, timeout on page navigation).
   - Ensure guaranteed cleanup of browser instances and profile workspaces in `finally` blocks.
   - Implement deterministic output comparing JA4 signatures of both kernels (`fingerprint-chromium` and `Camoufox`).
   - Export evaluation (`evaluateTlsVerdict`) and parsing (`parseTlsVerdict`) helpers returning structured verdicts (`identical`, `differ`, `skipped`, `failed`), `limitationConfirmed` flag, and process exit code.
2. **Hermetic Unit Test (`tests/unit/proxy/tlsLimitation.test.ts`)**:
   - Verify parsing of probe output (`identical -> limitation confirmed`, `differ`, `skipped`).
   - Verify evaluation logic against baseline JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd`.
   - Test probe flow hermetically with mocked `fetch` and `puppeteer` interfaces (verifying timeout guards, JA4 extraction, and profile cleanup in `finally`).
3. **Honest Documentation (`docs/VALIDATION.md`, `docs/STEALTH_PARITY.md`)**:
   - Add dated `2026-09-29` section in `docs/VALIDATION.md` detailing measured JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd`, BoringSSL engine limitation, and rejection of MITM termination.
   - Add dated `2026-09-29` note in `docs/STEALTH_PARITY.md` documenting engine-parity remainder and dual-kernel strategy (Chromium for Blink, Camoufox for authentic Firefox TLS).

## Capabilities
- `tls-ja4-limitation-record`: Deterministic TLS probe gate, hermetic unit tests, and documented BoringSSL engine limitation.

## Goals
- Provide a reproducible, non-flaky probe script with deterministic output and exit codes.
- Guarantee profile workspace cleanup regardless of probe success or network failure.
- Record the measured Chromium JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd` in official documentation.
- Maintain test coverage for verdict evaluation and probe lifecycle without requiring a live browser or internet connection.

## Non-Goals
- No local MITM proxy or TLS-terminating reverse proxy.
- No C++ source patches or BoringSSL fork.
- No changes to `transportPolicy.ts`, `udpRelay.ts`, `chromium.ts` flag matrix, `stealthInjection.ts` font block, or `fonts.ts`.
