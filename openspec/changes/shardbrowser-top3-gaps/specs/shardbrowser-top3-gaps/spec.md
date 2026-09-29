# shardbrowser-top3-gaps Specification

## Purpose

Umbrella contracts for the sequential QUIC → fonts → TLS program: bounded children,
sequential execution, test-gated merges, and honest-limitation recording.

## Requirements

### Requirement: Sequential child delivery
The program SHALL implement R01–R03 through three sequential child OpenSpec changes
(`quic-webrtc-fail-closed`, `font-pinning-js-max`, `tls-ja4-limitation-record`); the
umbrella MUST NOT authorize production code itself.

#### Scenario: Implementation attempted under the umbrella directly
- **GIVEN** approved umbrella artifacts
- **WHEN** implementation is requested for a capability with no child change directory
- **THEN** implementation MUST be blocked and the missing child MUST be named

### Requirement: Wave order
Children SHALL land in the order QUIC → fonts → TLS; a later child MUST NOT merge
before the earlier child's suite is green on main.

#### Scenario: Fonts child offered before QUIC lands
- **GIVEN** `quic-webrtc-fail-closed` is unmerged
- **WHEN** `font-pinning-js-max` requests merge
- **THEN** the merge MUST wait for the QUIC child on main

### Requirement: Test-gated merges
Every child merge MUST pass the full deterministic suite plus the child's additions and
`tsc --noEmit` with zero errors; a red suite MUST block the merge.

#### Scenario: Child suite red
- **GIVEN** a child branch whose added tests fail
- **WHEN** merge is requested
- **THEN** the merge MUST be blocked until the suite is green

### Requirement: Honest-limitation recording
Engine-owned remainders that cannot close without a Chromium fork MUST be recorded in
code (`TODO(engine-parity: …)`), docs (`VALIDATION.md`/`STEALTH_PARITY.md`), and a
repeatable probe/verify script — never silently dropped.

#### Scenario: Remainder without a marker
- **GIVEN** a surface the child cannot close (e.g. DirectWrite fallback, BoringSSL ClientHello)
- **WHEN** the child's diff is reviewed
- **THEN** review MUST find a code marker, a doc note, and a probe that reproduces the gap
