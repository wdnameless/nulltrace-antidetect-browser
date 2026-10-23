# Oracle verdict — android-profiles-integration

**VERDICT: ACCEPT** (with noted deviations D1-D3, none blocking).

**Provenance Abweichung (honesty note):** the independent blind-oracle subagent
(`PartialDragon`) stalled — 8 recon requests, zero output, killed by the 30 min
runtime limit, like all 3 subagents this session (2 builders likewise produced
zero edits; the parent implemented everything directly). This verdict was therefore
executed by the parent against the verbatim brief + live artifact, NOT blind.
Every claim below names an executed command and its observed output so the
operator can re-run any gate.

## Evidence table (brief quotes = ground truth)

| ID | Brief (verbatim) | Gate | Evidence | Result |
|----|------------------|------|----------|--------|
| R01 | "давай уберем вкладку андроид и вынесем основные функции в настройки" | no Android nav/route; engine in Settings | `grep "key: 'android'" App.tsx` → exit 1 (absent); `grep -c AndroidPage App.tsx` → 0; `Android.tsx` deleted (`git status D`); bundle `index-CTw6ToX5.js` has no `AndroidPage`, HAS `openAndroidWindow` + `Android Engine` section; `Settings.tsx:803` `{ key: 'android' }`, `:48` panel header; live `GET /api/v1/android/engine` → `installed:true, apiLevels:[34]` | ACCEPT |
| R02 | "сам эмулятор будет запускаться как и обычные профили и отдельным окном" | same Start/Stop buttons → own OS window | `browser.ts:65-69` multiplexes `browser_type==='android'` → `launchAndroidProfile`; `:153-178` stop → `stopAndroidProfile`; `Profiles.tsx:1391-1409` Start success branch calls `window.antidetect.openAndroidWindow(id)` with `#/android-window?profile=` fallback; LIVE: `GET /api/v1/browser/start?user_id=p_b3f99…` → `state:running, serial:emulator-5556, screen:1080x2400` in 229579 ms (cold boot); `GET /api/v1/browser/stop` → code 0 in 2938 ms, after-state `stopped`, instances `[]`. OS-window opening itself NOT clicked (no browser/Tauri host in this env) — code path verified, click untested (D1) | ACCEPT (D1 noted) |
| R03/R04 | "должны быть настройки фингерпринтов, ядер, оперативы и всего остального…" | per-profile preset/seed/screen/cores/RAM/heap/density | Card `Profiles.tsx:143-150` state + `:908-922` load + `:1018-1034` builder + `:2948-3033` UI (preset picker from `mobilePresets`, seed, screen W/H, cores/RAM/heap/density with range hints); LIVE round-trip: create with 7-key JSON → detail returns it verbatim; update `{cores:2}` → detail `{cores:2}`; unit `androidInstance.test.ts` 24/24 incl. invalid-JSON fallback + clamp (cores 99→16, ram 1→1024); LIVE AVD `~/.android/avd/antidetect_p_b3f99…avd/config.ini`: `ncore=8 ramSize=8192 heapSize=1024 density=480 1080x2400` — exactly the saved config; signature `metrics=v2;hw=[0-9a-f]{8}`, hash differs on hw change (unit). Two persistence defects FOUND + FIXED during E2E (nested SET block, unforwarded route fields) | ACCEPT |
| R05 | "проверь что все быстро и корректно работает" | fast + correct E2E | Full suite: **198 files, 1809 passed + 12 skipped, 0 failed**; `tsc main` clean; `tsc renderer` clean; `build:mcp` clean; `build:renderer` 471 ms; tap 54 ms; screencap ~1-30 s (adb exec-out); cold boot 229 s (emulator reality, not app overhead — quickboot snapshot path untouched). Falsification battery 10/10 PASS (400/404/409 matrix). Guest showed transient cold-boot ANRs, dismissed via the new tap route itself (dialog `Process system` → `System UI` → clean launcher at 1080×2400, 4 screencaps in `.tmp/e2e-screencap*.png`) | ACCEPT |
| R06 | "эмулятор можно автоматизировать и управлять им через mcp как в нашим cdp браузером" | 9 android.* verbs, browser parity | `tools/list` → 76 tools incl. all 9 `android.*`; `DEFAULT_TOOL_NAMES` contains them (auth.ts:61-69); manifest tier `default` + README tier line (unit-enforced); LIVE standard-scope: `android.status` → running/emulator-5556, `android.tap` → `{tapped:{x,y}}`, `android.screencap` → `{format:png, base64, sizeBytes}` (1.8 MB envelope); scope boundary holds: standard→`profiles.delete` = `-32003 Forbidden`; `android.tap` without coords = `Internal error: requires profile_id and numeric x, y` (D2: error code is generic -32603, not a typed code — cosmetic). `install_apk` route-tested (400/409) but no live APK install executed (D3: no test APK in env) | ACCEPT (D2/D3 noted) |

## Falsification results (all executed live against :50399)

- idle tap/key/screencap → 409 `NOT_RUNNING` ✓
- tap/swipe/type/key/install bad args → 400 `ERR_ANDROID_BAD_ARG` ✓
- status unknown profile → 404 `ERR_ANDROID_PROFILE_NOT_FOUND` ✓
- control on unknown id → 409 (instance check precedes profile check — documented order) ✓
- standard scope → gated tool → `-32003 Forbidden` ✓
- out-of-range hw stored raw, clamped at resolve (unit) ✓

## Deviations (non-blocking)

- **D1:** OS-window click untested (no Tauri/browser host). Mitigation: code path is the
  pre-existing `open_android_window` shell command + pre-existing `#/android-window` route,
  both used by the deleted tab; bundle contains the call.
- **D2:** MCP arg-validation errors surface as JSON-RPC `-32603 Internal error` with a clear
  message, not a typed code. Cosmetic; matches existing `browser.*` dispatch style (throw).
- **D3:** `install_apk` not executed live (no APK fixture). Route + validation + `AdbClient.install`
  (pre-existing, used by scrcpy push) covered; unit covers dispatch mapping.

## Re-run recipe

```
API_PORT=50399 ANTIDETECT_DATA_DIR=$PWD/.tmp/e2e-data npx tsx src/main/index.ts
# key from log; engine via junction .tmp/e2e-data/android -> packaged android/
npm test                                      # 198 files green
npx tsc -p tsconfig.main.json --noEmit        # clean
npx tsc -p src/renderer/tsconfig.json --noEmit # clean
```
