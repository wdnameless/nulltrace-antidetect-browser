## Purpose

Defines how an Android profile becomes its own physical device: a
boot-safe identity block, its publication through an emulator restart, and
honest reporting of what the emulator pins.

## ADDED Requirements

### Requirement: Boot-safe identity block

The system MUST write the profile's identity as a marker-delimited block of
exactly the ten `ro.product.*` keys (generic + `ro.product.product.*`) into
the profile's `/product/etc/build.prop` overlay, staged through a temp file
with a backup taken first and restored on any failure, verified by reading
the file back.

#### Scenario: Successful write

- **GIVEN** a booted profile with a writable product partition
- **WHEN** preparation writes the identity
- **THEN** the file MUST contain the `# >>> nulltrace device identity` block
  with `ro.product.model` equal to the fingerprint's model
- **AND** the result MUST list the ten keys in `applied` with `rebootRequired: true`

#### Scenario: Read-only partition

- **GIVEN** `/product` refuses writes after arming and one emulator restart
- **WHEN** preparation probes the partition
- **THEN** it MUST return the failure in `errors` without throwing
- **AND** the instance MUST be left running with its services up

### Requirement: Publish through an emulator restart

The system MUST publish a written identity by restarting the emulator process
on the same ports — never by `adb reboot` — and MUST restart the per-boot
services afterwards, so the instance is usable for automation without
relaunching.

#### Scenario: Prepared profile serves its own device

- **GIVEN** a running profile reporting the stock image device
- **WHEN** `prepareProfile()` completes without errors
- **THEN** the guest MUST serve the fingerprint's model and device
- **AND** the instance state MUST be `running` with a stream ticket issuable

#### Scenario: Idempotent re-run

- **GIVEN** a prepared profile that already reports the expected model
- **WHEN** preparation runs again
- **THEN** it MUST NOT restart the emulator
- **AND** it MUST return the effective device with empty `errors`

### Requirement: Honest reporting of fixed keys

The system MUST list in `device.fixed` every identity-adjacent key it does
not write — emulator-owned keys and boot-image inputs — using one shared
constant, so no caller can silently claim a fuller spoof.

#### Scenario: Fixed keys are visible

- **GIVEN** a completed preparation
- **WHEN** the caller reads the result
- **THEN** `fixed` MUST contain `ro.serialno`, `ro.hardware`,
  `ro.build.fingerprint`, `ro.build.version.release`, `ro.build.version.sdk`,
  `ro.kernel.qemu`, `ro.boot.qemu` and `ro.product.board`

## MODIFIED Requirements

### Requirement: A mid-boot emulator death fails fast

The system MUST reject the boot wait with the emulator's own fatal line when
its process exits before reaching `running`, instead of waiting out the boot
deadline and reporting a timeout.

#### Scenario: Fatal during restart

- **GIVEN** an emulator that exits with a `FATAL |` line while booting
- **WHEN** the boot race is pending
- **THEN** the caller MUST receive `ERR_ANDROID_EMULATOR_EXIT` carrying that line
