# android-live-run — delta spec

Traced to `manifest.md` (R01–R07). Доводит существующий слайс `android-runtime` до состояния,
в котором оператор может скачать движок и поднять живой эмулятор на железе с гипервизором.
Ничего из desktop-пути не меняется.

## ADDED Requirements

### Requirement: platform-tools is a pinned engine asset

`ANDROID_ENGINE_ASSETS` SHALL contain a `platform-tools` archive for every supported
`host-abi` key (windows-x86_64, macos-arm64-v8a, macos-x86_64, linux-x86_64), pinned with the
SHA-1 published in `repository2-3.xml` and extracted so `resolveAdbPath(engineDir)` finds the
adb binary without any PATH dependency.

Traces: R02

#### Scenario: adb resolves after engine install

- **WHEN** `ensureAndroidEngine()` completes on any supported host
- **THEN** `resolveAdbPath(engineDir)` returns an existing executable path
- **AND** `launchAndroidProfile` never throws `ERR_ANDROID_ADB_NOT_FOUND` for a missing binary

### Requirement: pinned emulator revision exists in the vendor feed

The emulator archives pinned in `ANDROID_ENGINE_ASSETS` SHALL be revisions present in the
live `repository2-3.xml` feed, with the size and SHA-1 transcribed from that feed. A pinned
build that Google has removed from the feed SHALL NOT ship, because it 404s instead of
downloading.

Traces: R03

#### Scenario: every pinned URL is downloadable

- **WHEN** each pinned asset URL is fetched
- **THEN** the CDN answers 200 with the pinned byte size
- **AND** the streamed SHA-1 matches the pinned digest

### Requirement: engine install reports hypervisor readiness before downloading

`POST /api/v1/android/engine/install` SHALL probe hypervisor readiness via
`assertHypervisorReady()` for the resolved platform BEFORE starting a multi-gigabyte
download, and SHALL answer `code: -1` with the actionable backend message (naming
`HypervisorPlatform` / AEHD / HVF / KVM) when the host cannot accelerate the emulator.
`GET /api/v1/android/engine` SHALL keep reporting `installed: false` with the platform plan.

Traces: R04

#### Scenario: no hypervisor, no 2 GB download

- **WHEN** install is requested on a host without an enabled hypervisor
- **THEN** the response carries the hypervisor error naming what to enable
- **AND** no asset download is started

#### Scenario: hypervisor present, install proceeds

- **WHEN** install is requested on a host with an enabled hypervisor
- **THEN** acquisition starts and `onProgress` reports per-asset bytes

### Requirement: first live run is a proxyless blocked profile

The documented first-run path SHALL be an android profile with no proxy: `planGuestNetwork`
returns `blocked: true`, `setupGuestNetwork` enforces OUTPUT DROP, and `start()` reaches
`running` with `network.ok === true` and a detail naming the block. No live proxy is required
to validate boot, identity injection, and streaming.

Traces: R05

#### Scenario: blocked guest boots and streams

- **WHEN** an android profile without proxy is started on capable hardware
- **THEN** status reaches `running`, inject reports its privilege honestly, stream ticket issues
- **AND** the guest has no direct route out (OUTPUT DROP applied)

## MODIFIED Requirements

### Requirement: Android engine acquisition still verifies every asset

The system SHALL keep all fail-closed acquisition scenarios of `android-runtime`: digest mismatch deletes the payload and throws `ERR_ANDROID_DIGEST_MISMATCH`, unpinned assets refuse with `ERR_ANDROID_DIGEST_UNPINNED` before any network call, stale partials are reclaimed, progress is observable. The asset set SHALL include platform-tools and feed-current revisions (see ADDED above).

Traces: R01, R02, R03, R07

#### Scenario: Existing acquisition guarantees still hold

- **WHEN** any acquisition scenario of `android-runtime` is exercised against the new asset set
- **THEN** it behaves exactly as specified there
