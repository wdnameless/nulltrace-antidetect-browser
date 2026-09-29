# Proposal: docs-gaps-closure

## Why
An audit of documentation (`docs/STEALTH_PARITY.md`, `docs/COMPETITIVE_ANALYSIS.md`, `docs/DECISIONS.md`) identified concrete gaps between planned capabilities and active implementations:
1. **Per-Profile Font Inventory Override**: While hardware catalogs derive font inventories, operators could not tune or override the font whitelist per profile through the UI and launch pipeline, leaving a gap in deep fingerprint customization.
2. **Multi-Window Synchronizer Scroll & Key Mirroring**: The synchronizer mirrored synthetic pointer clicks, but missed mouse wheel scroll deltas and non-character control keys (Enter, Tab, Escape, Backspace) via native CDP input.
3. **Distribution & Offline Stability**: Offline token injection cookie directory resolution and Linux AppImage workflow alignment.

This change closes these gaps with focused, test-proven implementations across backend profile management, renderer UI, and synchronizer CDP pipelines.

## What Changes
1. **Font Inventory Override (`src/renderer/src/pages/Profiles.tsx`, `src/main/profiles/profileManager.ts`)**:
   - Add `fontList?: string` to renderer `FpForm` with a comma-separated textarea in the Fingerprint Overrides drawer.
   - Persist parsed string array `cfg.fontList = fonts` to `fingerprints.config_json`.
   - Propagate `fpCfg.fontList` in `resolveLaunchConfig` to `stealth.fontList`, falling back to `hwVector.fontInventory`.
   - Verified by `tests/unit/fontListOverride.test.ts`.

2. **Synchronizer Native Scroll & Key Mirroring (`src/main/syncer/actionSyncer.ts`)**:
   - Capture `wheel` delta events and forward via CDP `Input.dispatchMouseEvent` (`mouseWheel`).
   - Capture keyboard interactions including control keys (`Enter`, `Escape`, `Tab`, `Backspace`) and forward via CDP `Input.dispatchKeyEvent`.
   - Verified by `tests/unit/syncer/syncScrollKey.test.ts`.

3. **Release & Packaging Gaps**:
   - Ubuntu release workflow jobs and node sidecar configuration for Linux platform support.
   - Offline token cookie path resolution via `resolveProfileDir`.

## Capabilities
- `font-inventory-override`: Operator ability to customize font lists per profile via UI and stealth launch vector.
- `syncer-scroll-keys`: Real CDP wheel delta and control key forwarding across synchronized slave profiles.

## Goals
- Provide full end-to-end plumb from UI textarea to `stealth.fontList` at browser launch.
- Ensure backwards compatibility by falling back to catalog `hwVector.fontInventory` when no override is specified.
- Enable high-fidelity multi-window synchronizer input replication.

## Non-Goals
- No changes to network transport policy or TLS ciphers.
- No engine-level Chromium source tree rebuilds.
