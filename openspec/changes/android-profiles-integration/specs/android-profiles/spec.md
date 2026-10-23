## Purpose

Android profiles behave like normal profiles: launch from the list into
their own window, configure fingerprint + hardware per profile, manage
the engine from Settings, and automate over MCP.

## ADDED Requirements

### Requirement: Profiles-list launch

The system MUST start/stop Android profiles from the Profiles list with
the same buttons as Chromium profiles, opening the stream in its own OS
window via the existing `open_android_window` shell command.

#### Scenario: Start from list

- **GIVEN** an Android profile row
- **WHEN** the operator clicks Start
- **THEN** the emulator MUST boot and an OS window MUST open with its stream
- **AND** Stop MUST terminate the instance

### Requirement: Per-profile Android config

The system MUST persist per-profile Android config (preset, seed, screen
W/H, density, cores, RAM, heap) in `profiles.android_config` and boot the
AVD with exactly those values.

#### Scenario: Custom hardware boots

- **GIVEN** cores=8, ramMb=8192 saved on the profile
- **WHEN** the emulator starts
- **THEN** the AVD config MUST contain `hw.cpu.ncore=8` and `hw.ramSize=8192`

### Requirement: MCP Android verbs

The system MUST expose `android.{start,stop,status,tap,swipe,type,key,
screencap,install_apk}` MCP tools with browser-verb auth parity.

#### Scenario: Agent taps the emulator

- **GIVEN** a running Android profile
- **WHEN** the agent calls `android.tap` with canvas coordinates
- **THEN** the guest MUST receive the touch (TaplEvents) and return focus state

## ADDED Requirements (continued)

### Requirement: No Android tab

The system MUST NOT show an Android nav entry; engine install/status MUST
live in a Settings `android` section.

#### Scenario: Settings hosts engine

- **GIVEN** the Settings page
- **WHEN** the operator opens the Android section
- **THEN** engine status + install MUST work as before, with no tab present
