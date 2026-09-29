# Spec: quic-webrtc-fail-closed

## Purpose

Enforce a deterministic fail-closed QUIC and WebRTC transport policy for all proxied browser profiles. Prevent real IP leakage through host UDP bypass by ensuring complete probe coverage, deterministic Chromium flag composition, CLI switch deduplication, and runtime relay state diagnostics.

## Requirements

### Requirement R01.1: Probe Coverage Hardening

The probe engine SHALL verify SOCKS5 UDP relay capabilities across explicit stages: `tcpConnect`, `auth`, `proxyDns`, `udpAssociate`, `stunIpv4`, `stunIpv6`, and `quic`. If dual-stack IPv6 egress or QUIC response fails, the probe SHALL fail closed to `CONSTRAINED` and record explicit `TODO(engine-parity)` annotations.

#### Scenario: STUN IPv6 or QUIC probe failure over SOCKS5 relay

- **GIVEN** a SOCKS5 proxy that supports UDP_ASSOCIATE and STUN IPv4 but fails IPv6 or QUIC echo
- **WHEN** `probeTransportTarget` executes
- **THEN** `stages.stunIpv6` and `stages.quic` reflect actual probe results
- **AND** the overall verdict status transitions to `CONSTRAINED`

### Requirement R01.2: Deterministic Flag Matrix

The function `composeTransportFlags` SHALL map `CONSTRAINED` to `--disable-quic`, `--webrtc-ip-handling-policy=disable_non_proxied_udp`, and `--disable-webrtc`. For `SOCKS5_FULL_PASS`, it SHALL emit relay-bound switches (`--webrtc-ip-handling-policy=disable_non_proxied_udp`) without `--disable-quic` or `--disable-webrtc`.

#### Scenario: CONSTRAINED proxy flag composition

- **GIVEN** a probe result with status `CONSTRAINED` and proxy server `http://1.2.3.4:8080`
- **WHEN** `composeTransportFlags` is evaluated
- **THEN** returned flags contain `--proxy-server=http://1.2.3.4:8080`, `--proxy-bypass-list=<-loopback>`, `--disable-quic`, `--webrtc-ip-handling-policy=disable_non_proxied_udp`, and `--disable-webrtc`

#### Scenario: SOCKS5_FULL_PASS proxy flag composition

- **GIVEN** a probe result with status `SOCKS5_FULL_PASS` and proxy server `socks5://1.2.3.4:1080`
- **WHEN** `composeTransportFlags` is evaluated
- **THEN** returned flags contain `--proxy-server=socks5://1.2.3.4:1080`, `--proxy-bypass-list=<-loopback>`, and `--webrtc-ip-handling-policy=disable_non_proxied_udp`
- **AND** returned flags DO NOT contain `--disable-quic` or `--disable-webrtc`

### Requirement R01.3: Chromium Argument Wiring Deduplication

The launcher argument composer `buildChromiumArgs` SHALL NOT emit duplicate transport or WebRTC flags (`--disable-quic`, `--disable-webrtc`, `--webrtc-ip-handling-policy`, `--proxy-server`, `--proxy-bypass-list`).

#### Scenario: Transport flags and profile WebRTC policy overlap

- **GIVEN** `transportFlags` containing `--webrtc-ip-handling-policy=disable_non_proxied_udp` and `--disable-quic`
- **WHEN** `buildChromiumArgs` builds arguments with `webrtc_policy: 'disable_non_proxied_udp'`
- **THEN** `--webrtc-ip-handling-policy` appears exactly once in the launcher arguments
- **AND** `--disable-quic` appears exactly once in the launcher arguments

### Requirement R01.4: Relay State Visibility in Diagnostics

The diagnostics collector SHALL surface the current profile's UDP relay state (`relay`, `quic-disabled`, or `unavailable`) in `DiagnosticsReport` returned by `GET /api/v1/diagnostics/:profileId`.

#### Scenario: Querying diagnostics for a running profile

- **GIVEN** a running profile registered with relay state `quic-disabled`
- **WHEN** `collectDiagnostics` is invoked for that profile
- **THEN** the returned report contains `relay_state: 'quic-disabled'`

### Requirement R01.5: Honest Posture Documentation

The repository documentation `docs/VALIDATION.md` SHALL contain a dated section explaining that without an OS-level TUN or MASQUE bridge, the secure posture is disable-QUIC.

#### Scenario: Documentation audit

- **GIVEN** `docs/VALIDATION.md`
- **WHEN** inspected for QUIC posture
- **THEN** it contains a section dated 2026-09-29 documenting the disable-QUIC posture honestly
