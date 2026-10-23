## 1. Backend: config-driven Android (fixer)

- [x] 1.1 Read `profiles.android_config` JSON + `mobile_model_id` in
  `resolveAndroidConfig`; extend `ResolvedAndroidConfig` (cores, ramMb,
  heapMb, screen, densityDpi). Fall back to fingerprint defaults when absent.
- [x] 1.2 `ensureAvd()` uses per-profile hw (cores/RAM/heap/screen/density);
  AVD signature includes config hash; rebuild on change.
- [x] 1.3 `profileManager` read/write `android_config` (create/update paths).
- [x] 1.4 Regression tests: config resolution, AVD file content, fallbacks.

## 2. MCP Android verbs (fixer; blocked-by: 1.1)

- [x] 2.1 `android.{start,stop,status}` tools → instance registry.
- [x] 2.2 `android.{tap,swipe,type,key,screencap}` tools → scrcpy control
  builders + screencap; `android.install_apk` → AdbClient.install.
- [x] 2.3 Manifest + scope registration; auth parity with browser verbs.
- [x] 2.4 Tool tests (mocked instance): arg validation + dispatch.

## 3. UI: profiles launch + settings (designer)

- [x] 3.1 Profiles list: Android Start boots + opens OS window, Stop kills;
  remove tab intercept; status badge from instance status.
- [x] 3.2 Settings `android` section: engine status/install (moved from tab).
- [x] 3.3 Profile card Android section: preset picker, seed, screen W/H,
  density, cores, RAM, heap (manual fields, validated ranges).
- [x] 3.4 Delete `Android.tsx` + nav entry; keep `AndroidWindow.tsx`.
- [x] 3.5 BEFORE/AFTER screenshots (profiles row, settings, card).

## 4. Integration + E2E (parent; blocked-by: 1.4, 2.4, 3.5)

- [x] 4.1 Merge slices to integration branch; full suite green.
- [x] 4.2 DEV E2E: create → configure → start → window stream → MCP
  tap/screencap → stop; measure boot + first-frame times.
- [x] 4.3 Oracle blind ACCEPT vs manifest; archive on pass.
