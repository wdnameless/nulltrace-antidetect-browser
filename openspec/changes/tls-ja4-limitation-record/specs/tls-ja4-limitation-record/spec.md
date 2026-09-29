# Spec: tls-ja4-limitation-record

## Purpose
Record TLS / JA4 fingerprinting posture as a known BoringSSL engine limitation, provide a repeatable and hermetically tested probe gate in `scripts/probe-tls.ts`, and document the measured Chromium JA4 signature honestly in `docs/VALIDATION.md` and `docs/STEALTH_PARITY.md` without MITM termination or engine forks.

## Requirements

### Requirement R03.1: Deterministic TLS Probe Gate
The probe script `scripts/probe-tls.ts` SHALL execute against the local application service to measure JA4 signatures of Chromium and Firefox (Camoufox) profiles via `tls.peet.ws`. The probe SHALL:
1. Impose timeout guards on all HTTP and browser navigation requests to avoid hanging.
2. Clean up browser instances and profile workspaces unconditionally in `finally` blocks.
3. Output a deterministic verdict structure comparing measured JA4 fingerprints:
   - `identical`: both profiles/kernels share an identical JA4 fingerprint, confirming that the TLS stack cannot be differentiated or spoofed by JavaScript or profile seeds (`limitationConfirmed: true`).
   - `differ`: profiles/kernels exhibit distinct native TLS stacks (`limitationConfirmed: false` or multi-engine divergence).
   - `skipped`: secondary kernel probe skipped or unavailable; evaluated against baseline `KNOWN_CHROMIUM_JA4`.
   - `failed`: probe unable to obtain valid TLS response.
4. Exit with code `0` on successful evaluation (`identical`, `differ`, or `skipped` with valid baseline) and code `1` on probe failure.

#### Scenario: Running probe-tls with identical JA4 signatures
- **GIVEN** Chromium and secondary probes returning identical JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd`
- **WHEN** `evaluateTlsVerdict` is called
- **THEN** verdict is `'identical'`
- **AND** `limitationConfirmed` is `true`
- **AND** `exitCode` is `0`

#### Scenario: Running probe-tls with differing JA4 signatures
- **GIVEN** Chromium returning `t13d1516h2_8daaf6152771_d8a2da3f94cd` and Firefox returning `t13d1516h2_fa8a5a40b07b_...`
- **WHEN** `evaluateTlsVerdict` is called
- **THEN** verdict is `'differ'`
- **AND** `exitCode` is `0`

#### Scenario: Cleanup on probe error or navigation timeout
- **GIVEN** a browser profile created by the probe
- **WHEN** page navigation throws a timeout error or network disconnect occurs
- **THEN** the profile is stopped via `POST /api/v1/browser/stop`
- **AND** the profile workspace is deleted via `POST /api/v1/browser-profile/delete`

### Requirement R03.2: Hermetic Unit Testing
`tests/unit/proxy/tlsLimitation.test.ts` SHALL test probe verdict evaluation, output parsing, and probe lifecycle hermetically using mocked fetch and puppeteer APIs without invoking real browser binaries or remote internet endpoints.

#### Scenario: Hermetic test verifies identical verdict parsing
- **GIVEN** console output containing `[TLS_PROBE] Verdict: identical -> limitation confirmed`
- **WHEN** parsed by `parseTlsVerdict`
- **THEN** `verdict` is `'identical'`
- **AND** `limitationConfirmed` is `true`
- **AND** `exitCode` is `0`

#### Scenario: Hermetic test verifies probe lifecycle with mocked APIs
- **GIVEN** mocked HTTP service and mocked Puppeteer connect
- **WHEN** `probeChromium` is executed
- **THEN** profile creation, start, page navigation, data evaluation, stop, and deletion are invoked in proper order
- **AND** failure during evaluation still executes profile deletion

### Requirement R03.3: Honest Validation Documentation
`docs/VALIDATION.md` SHALL contain a dedicated TLS section dated `2026-09-29` stating:
1. Measured Chromium JA4 fingerprint: `t13d1516h2_8daaf6152771_d8a2da3f94cd`.
2. Clear explanation that the TLS stack cannot be spoofed via JavaScript or CLI flags due to BoringSSL C++ static compilation in Chromium.
3. Architectural rejection of local MITM proxies (TLS termination / ClientHello rewrite) to preserve cryptographic integrity and security invariants.

### Requirement R03.4: Engine-Parity Remainder Documentation
`docs/STEALTH_PARITY.md` SHALL contain a dated `2026-09-29` section recording TLS fingerprinting as an engine-owned boundary (`TODO(engine-parity: tls)`):
1. Inability of JS layer to mutate BoringSSL ClientHello.
2. Dual-kernel capability: Camoufox provides authentic Firefox TLS signatures for workflows requiring non-Chromium JA4.
