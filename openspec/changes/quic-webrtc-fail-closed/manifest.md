# Requirements Manifest: QUIC / WebRTC Fail-Closed Hardening

## Verbatim user input
> "Окей анализируй https://github.com/ProxyShard/ShardBrowser/ и скажи чего у нас нет"
> "Пиши спеки и давай реализовывать"

## Wave 0 interview (this session)
> Scope: "По очереди: QUIC → шрифты → TLS"
> QUIC path: "Укрепить disable-QUIC + пробы"
> Umbrella R01: "Harden QUIC/WebRTC fail-closed posture: probes + flags + verify evidence, no new relay"

Feasibility facts (scouted from repo, not user claims):
- "No CLI flags in Chromium/BoringSSL for ClientHello" — engine switch or MITM only (`scripts/probe-tls.ts`, `docs/VALIDATION.md`).
- "UDP ASSOCIATE implemented; missing browser UDP binding (Chromium lacks SOCKS5-QUIC) or TUN/MASQUE bridge" (`src/main/proxy/udpRelay.ts`, `src/main/proxy/transportPolicy.ts`).
- Chromium routes QUIC UDP traffic directly to target host unless `--disable-quic` is explicitly passed on CLI.
- Commercial SOCKS5 proxies frequently lack dual-stack IPv6 UDP forwarding; unhandled STUN-v6 probes risk false-positive pass or hanging connections.

## Requirements

| ID | Requirement | Verbatim source | Status |
|---|---|---|---|
| R01 | Harden QUIC/WebRTC fail-closed posture: probes + flags + verify evidence, no new relay | «Укрепить disable-QUIC + пробы» | in-spec |
| R01.1 | Probe coverage hardened: UDP_ASSOCIATE, STUN-v4, STUN-v6 with explicit `TODO(engine-parity)` annotation, and QUIC probe stage failing closed | Umbrella R01 | in-spec |
| R01.2 | Deterministic flag matrix: `composeTransportFlags` maps CONSTRAINED to `--disable-quic` + `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--disable-webrtc`; SOCKS5_FULL_PASS to relay-bound flags | Umbrella R01 | in-spec |
| R01.3 | Chromium argument wiring deduplication: `buildChromiumArgs` prevents duplicate transport and WebRTC switches | Umbrella R01 | in-spec |
| R01.4 | Relay state visibility: `udpRelay.ts` tracks per-profile relay state and exposes it in diagnostics route (`/api/v1/diagnostics/:profileId`) | Umbrella R01 | in-spec |
| R01.5 | Honest posture documentation: `docs/VALIDATION.md` dated 2026-09-29 documenting disable-QUIC posture | Umbrella R01 | in-spec |
