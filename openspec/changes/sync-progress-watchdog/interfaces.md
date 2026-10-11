# sync-progress-watchdog — Interfaces

## Owner map
| Area | Owner | Files |
|------|-------|-------|
| Backend | fixer | `src/main/cloud/fetchWithTimeout.ts` (new), `gdriveTransfer.ts`, `gdriveClient.ts`, `gdriveResumable.ts`, `gdriveSync.ts` |
| UI | designer | `src/renderer/src/pages/CloudSync.tsx`, `src/renderer/src/api.ts`, `src/renderer/src/i18n.tsx` |

Disjoint except `api.ts` status shape (additive fields — coordinate field names first).

## New contracts
- `fetchWithTimeout(url, init?, ms?): Promise<Response>` — AbortSignal timeout, default 60s, 300s for uploads/downloads. Error message names the timeout.
- `SyncPhase = 'idle'|'inspecting'|'applying'|'committing'|'verifying'|'mirror'`. Engine sets it; `runCycle` transitions at each boundary.
- `SyncStatus += { phase: SyncPhase; syncStartedAt: number|null; stuck: boolean }`. `stuck = syncing && Date.now()-syncStartedAt > STUCK_CEILING_MS` (5 min).
- `GDriveStatusData += { phase?; syncStartedAt?; stuck? }` (optional — old backend compat).
- Sync now UI: after HTTP 200, poll `cloudGdriveStatus` every 1.5s until `syncing===false` (cap 10 min), then notice from `lastError` (null → success) + refresh log.

## Boundaries (unchanged)
- No merge/encryption/protocol/payload changes. No new endpoints. No cycle-cancel API.
