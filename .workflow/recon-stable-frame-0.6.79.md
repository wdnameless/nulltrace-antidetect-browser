# Recon — stable frame + working touch, release v0.6.79

T1 lane: user reported the picture jumping back and forth and touch
not landing, on installed 0.6.78.

## Root causes

1. ResizeObserver feedback loop: observer → boxSize state → frameBox
   resize → container size change → observer fires again. The layout
   never settled, so taps chased a moving canvas.
2. setState per decoded frame (60fps re-renders): the decoder output
   called setVideoSize on every frame size check, plus an unthrottled
   onVideoSize to the parent on every frame. Layout recomputed
   constantly even when dimensions never changed.
3. setPointerCapture on the canvas broke click parity in the Tauri
   webview while buying nothing (coordinates come from
   getBoundingClientRect per event anyway).

## Touched files

- `src/renderer/src/components/AndroidCanvas.tsx` only: dropped the
  observer + boxSize state; frame is pure math from window size and
  the live video ratio (recomputed on render, no state loop); backing
  store follows the decoder without setState; parent label updates
  only on dimension change (lastReportedRef); pointer capture removed.
- Release: 4 carriers 0.6.78 → 0.6.79, CHANGELOG section.

## Acceptance check

- `tsc` main + renderer clean; `npm run build` ok.
- Full `npm test`: 197 files / 1790 passed, 12 skipped.
- `sbom:verify` ok; `cargo test` 58/58.
- Released: `main` + tag `v0.6.79` pushed; CI `refs/tags/v*` builds.
- Visual limit (stated): no browser host for screenshots; the user's
  update to 0.6.79 is the visual confirmation.
