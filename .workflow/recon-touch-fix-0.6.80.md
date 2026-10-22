# Recon — touch actually lands, release v0.6.80

T1 lane: user said "still the same", wants an LDPlayer-grade emulator.
Facts established this round (no guessing):

- 0.6.79 IS installed and running (shell process + bundle verified).
- Canvas geometry is CORRECT: backing 408x912, CSS 275x618 (ratio
  0.4474 vs 0.4450) — the "stretch" in screenshots is the phone UI
  itself at 408x912, not a layout bug. SPS parses to coded 416x912,
  crop 0/4/0/0 → display 412x912; encoder serves 408x912 (scrcpy
  max-size rounding), guest wm is 412x915.
- Stream starvation is by design: encoder emits only on screen change
  (1 frame in 20 s idle, 23 frames after swipes). No server option
  forces idle output (dex verified: no video_repeat/IDR key).
- Touch root cause: `buttons` field was always 0 → guest built
  BUTTON_PRESS with no button held → InputDispatcher dropped every
  gesture ("Dropping event because the pointer is not down"). Also
  actionButton=0 on UP was rejected. Viewport 408x912 confirmed
  correct (412x915 gets "different device size").

## Touched files

- `src/renderer/src/androidStream.ts`: DOWN/MOVE send buttons=1,
  UP sends 0; actionButton=1 always.
- `src/main/android/scrcpyProtocol.ts`: same rule in
  `buildTouchMessage` (explicit params.buttons still overrides).
- `tests/unit/androidScrcpyProtocol.test.ts`: release expectation
  fixed (actionButton 1), buttons assertions added.
- `src/main/android/streamHost.ts`: `_videoBytes`/`_lastVideoAt`
  counters + `videoStats` getter.
- `src/main/android/instance.ts`: status carries
  `streamStats { bytes, lastVideoAt }`.
- Release: 4 carriers 0.6.79 → 0.6.80, CHANGELOG section.

## Acceptance check

- Live tap via fixed layout: TaplEvents shows ACTION_DOWN + ACTION_UP
  with buttonState=BUTTON_PRIMARY at (206,750) — previously all
  dropped. Guest-side tap comparison opened an activity, proving the
  coordinate mapping.
- `tsc` main + renderer clean; `npm run build` ok.
- Full `npm test`: 197 files / 1790 passed, 12 skipped.
- `sbom:verify` ok; `cargo test` 58/58.
- Released: `main` + tag `v0.6.80` pushed; CI `refs/tags/v*` builds.

## Honest remainder

- Static screen still yields ~no frames (encoder-side, by design).
  The client shows the last decoded frame (correct, like desktop
  scrcpy) — black only until the first change/keyframe. A loading
  shimmer until first frame is a possible follow-up, not a bug.
