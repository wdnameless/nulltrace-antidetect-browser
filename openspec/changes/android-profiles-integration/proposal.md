## Why

Android lives in a separate tab with its own launch flow, hardcoded emulator
hardware (4 cores / 4 GB RAM for every profile), seed-only fingerprints, and
zero MCP verbs — while normal profiles launch from the list and automate over
MCP/CDP. The user wants one UX: Android profiles that start/stop from Profiles
in their own window, per-profile fingerprint + hardware settings like other
antidetects, and MCP automation at browser parity.

## What Changes

- Profiles list: Android rows use the same Start/Stop buttons as Chromium.
  Start boots via `/api/v1/browser/start` (already multiplexed) and opens the
  existing `#/android-window` in its own OS window; Stop kills the instance.
- Android tab deleted from nav; engine install/status moves to a new Settings
  `android` section. `Android.tsx` page deleted; `AndroidWindow.tsx` stays.
- Profile card gains an Android section (browser_type=android only): mobile
  preset picker, seed, screen W/H, density, CPU cores, RAM, VM heap —
  persisted in the existing `profiles.android_config` JSON column.
- `resolveAndroidConfig` reads `android_config` (+ `mobile_model_id`);
  `ensureAvd` uses per-profile cores/RAM/heap/screen/density instead of
  hardcoded values; AVD signature includes the config hash (rebuild on change).
- MCP: `android.{start,stop,status,tap,swipe,type,key,screencap,install_apk}`
  tools mapping to the instance registry + scrcpy control builders.
- API route `POST /api/v1/android/profiles/:id/start` stays (compat); the UI
  stops calling it directly for the launch flow.

## Capabilities

### New Capabilities

- `android-profiles`: profiles-list launch/stop, per-profile config, MCP verbs.

### Modified Capabilities

- `android-launcher`: config-driven AVD (was hardcoded hw).
- `settings-ui`: new `android` section (was separate tab).

## Impact

- `src/renderer/src/pages/Profiles.tsx`: remove android→tab intercept, window open.
- `src/renderer/src/App.tsx`: drop `android` nav + route.
- `src/renderer/src/pages/Settings.tsx`: `android` section (engine UI moved).
- `src/renderer/src/pages/Android.tsx`: DELETE (after engine UI moved).
- `src/main/android/config.ts`, `fingerprint.ts`, `instance.ts`: config-driven hw.
- `src/main/profiles/profileManager.ts`: read/write `android_config`.
- `mcp/src/tools.ts`, `mcp/src/toolManifest.ts`: android verbs.
