# Recon — Android as profiles (T2)

Wave 1 recon by 3 scout subagents (read-only) + parent spot-checks.
All paths below verified to exist in this tree.

## Touched files (planned)

- Profiles launch: `src/renderer/src/pages/Profiles.tsx:2277`
  (android branch → tab today), `src/renderer/src/api.ts`
  (`api.start/stop`), `src/main/api/routes/browser.ts`
  (`/api/v1/browser/start|stop`, already multiplexes android),
  `src/main/android/instance.ts` (`launch/stop/isRunning`).
- Tab removal: `src/renderer/src/App.tsx:137` (NAV_ITEMS `android`),
  `src/renderer/src/App.tsx:681` (`<AndroidPage>` render),
  `src/renderer/src/pages/Android.tsx` (delete after moving engine UI).
- Settings: `src/renderer/src/pages/Settings.tsx:716` (SECTIONS array;
  add `android` section), `src/main/api/routes/settings.ts`.
- Fingerprint/HW: `src/main/devices/mobilePresets.ts` (pool),
  `src/main/android/fingerprint.ts` (`generateAndroidFingerprint`),
  `src/main/android/config.ts` (`resolveAndroidConfig` — must read
  `profiles.android_config`), `src/main/android/instance.ts:470`
  (`ensureAvd` hardcodes ncore=4/ram=4096/heap=576),
  `src/main/db/schema.ts:302` (`android_config` column exists).
- MCP: `mcp/src/tools.ts`, `mcp/src/toolManifest.ts`,
  `mcp/src/browser.ts`, `src/main/mcpService.ts`;
  Android verbs: `src/main/android/adb.ts` (`AdbClient`),
  `src/main/android/scrcpyProtocol.ts` (build*Message),
  `src/main/android/streamHost.ts` (`sendControl`, tickets).
- Window (reuse): `src-tauri/src/main.rs` (`open_android_window`),
  `src-tauri/src/bridge.js`, `src/renderer/src/pages/AndroidWindow.tsx`.

## Key facts (scout claims, parent-verified)

- Backend `/api/v1/browser/start` already routes android; only the UI
  bypasses it. `Profiles.tsx:2277` intercepts android clicks to the tab.
- `profiles.android_config` (TEXT) and `mobile_model_id` columns exist;
  `resolveAndroidConfig` reads neither today.
- MCP has 35 default + 12 gated tools, zero Android verbs.
- 77 Android unit tests + 19 MCP tests observed (no runs in recon).

## Acceptance check

- E2E on DEV stand: create android profile → Start from Profiles →
  window opens with stream → Settings shows engine section, no Android
  tab → MCP tap/screencap/start/stop/APK-install works → stop clean.
- Full suite + oracle blind ACCEPT vs manifest quotes.
