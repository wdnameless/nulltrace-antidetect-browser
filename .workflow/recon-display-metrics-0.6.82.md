# Recon — display metrics fix (dp→px), release v0.6.82

T1 lane: user screenshot showed squeezed guest UI ("still broken").
Root cause found by measurement, not guessing.

## Root cause

Preset screen dims are CSS px (dp): 412x915. They were written
straight into `hw.lcd.width/height` (physical px) with hardcoded
density 420. A real 412dp phone at 420dpi is ~1080x2400 physical —
so the guest rendered its whole UI into a 412x915 box and everything
looked squeezed. The canvas/stream/touch were all correct; the GUEST
was wrong.

## Touched files

- `src/main/android/fingerprint.ts`: screen is now physical px
  (`dp * deviceScaleFactor`, e.g. 1105x2394 @420dpi).
- `src/main/android/config.ts`: screen + densityDpi from the
  fingerprint (single source); `ResolvedAndroidConfig` + return.
- `src/main/android/instance.ts`: `AndroidStartOptions.densityDpi`,
  AVD `hw.lcd.density` from options; `metrics=v2` signature bump
  wipes dp-sized AVDs (config + userdata) on next start.
- `tests/unit/androidFingerprint.test.ts`: expectations to px.
- Release: 4 carriers 0.6.81 → 0.6.82, CHANGELOG section.

## Acceptance check (all live on DEV stand)

- Fresh AVD config.ini: `hw.lcd.width=1105 height=2394 density=420`.
- Guest `wm size`: 1106x2394; `screencap`: 1106x2394 with correct
  proportions (screenshot inspected: normal text layout).
- Stream ticket: 1104x2392; canvas backing 1104x2392, CSS 284x618
  (ratio 0.4615 vs 0.4595).
- Video renders with correct geometry in browser screenshot.
- `tsc` main + renderer clean; `npm run build` ok.
- Full `npm test`: 197 files / 1791 passed, 12 skipped.
- `sbom:verify` ok; `cargo test` 58/58.
- Released: `main` + tag `v0.6.82` pushed; CI `refs/tags/v*` builds.
