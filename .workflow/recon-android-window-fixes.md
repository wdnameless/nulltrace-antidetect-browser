# Recon — black screen, resolution, separate window per profile

T1 lane: user reported a black STREAMING canvas at the wrong size and asked
for one OS window per Android profile (multi-profile work).

## Diagnosis

- The backend stream is healthy: raw WS probe shows 114 binary frames /
  691 KB in 12 s, codec meta `h264 408x912`, CONFIG + keyframes flowing,
  guest Awake. Black screen is client-side decode/layout, not the guest.
- Resolution mismatch is real in two places: the ticket says 412x915
  (profile screen) while the encoder serves 408x912 (rounded to /8), and
  the phone frame was sized from the ticket, not the video.
- Touch was broken independently: pointer down/move/up sent actions
  1/2/0 (UP/MOVE/DOWN) instead of 0/2/1 — every tap was an UP without a
  DOWN, so the guest ignored it.
- No multi-window path existed: single Tauri `main` window, no command,
  no capability, no route.

## Touched files

- `src/renderer/src/components/AndroidCanvas.tsx`:
  - canvas sized from each decoded `VideoFrame` (`displayWidth/Height`),
    mirrored into a `videoSize` state that drives the phone frame's
    `aspectRatio` — layout follows the served 408x912, not the 412x915
    ticket; survives late join (no meta yet) and mid-flight resize.
  - codec-meta handler also updates `videoSize` + viewport (touch stays
    exact for the guest's size check).
  - touch actions fixed to `TOUCH_ACTION_DOWN/MOVE/UP` constants.
- `src-tauri/src/main.rs`: new `open_android_window` command — one window
  per profile (`android-<safe-id>` label, sanitised), focuses an existing
  one, navigates to `/#/android-window?profile=<id>` on the backend
  origin, phone-sized (460x980, min 360x640), taskbar icon applied.
- `src-tauri/capabilities/remote-ui.json`: `android-*` added to windows
  so the new webviews get IPC.
- `src-tauri/src/bridge.js`: `antidetect.openAndroidWindow(profileId)`.
- `src/renderer/src/global.d.ts`: type for the new bridge function.
- `src/renderer/src/pages/AndroidWindow.tsx` (new): standalone page —
  polls status, acquires its own ticket, renders only the stream.
- `src/renderer/src/main.tsx`: `#/android-window?profile=` hash route
  renders the standalone page instead of the full app (no backend route
  needed — SPA fallback serves index.html).
- `src/renderer/src/pages/Android.tsx`: `Open Window` button next to
  Start/Stop (running only) + handler with browser-tab fallback.

## Acceptance check

- `tsc` renderer + main clean; `cargo check` + `cargo test` 58/58 green.
- `npm run build` succeeds; new code confirmed in the shipped bundle
  (`android-window`, `openAndroidWindow`, `Open Window` present).
- Live: two simultaneous WS clients on two tickets both receive binary
  video (71 + 22 frames) — two windows can stream at once.
- Vite serves `#/android-window?profile=` with 200 and the route code.
- Stream suites green (androidScrcpyProtocol + androidInstance +
  androidFingerprint: 40/40).
- Visual limit (stated, not hidden): no browser host was available for
  screenshots (`browser_new_tab` timed out), and the installed 0.6.74
  app still ships the old renderer — the user verifies the picture
  after updating to this release.
