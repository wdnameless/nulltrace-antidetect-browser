# sync-progress-watchdog — Proposal

## Why
On 0.6.65, Sync now spins "Syncing..." forever with no Sync Log row and no data movement,
while the page simultaneously claims "Sync completed successfully". Root causes, all
verified in code: (1) zero timeouts on any Google fetch — a stalled socket hangs the
cycle forever with `isSyncing` stuck true; (2) no progress reporting — the UI only knows
a boolean; (3) the Sync now handler reports success when the HTTP request returns, but
`requestSync` resolves without awaiting the cycle.

## What changes
1. **Timeouts (R01):** a shared `fetchWithTimeout` wrapper (generous ceilings) used by
   the Drive transport, OAuth client, and resumable upload.
2. **Watchdog (R02):** `syncStartedAt` tracked per cycle; status reports `stuck: true`
   when a cycle exceeds the ceiling; UI renders "appears stuck, will time out" instead
   of an eternal spinner.
3. **Progress (R03):** `SyncStatus` gains `phase` + `syncStartedAt`; engine sets phase at
   inspect/apply/commit/verify/mirror boundaries; UI polls status during sync and shows
   phase + elapsed time.
4. **Honest notice (R04):** Sync now polls until `syncing` flips false, then reports the
   real outcome from `lastError`/log.

## Alternatives considered
- Byte-level upload progress: rejected — resumable sessions could report it, but multipart
  (the common path under 5 MB) cannot; phase + elapsed covers the need.
- Cancelling stuck cycles mid-flight: rejected — aborting a commit risks half-written
  revisions; timeouts + watchdog fail loudly and safely instead.
