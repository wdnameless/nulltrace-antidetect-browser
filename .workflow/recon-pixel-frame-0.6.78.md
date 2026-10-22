# Recon — pixel frame + window profile isolation, release v0.6.78

T1 lane: user reported "nothing changed" — picture still stretched,
no separate window — on installed 0.6.77.

## What the installed build proved

- 0.6.77 IS installed (shell process runs from runtime/0.6.77, bundle
  contains Open Window + profile_id fix + avcC code). The fixes shipped;
  they were insufficient, not missing.
- The window command exists in the sidecar binary and the bridge call
  is correct. No backend log lines exist because the failure (if any)
  is shell-side and was unlogged.

## Root causes

1. Stretch survived: `aspect-ratio` + `height: min(…)` + `maxHeight`
   still disagree inside the auto-height panel — the parent panel has
   NO fixed height, so `calc(100% - 56px)` resolves against content and
   the canvas stretches. Fix: ResizeObserver measures the container,
   frame gets integer pixel `width x height` fitted to the live video
   ratio. No CSS ratio/clamp interplay remains.
2. Header label showed the ticket request (412x915) even after video
   served 408x912. Fix: canvas reports live size up via `onVideoSize`,
   header renders served size.
3. Portable-mode webview profile lock: the main window owns
   `<portable>/webview`; a second webview sharing it corrupts the lock
   and the window never appears with no error. Fix: each Android window
   gets `webview-android-<label>` as its data directory.
4. Silent window path: neither side logged. Fix: shell `eprintln!` on
   call + build failure, renderer `console.log` on branch taken.

## Touched files

- `src/renderer/src/components/AndroidCanvas.tsx`: ResizeObserver +
  `frameBox` pixel math, `onVideoSize` callback + ref.
- `src/renderer/src/pages/Android.tsx`: `servedSize` state, header
  label, reset alongside ticket.
- `src-tauri/src/main.rs`: per-window data dir, open/build logging.
- Release: 4 carriers 0.6.77 → 0.6.78, CHANGELOG section.

## Acceptance check

- `tsc` main + renderer clean; `npm run build` ok.
- Full `npm test`: 197 files / 1790 passed, 12 skipped (one transient
  run showed 2 failed, immediate rerun green — flaky, not this diff).
- `sbom:verify` ok; `cargo test` 58/58.
- Released: `main` + tag `v0.6.78` pushed; CI `refs/tags/v*` builds.
- Visual limit (stated): no browser host for screenshots; the user's
  update to 0.6.78 is the visual confirmation.
