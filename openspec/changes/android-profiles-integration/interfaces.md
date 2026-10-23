# Interfaces — android-profiles-integration

Cross-slice contracts fixed up front (Wave 2). Owners: fixer (backend),
designer (UI). One owner per file; writers isolated.

## A. Profile config shape (owner: fixer)

```ts
// profiles.android_config JSON (all optional; absent = fingerprint defaults)
interface AndroidProfileConfig {
  presetId?: string;   // mobilePresets id; else seed-picked
  seed?: number;       // identity seed; else profile-derived
  screenW?: number;    // physical px, 320..2160
  screenH?: number;    // physical px, 480..4320
  densityDpi?: number; // 120..640
  cores?: number;      // 1..16
  ramMb?: number;      // 1024..16384
  heapMb?: number;     // 128..2048
}
```

`resolveAndroidConfig(): ResolvedAndroidConfig` gains
`cores, ramMb, heapMb, densityDpi` (resolved, never undefined).
`AndroidStartOptions` gains the same three hw fields.
AVD signature: `...;metrics=v2;hw=<sha1-8 of resolved hw>`.

## B. Launch flow (owner: designer calls, fixer serves)

- UI calls existing `api.start(id)` → `POST /api/v1/browser/start`
  (backend already multiplexes android) — NO new launch route.
- On `running`, UI calls `window.antidetect.openAndroidWindow(id)`
  (existing) with `#/android-window?profile=` tab fallback (existing).
- Stop: existing `api.stop(id)` → backend `stopAndroidProfile`.
- Status badge polls existing `api.androidStatus(id)`.

## C. Settings section (owner: designer)

- New `android` key in `Settings.tsx` SECTIONS; reuses existing
  `api.androidEngine()` / `api.androidEngineInstall()`.
- No backend changes for engine routes.

## D. Profile card fields (owner: designer writes, fixer reads)

- Card edits `android_config` via existing profile update route
  (fixer extends `profileManager` update to persist the key).
- Validation ranges enforced in UI; backend clamps defensively.

## E. MCP verbs (owner: fixer)

Tools (names final): `android.start|stop|status|tap|swipe|type|key|
screencap|install_apk`. Args: `{ profileId, ...verbArgs }`.
`screencap` returns PNG bytes (base64, same envelope as
`browser.screenshot`). Auth scope: same as browser verbs.
