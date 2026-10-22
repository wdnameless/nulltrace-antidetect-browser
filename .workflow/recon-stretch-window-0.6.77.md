# Recon — fix stretched picture + dead Open Window, release v0.6.77

T1 lane: user's screenshot showed video rendering (avcC fix works) but
vertically stretched, and no separate window.

## Root causes (measured)

1. Stretch: phone frame sized by WIDTH (`min(100%, …)`) inside a wide
   panel → overflowed vertically → `maxHeight` clamped the box → canvas
   (`width:100%;height:100%`) stretched into the mismatch. Guest is
   412x915, video 408x912 — both portrait; the box was not.
2. Canvas effect deps `[wsUrl, screen.width, screen.height, …]`:
   `screen` is a fresh object every parent render, so each status poll
   tore down decoder + WebSocket mid-stream (flicker/reconnect churn
   under the stretch).
3. Open Window dead: bridge sent `{ profileId }`, Rust command takes
   `profile_id` — Tauri matches arg names verbatim, so every invoke was
   rejected and nothing appeared. Verified: command IS in the shipped
   0.6.76 shell binary (`open_android_window` + `android-window`
   strings present), wiring only was wrong.
4. Open Window hidden until running: gated on `isRunning`, but opening
   the window is how work begins.

## Touched files

- `src/renderer/src/components/AndroidCanvas.tsx`: frame sized by
  HEIGHT (`min(calc(100% - 56px), calc((100vw - 120px) * h / w))` from
  the live `videoSize` ratio); connect effect deps reduced to
  `[wsUrl]`; SAFETY comments restored on the two BufferSource casts.
- `src-tauri/src/bridge.js`: invoke arg `profileId` → `profile_id`.
- `src/renderer/src/pages/Android.tsx`: Open Window gated on
  `activeProfileId`; IPC/popup failures surfaced via the error banner.
- Release: 4 carriers 0.6.76 → 0.6.77, CHANGELOG section.

## Acceptance check

- `tsc` main + renderer clean; `npm run build` ok.
- Full `npm test`: 196 files / 1790 passed, 12 skipped.
- `sbom:verify` ok; `cargo test` 58/58.
- Installed 0.6.76 verified to contain the window command in the
  sidecar shell binary — 0.6.77 only fixes the call path.
- Released: `main` + tag `v0.6.77` pushed; CI `refs/tags/v*` builds.
- Visual limit (stated): no browser host for screenshots; the user's
  update to 0.6.77 is the visual confirmation.
