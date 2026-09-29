# Spec: docs-gaps-closure

## Purpose
Address documented parity gaps across multi-window synchronization (wheel scrolling, special key mirroring) and per-profile stealth customization (font inventory override) with robust end-to-end integration and automated regression tests.

## Requirements

### Requirement R01: Multi-Window Synchronizer Scroll & Special Key Mirroring
The action synchronizer SHALL mirror mouse wheel events and keyboard key events (including control keys like Enter, Escape, Tab, Backspace) from master sessions to attached slave sessions via direct CDP `Input` domain commands.

#### Scenario: Wheel scroll accumulation and forwarding
- **GIVEN** an active synchronizer session with one master and one or more slaves
- **WHEN** master window dispatches wheel scroll events with `deltaX` and `deltaY`
- **THEN** synchronizer invokes `Input.dispatchMouseEvent` with type `mouseWheel` on each slave window using corresponding coordinates and deltas.

#### Scenario: Special key forwarding
- **GIVEN** focused input element in master session
- **WHEN** user presses `Enter`, `Escape`, or keyboard shortcuts
- **THEN** synchronizer forwards `rawKeyDown`, `keyDown`, and `keyUp` events via `Input.dispatchKeyEvent` with matching `key`, `code`, and modifier flags (`ctrl`, `shift`, `alt`).

### Requirement R02: Per-Profile Font Inventory Override
The application SHALL permit operators to specify an explicit list of font names for a profile. When set, this override MUST supersede the catalog-derived font list at launch and propagate into `stealth.fontList`. When unset, launch resolution MUST fall back to the seed-derived `hwVector.fontInventory`.

#### Scenario: Operator configures fontList override
- **GIVEN** an existing browser profile
- **WHEN** operator updates fingerprint configuration with `{ fontList: ['Arial', 'Custom Corp Font', 'Segoe UI'] }`
- **THEN** `resolveLaunchConfig(id)` sets `cfg.stealth.fontList` to `['Arial', 'Custom Corp Font', 'Segoe UI']`.

#### Scenario: Unspecified fontList falls back to catalog seed inventory
- **GIVEN** a browser profile created without fontList overrides
- **WHEN** `resolveLaunchConfig(id)` is executed
- **THEN** `cfg.stealth.fontList` is an array populated with non-empty font names derived from `hwVector.fontInventory`.

#### Scenario: Renderer UI input persistence
- **GIVEN** the Fingerprint Overrides drawer in `src/renderer/src/pages/Profiles.tsx`
- **WHEN** operator enters comma-separated font names in `Font Inventory Override` textarea and saves
- **THEN** input is parsed into an array of trimmed non-empty strings and saved to `cfg.fontList`.

### Requirement R03: Linux Release Pipeline Support
The build system SHALL provide an Ubuntu AppImage release job in `.github/workflows/ci.yml` bundling a vendored Node.js binary for `x86_64-unknown-linux-gnu`.

### Requirement R04: Offline Token Injection Cookie Path Resolution
Token login injection SHALL resolve the actual profile data directory using `resolveProfileDir` before computing SQLite cookie storage paths and OS encryption keys.

### Requirement R05: Service Endpoint Resolution for Export
XLSX and data export operations SHALL resolve API endpoints using `getApiBase()` to ensure proper connectivity in packaged desktop environments.
