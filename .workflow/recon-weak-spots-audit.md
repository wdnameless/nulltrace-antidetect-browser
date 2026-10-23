# Recon — weak-spot hunt: ticket leak, start race, decoder backpressure

T1 lane: user asked to keep hunting errors and weak spots and verify
everything works correctly. Adversarial review (audit mode) over the
Android slice, three findings, all fixed + verified.

## Findings (impact-filtered)

1. MUST (Data Integrity/Ops): `_tickets` map grew by one entry per
   reconnect click forever — no prune path. Long sessions leak memory
   and slow the upgrade handler's map scan.
   Fix: prune dead (no live holder + expired) tickets on every
   `issueTicket()`. Verified: tsc clean.
2. MUST (Data Integrity): two concurrent `startAndroidProfile` calls
   for one profile both passed the registry check and booted two
   emulators; the loser overwrote the winner in the map (orphaned
   process + AVD lock fight + leaked ports).
   Fix: `startingProfiles` claim set, claimed BEFORE validation
   (sync validation otherwise never interleaves), released in
   `finally`; loser gets `ERR_ANDROID_ALREADY_STARTING`. Verified:
   live race (one spawn, one guard code) + new regression test.
3. SHOULD (Ops): `decoder.decode()` called unboundedly — on a slow
   machine the queue grows without bound (memory + latency spiral)
   while the canvas keeps feeding 60fps.
   Fix: drop non-key deltas when `decodeQueueSize > 8` (~130 ms at
   60fps); keyframes always pass to resync. Verified: tsc clean.

## Touched files

- `src/main/android/streamHost.ts`: ticket prune loop.
- `src/main/android/instance.ts`: `startingProfiles` guard set.
- `src/renderer/src/components/AndroidCanvas.tsx`: decode backpressure.
- `tests/unit/androidInstance.test.ts`: concurrent-start race test.

## Acceptance check

- `tsc` main + renderer clean; `npm run build` ok (prior lane).
- Full `npm test`: 197 files / 1791 passed (+1 new), 12 skipped.
- `sbom:verify` ok; `cargo test` 58/58.
- Live guard race: `rejected UNKNOWN` (winner, spawn fail) +
  `rejected ERR_ANDROID_ALREADY_STARTING` (loser) — serialization
  proven outside the test too.
- No release made (verify-only lane unless user says release).
