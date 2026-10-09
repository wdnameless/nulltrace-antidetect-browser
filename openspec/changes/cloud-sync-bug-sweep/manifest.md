# Manifest: Cloud Sync bug sweep (verified bugs only)

## User quotes (verbatim)
- "делай и пощищи други баги"
- "Вроде законнектилась, но это все выглядит очень страшно." (prior turn, fixed by redesign)

## Audit method
Three read-only scout slices audited engine/routes/UI (43 raw claims). Every claim below was
re-verified against the code by the orchestrator; speculative races and unproven merge-logic
claims were rejected without a repro. Only confirmed behavior bugs are listed.

## Requirements (verified bugs)
| ID | Bug | Evidence |
|----|-----|----------|
| R01 | `startSyncEngine` unconditionally clears `lastError`, erasing the real authorize failure (seen live: "not connected" overwrote the exchange error) | `gdriveSync.ts:577` |
| R02 | Auth-status poll picks up a stale `lastError` on its first tick and kills a live OAuth attempt | `CloudSync.tsx:300` |
| R03 | Conflict inspection crashes React: backend sends `{table,key,localHash,remoteHash}`, UI reads `c.type.toUpperCase()` | `gdriveTransfer.ts:807` vs `CloudSync.tsx:1590` |
| R04 | `setCachedAccessToken` with missing `expires_in` yields NaN expiry → stale token served forever | `gdriveClient.ts:291`, `gdriveAuth.ts:190` |
| R05 | Refresh rejection (`invalid_grant`) leaves the dead refresh token; status lies `connected=true` | `gdriveClient.ts:293` |
| R06 | Saving new OAuth credentials keeps the previous client's refresh token | `gdriveAuth.ts:97` (`saveGDriveCredentials`) |
| R07 | Disconnect leaves `folderId`+`email` → cross-account folder errors on reconnect | `gdriveAuth.ts:244` |
| R08 | Mirror download utf8-fallback corrupts binary gzip when `downloadBuffer` is absent | `gdriveFullMirror.ts:110` |
| R09 | `stopSyncEngine` leaves `queuedTrigger`/`inFlightPromise` → trailing cycle after shutdown | `gdriveSync.ts:500` area |
| R10 | `unlockSession` fires `startSyncEngine` + `requestSync('launch')` → duplicate back-to-back syncs | `gdriveSync.ts:324` |
| R11 | Auth poll interval leaks on unmount; progress state has no Cancel (backend stuck in 409) | `CloudSync.tsx:287`, `:1029` |
| R12 | Sync now + Advanced actions enabled while locked/syncing → instant failures | `CloudSync.tsx:1165`, `:1243` |
| R13 | OUT: speculative remote-commit races, merge tombstone redesign, transaction wrapping, cancel-interleave rework | rejected without repro |

## Constraints
- Same engine semantics; no protocol/payload changes (cross-machine compat).
- Must not break: cloud suite, noir guard, i18n, typecheck.
- Every fix needs a regression test or a stated reason why it cannot be unit-tested.

## Success criteria
- Each R01-R12 has a fix + test (or stated reason) and the targeted suites pass.
- v0.6.62 CI green, release published.
