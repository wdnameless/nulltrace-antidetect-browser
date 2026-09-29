# Proposal: quic-webrtc-fail-closed

## Why
In multi-accounting anti-detect browsers, IP and transport leakage is catastrophic. Chromium lacks native SOCKS5 UDP relay binding for HTTP/3 (QUIC). When a proxied profile accesses websites supporting HTTP/3 without explicit safeguards, Chromium sends QUIC UDP packets directly over the host's default gateway, completely bypassing the SOCKS5 proxy and disclosing the operator's real egress IP. Furthermore, incomplete pre-launch probe stages can lead to false-positive pass verdicts or undefined flag composition.

The robust, fail-closed solution is to enforce `--disable-quic`, `--webrtc-ip-handling-policy=disable_non_proxied_udp`, and `--disable-webrtc` whenever proxy transport is constrained, deduplicate launcher flags to avoid silent CLI ignores, track and expose relay state in diagnostic routes, and document the disable-QUIC posture honestly.

## What Changes
1. **Probe Pipeline Hardening**:
   - `src/main/proxy/transportPolicy.ts`: close gaps in SOCKS5 probe stages (`udpAssociate`, `stunIpv4`, `stunIpv6`, `quic`). For STUN-v6 and QUIC probes over SOCKS5 relay, introduce explicit probing with fallback and `TODO(engine-parity)` annotations.
2. **Deterministic Flag Matrix**:
   - `composeTransportFlags`: Ensure deterministic mapping where `CONSTRAINED` strictly outputs `--proxy-server`, `--proxy-bypass-list=<-loopback>`, `--disable-quic`, `--webrtc-ip-handling-policy=disable_non_proxied_udp`, and `--disable-webrtc`. `SOCKS5_FULL_PASS` outputs relay-bound flags without `--disable-quic` or `--disable-webrtc`.
3. **Launcher Flag Deduplication**:
   - `src/main/launcher/chromium.ts`: Deduplicate `--disable-quic`, `--disable-webrtc`, `--webrtc-ip-handling-policy`, and proxy flags when composing CLI args.
4. **Relay State Diagnostics**:
   - `src/main/diagnostics/networkDiagnostics.ts`: Surface `relay_state` from `udpRelay.ts` in `collectDiagnostics` for `/api/v1/diagnostics/:profileId`.
5. **Validation Documentation**:
   - `docs/VALIDATION.md`: Append dated QUIC section stating the disable-QUIC posture honestly.

## Capabilities
- `quic-webrtc-fail-closed`: Deterministic fail-closed flag generation, hardened probe verification, and relay state visibility.

## Goals
- Guarantee zero host UDP / QUIC egress leaks for proxied profiles.
- Deduplicate Chromium launch flags across transportPolicy and launcher defaults.
- Surface active profile relay state in diagnostics endpoint.
- Provide unit tests verifying fail-closed flags and probe stage handling.

## Non-Goals
- Adding TUN / Wintun virtual network adapters or MASQUE proxy bridges (out of scope per R01: "no new relay").
- Modifying font injection or TLS probes (assigned to subsequent child changes).
- Modifying Chromium C++ source code.
