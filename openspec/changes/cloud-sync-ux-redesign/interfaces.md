# cloud-sync-ux-redesign — Interfaces

## Owner map
| Area | Owner | Files |
|------|-------|-------|
| DB migration | fixer | `src/main/db/schema.ts` |
| Connected UI | designer | `src/renderer/src/pages/CloudSync.tsx` |
| Strings | designer | `src/renderer/src/i18n.tsx` |

## Boundaries (unchanged)
- `api.ts` gdrive calls: `cloudGdriveStatus/SyncNow/Verify/Log/ChangePassphrase`, `gdriveInspectPull/Pull/Push/Disconnect`, `cloudGdriveMirrorEnable/Run`. No new endpoints, no signature changes.
- Status fields consumed: `connected, account/userEmail, unlocked, syncing, lastSyncAt, folderName, conflicts, lastError, mirrorEnabled, pendingRemoteChanges`.
- Engine: `gdriveSync`/`gdriveTransfer` untouched. Sync behavior identical; only presentation + one migration.

## New UI contracts
- `Advanced disclosure`: `<details>`-style collapsible, default closed, contains Verify, Check-updates, Pull, Push, Sync Log, Mirror block.
- `ConfirmDialog(props: {title, body, confirmLabel, onConfirm, onCancel})`: local component in CloudSync.tsx; used by Disconnect, Pull, Push.
- `HumanError(props: {raw: string, onRetry})`: maps known technical errors to sentences (fallback: generic sentence + raw in Details).
