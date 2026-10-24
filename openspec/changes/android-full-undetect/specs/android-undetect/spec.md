## Purpose

The Android guest passes app-level emulator checks on the host-rewritable
surface, carries a mixed per-profile identity (rotatable, geo-consistent), and
stays online without a proxy — free, stable, and launch-cost neutral after a
one-time per-AVD overlay preparation. Play Integrity / SafetyNet attestation is
explicitly OUT (needs certified ARM hardware).

## ADDED Requirements

### Requirement: Deepened spoof

The system MUST spoof Build identity, qemu props, goldfish artefacts, serials,
and su presence per profile, verifying every write by read-back and reporting
unverified steps honestly. Sensor HAL names, CPU/ABI emulation tells, virtio
evdev multiplicity, and the WebGL renderer string CANNOT be rewritten from the
host injector (kernel/firmware surface, no Magisk per Wave 0) — the status MUST
report them as known-detectable instead of claiming a spoof.

#### Scenario: App checks pass

- **GIVEN** a booted Android profile with seed S
- **WHEN** an app reads Build.MODEL/DEVICE/FINGERPRINT, `ro.kernel.qemu`,
  `/dev/goldfish_*`, and `su` presence
- **THEN** it MUST see the mixed preset values, empty qemu props, no goldfish
  files, and no `su`

### Requirement: Cross-preset mixing

The system MUST derive model/screen/GPU/build from different presets
deterministically from seed, with per-field pins overriding the mix.

#### Scenario: Mixed identity boots

- **GIVEN** seed S and no pins
- **WHEN** the emulator starts twice
- **THEN** both boots MUST serve identical mixed values from ≥2 presets

### Requirement: Rotation on demand

The system MUST regenerate android_id/imei/serial/mac on operator request,
live if running, persisted for next boot otherwise.

#### Scenario: Rotate changes ids

- **GIVEN** a profile with android_id A
- **WHEN** the operator rotates identity
- **THEN** the guest MUST serve android_id B ≠ A without a reboot

### Requirement: Geo-consistency

The system MUST link proxy country to locale + MCC/MNC + operator + timezone.

#### Scenario: German proxy

- **GIVEN** a proxy with country_code DE
- **WHEN** the emulator starts
- **THEN** the guest MUST serve locale de-DE, MCC/MNC 262xx, timezone
  Europe/Berlin

### Requirement: Direct NAT for proxy-less

The system MUST keep proxy-less guests online via emulator NAT unless the
profile explicitly opts into blocking.

#### Scenario: No-proxy browsing

- **GIVEN** a profile with no proxy and no block flag
- **WHEN** it boots and opens Chrome
- **THEN** pages MUST load; status MUST report `directNat: true`
