# Recon — DEV instance Android verification + keyframe/starvation fixes

T1 lane: user asked to launch a local DEV instance and verify Android
works in it before any release.

## DEV stand (this lane)

- Backend: `ANTIDETECT_DATA_DIR=.tmp/devdata API_PORT=50326 tsx
  src/main/index.ts` (own DB + api_key; `android/` symlinked from prod
  5.3 GB engine instead of re-download).
- Renderer: vite on `127.0.0.1:5199`, pointed at the DEV backend via
  `localStorage.apiBase` + `apiKey` in Playwright.
- Profile `p_eea133bb-…` created via `createProfile({browser_type:
  'android'})` — the HTTP create route ignores browser_type (always
  chromium) and sql.js is in-memory (backend restart needed to see
  externally written rows).

## What DEV proved (measured, not guessed)

- Emulator boots and runs under DEV: `running`, CPH2609 path,
  fail-closed network without proxy.
- Ticket carries served 408x912 once meta arrives; CONFIG replay
  (44 B, cfg=1) reaches fresh clients.
- Canvas geometry is CORRECT: backing 408x912, CSS 275x618
  (0.4474 vs 0.4450). Live video renders with correct proportions.
- Decoder: cfg:1, chunks:852, frames:813, errors:[] over 15 s of
  motion — the full decode path works in real Chromium.
- Touch: TaplEvents ACTION_DOWN/UP land (prior lane's buttons fix).
- Encoder starves on idle by design (1 CONFIG in 20 s, 0 keys);
  under motion 719 packets / 1.4 MB / 5 keys in 15 s.

## Fixes in this lane (uncommitted until user says release)

- `streamHost.ts`: ticket holder tracking — StrictMode double-mount
  burned the single-use ticket and killed the real connection with
  INVALID_TICKET (black canvas in dev). Ticket now binds to the live
  holder socket and frees on close.
- `streamHost.ts`: `video_codec_options=
  i-frame-interval=2,repeat-previous-frame-after=2000000` — server log
  confirms both options accepted; forces periodic IDR output.

## Acceptance check

- `tsc` main clean; renderer/vitest/cargo gates re-run at release.
- DEV E2E: boot → ticket → stream → decode → render → tap, all green.
- No release made (user asked to verify first). Tree holds the
  streamHost.ts diff + this recon when committed.
