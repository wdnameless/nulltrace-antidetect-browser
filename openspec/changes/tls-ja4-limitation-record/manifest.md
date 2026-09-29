# Requirements Manifest: TLS / JA4 Limitation Record

## Verbatim user input
> "Окей анализируй https://github.com/ProxyShard/ShardBrowser/ и скажи чего у нас нет"
> "Пиши спеки и давай реализовывать"

## Wave 0 interview (this session)
> Scope: "По очереди: QUIC → шрифты → TLS"
> TLS path: "Зафиксировать как ограничение + verify-скрипт"
> Umbrella R03: "TLS/JA4 recorded as engine limitation + verify script gate, no MITM/fork"

Feasibility facts (scouted from repo, not user claims):
- "No CLI flags in Chromium/BoringSSL for ClientHello" — engine switch or MITM only (`scripts/probe-tls.ts`, `docs/VALIDATION.md`).
- BoringSSL ClientHello is hard-coded in the C++ binary; JavaScript injection and profile seed changes cannot alter cipher suites, TLS extensions, or JA4 fingerprint.
- Local MITM proxy approaches require installing untrusted root certificates, breaking end-to-end TLS security invariants and harming performance.
- Firefox stack (Camoufox via Juggler) uses NSS, yielding an authentic Firefox TLS/JA4 fingerprint without spoofing.

## Requirements

| ID | Requirement | Verbatim source | Status |
|---|---|---|---|
| R03 | TLS/JA4 recorded as engine limitation + verify script gate, no MITM/fork | «Зафиксировать как ограничение + verify-скрипт» | in-spec |
| R03.1 | Repeatable probe gate in `scripts/probe-tls.ts`: deterministic output comparing JA4 of kernels, verdict `identical` / `differ` / `skipped`, exit code, timeout guards, profile cleanup in `finally` | Umbrella R03 | in-spec |
| R03.2 | Hermetic unit test in `tests/unit/proxy/tlsLimitation.test.ts`: parsing verdict `probe-tls` (identical -> limitation confirmed), cleanup assertions, mocked fetch and puppeteer without live browser or network | Umbrella R03 | in-spec |
| R03.3 | Honest posture documentation in `docs/VALIDATION.md` dated 2026-09-29 with measured JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd` confirming TLS stack is not spoofable via JS or flags | Umbrella R03 | in-spec |
| R03.4 | Engine-parity remainder recorded in `docs/STEALTH_PARITY.md` dated 2026-09-29 documenting the BoringSSL boundary and multi-kernel reality without MITM or fork | Umbrella R03 | in-spec |
