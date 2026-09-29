# Requirements Manifest: ShardBrowser top-3 gaps (QUIC → fonts → TLS)

## Verbatim user input
> "Окей анализируй https://github.com/ProxyShard/ShardBrowser/ и скажи чего у нас нет"
> "Пиши спеки и давай реализовывать"

## Wave 0 interview (this session)
> Scope: "По очереди: QUIC → шрифты → TLS"
> TLS path: "Зафиксировать как ограничение + verify-скрипт"
> QUIC path: "Укрепить disable-QUIC + пробы"
> Fonts path: "JS-максимум без C++"

Feasibility facts (scouted from repo, not user claims):
- "No CLI flags in Chromium/BoringSSL" for ClientHello — engine switch or MITM only (`scripts/probe-tls.ts`, `docs/VALIDATION.md`).
- "UDP ASSOCIATE implemented; missing browser UDP binding (Chromium lacks SOCKS5-QUIC) or TUN/MASQUE bridge" (`src/main/proxy/udpRelay.ts`, `src/main/proxy/transportPolicy.ts`).
- "patches/ does not exist; no source build; CI gate in stealth-parity.yml verifies Main vs Worker parity" (`docs/STEALTH_PARITY.md`).
- "Full font hiding impossible at layout engine level without C++ patches" (DirectWrite/Blink fallback).

## Requirements

| ID | Requirement | Verbatim source | Status |
|---|---|---|---|
| R01 | Harden QUIC/WebRTC fail-closed posture: probes + flags + verify evidence, no new relay | «Укрепить disable-QUIC + пробы» | in-spec |
| R02 | Font pinning JS-maximum without C++: close measurable surfaces, record engine-parity remainder | «JS-максимум без C++» | in-spec |
| R03 | TLS/JA4 recorded as engine limitation + verify script gate, no MITM/fork | «Зафиксировать как ограничение + verify-скрипт» | in-spec |
| R04 | Sequential wave order QUIC → fonts → TLS | «По очереди: QUIC → шрифты → TLS» | in-spec |
| R05 | Engine C++ patch-set NOT in scope (prior decision, reconfirmed by JS-maximum choice) | «JS-максимум без C++» | deferred |
| R06 | p0f, Widevine L1, x-client-data stay deferred (prior program decision, unchanged) | competitive-parity-2026-q3 manifest R12 | deferred |
