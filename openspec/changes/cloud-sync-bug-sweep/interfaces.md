# cloud-sync-bug-sweep — Interfaces

## Owner map
| Area | Owner | Files |
|------|-------|-------|
| Backend fixes | fixer | `src/main/cloud/gdriveSync.ts`, `gdriveAuth.ts`, `gdriveClient.ts`, `gdriveFullMirror.ts` |
| UI fixes | designer | `src/renderer/src/pages/CloudSync.tsx`, `src/renderer/src/i18n.tsx` |

## Boundaries (unchanged)
- No API shape changes except where the UI already expects a shape the backend does not send
  (R03: render backend shape, do NOT change the backend payload — cross-machine compat).
- No sync protocol/payload changes. `SyncCycleResult`, `PullInspection`, `ConflictItem` wire shapes frozen.
- `api.ts` client: no new endpoints (cancel endpoint already exists: `cloudGdriveAuthorizeCancel`).

## New contracts
- `getCachedAccessToken` expiry: `expires_in` missing → 3600s default.
- `getGDriveStatus().connected`: false after grant purge (R05/R06).
- Conflict row render: `{table, key}` + hashes in `<details>` (R03).
