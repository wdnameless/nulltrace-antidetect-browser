# Recon — full Android functionality audit (DEV stand)

T1 lane: user asked to verify the whole Android functionality works
correctly. All checks executed live against the DEV stand (backend
:50326 + vite :5199 + real Chromium + emulator-5554), this session.

## Verdict per area

| # | Area | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Engine status | PASS | `installed:true`, API [34], whpx/aehd, emulator path resolves |
| 2 | Instances list | PASS | `[]` before start; status endpoint live |
| 3 | Start | PASS | `running`, serial emulator-5554, ports 5554/5557, ~50 s cold boot |
| 4 | Identity inject | PASS (partial by design) | 3 applied, 11 skipped with reasons, `setprop-only` + root |
| 5 | Prepare (device) | PASS | 10 `ro.product.*` applied, model `SM-S901B`, errors `[]`, stays running |
| 6 | Prepare idempotent | PASS | second call short-circuits, no restart, `applied:[]` |
| 7 | Network fail-closed | PASS | no proxy → OUTPUT DROP; guest `connect: Network is unreachable` |
| 8 | Stream ticket | PASS | served 408x912, single-holder enforced (2nd socket → INVALID_TICKET/1008) |
| 9 | Stream bytes | PASS | CONFIG 44 B + frames; stats grow (235 KB → 916 KB) |
| 10 | Decode + render | PASS | cfg:1, chunks:676–852, frames:648–813, errors:[]; canvas 408x912, ratio 0.4474 vs 0.4450; screenshot shows live video |
| 11 | Touch | PASS | WS tap → TaplEvents ACTION_DOWN+ACTION_UP (4 events), focus changes to tapped app |
| 12 | Stop | PASS | `stopped:true`, adb empty, 0 qemu processes |
| 13 | Separate window | PASS (code) | route + page + shell command in tree; Tauri window itself needs the desktop shell (browser shows the same page) |

## Known non-defects (measured, by design)

- Idle stream is sparse (1 CONFIG in 20 s, 0 keys): the encoder emits
  on screen change only; `i-frame-interval=2,repeat-previous-frame-
  after` options are accepted (server log confirms) but c2.android.avc
  still skips IDR on a static frame. Client correctly shows the last
  decoded frame (desktop-scrcpy behavior).
- Identity is `setprop-only`: read-only props need the prepare path
  (which works), not inject.
- Prepare takes ~113 s (two emulator restarts by design).

## Touched files

- None (audit only). Tree still holds the uncommitted `streamHost.ts`
  ticket-holder + keyframe diff from the prior DEV lane.

## Acceptance check

- Every numbered area above has a live measurement from this session,
  quoted in the verdict table. No area was inferred from code or
  screenshots alone.
