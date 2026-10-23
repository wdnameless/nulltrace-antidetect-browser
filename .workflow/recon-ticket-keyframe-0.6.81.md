# Recon — ticket holder + idle keyframes, release v0.6.81

T1 lane: user said "fix it" after the full audit. Scope: the pending
`streamHost.ts` diff (ticket holder tracking + keyframe options),
cleaned, verified live, released.

## What was wrong

1. Single-use tickets burned on React StrictMode's double-mount: two
   upgrades raced with the same ticket, the first (doomed) socket
   consumed it, the real connection got INVALID_TICKET → black canvas
   in DEV (and any fast remount).
2. Idle screens yielded zero keyframes (CONFIG only for 20–30 s), so
   new decoders stalled on black until the user swiped.
3. The pending diff also carried a garbled duplicate comment block.

## Touched files

- `src/main/android/streamHost.ts`: `TicketRecord.holder` tracks the
  live socket; validity = no live holder + unexpired; holder freed on
  client close; consumed set on attach. `video_codec_options=
  i-frame-interval=2,repeat-previous-frame-after=2000000` (single
  line — last wins in scrcpy Options). Orphan comment removed.
- Release: 4 carriers 0.6.80 → 0.6.81, CHANGELOG section.

## Acceptance check (all live, this lane)

- StrictMode simulation (open → close → reopen same ticket):
  W1 status+codec, close, W2 status+codec + binary frames
  → RECONNECTED-OK.
- Concurrent second holder with the same ticket: INVALID_TICKET/1008
  → single-use preserved where it matters.
- Server log confirms both codec options accepted.
- `tsc` main + renderer clean; `npm run build` ok.
- Full `npm test`: 197 files / 1790 passed, 12 skipped.
- `sbom:verify` ok; `cargo test` 58/58.
- Released: `main` + tag `v0.6.81` pushed; CI `refs/tags/v*` builds.
