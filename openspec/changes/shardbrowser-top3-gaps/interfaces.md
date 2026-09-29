# Wave 1 interfaces — shardbrowser-top3-gaps

Sequential program: one child owns shared files at a time. Order: QUIC → fonts → TLS.

## Serialization map (critical)
- **`src/main/proxy/transportPolicy.ts`** — owner: `quic-webrtc-fail-closed` (only).
- **`src/main/proxy/udpRelay.ts`** — owner: `quic-webrtc-fail-closed` (only).
- **`src/main/launcher/chromium.ts`** (transport-flag wiring) — owner: `quic-webrtc-fail-closed` (only).
- **`src/main/proxy/stealthInjection.ts`** (font block only) — owner: `font-pinning-js-max` (only).
- **`src/main/fingerprints/fonts.ts`** — owner: `font-pinning-js-max` (only).
- **`src/main/proxy/stealthNoise.ts`** (voice pool, only if touched) — owner: `font-pinning-js-max` (only).
- **`scripts/probe-tls.ts`** — owner: `tls-ja4-limitation-record` (only).
- **`docs/VALIDATION.md`, `docs/STEALTH_PARITY.md`** — each child appends its own section; no rewrites of another child's section.

## Child boundaries
| Child | Owns | Must NOT touch |
|---|---|---|
| `quic-webrtc-fail-closed` | transportPolicy.ts, udpRelay.ts, chromium.ts flag wiring, probe/verify scripts for QUIC, its VALIDATION section, `tests/unit/proxy/` additions | stealthInjection font block, fonts.ts, probe-tls.ts |
| `font-pinning-js-max` | stealthInjection.ts font block, fonts.ts, stealthNoise.ts voice pool (if needed), `tests/unit/stealth/fontPinning.test.ts` additions, its STEALTH_PARITY note | transportPolicy/udpRelay/chromium flag matrix, probe-tls.ts |
| `tls-ja4-limitation-record` | probe-tls.ts gate, VALIDATION.md TLS section, STEALTH_PARITY.md TLS note | transport flags, font hooks |

## Existing contracts to reuse (do not re-implement)
- **Probe pipeline**: `probeTransportTarget`, `composeTransportFlags`, single-flight cache + HMAC keying (`transportPolicy.ts`); `probeUdpSupport`, relay sessions (`udpRelay.ts`).
- **Flag wiring**: `buildChromiumArgs(cfg, proxyServer, transportFlags)` + post-spawn `registerActiveProfile`/`TransportDropMonitor` (`chromium.ts`).
- **Deterministic derivation**: HMAC-SHA256 domain separation — `deriveMotorSeed` (`motion/seeds.ts`), `getSyntheticVoicePool` (`proxy/stealthNoise.ts`), `resolveFontConfig` (`fingerprints/fonts.ts`).
- **Font test harness**: vm-sandbox metric-table model (`tests/unit/stealth/fontPinning.test.ts:createFontSandbox`); extend, don't fork.
- **Stealth probe**: `scripts/probe-stealth-contexts.mjs` (main-vs-worker parity); `scripts/probe-tls.ts` (JA3/JA4 read-only probe).
- **CI gate**: `.github/workflows/stealth-parity.yml`.
- **Envelopes**: Local API `{code,msg,data}`; no new routes expected in this program.

## Global invariants
- Baseline suite green before and after every child; `tsc --noEmit` zero errors.
- Every engine-owned remainder ships with `TODO(engine-parity: …)` + doc note + probe.
- No new production dependencies; no Chromium fork artifacts.
