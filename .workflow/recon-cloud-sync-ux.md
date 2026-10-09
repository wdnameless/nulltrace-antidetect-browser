# Recon: cloud sync crash fix + UX redesign

## Root cause (R01)
Sync reads `launch_args` from `profile_extensions` (syncEntities.ts:214), the column exists
in fresh-schema CREATE TABLE, but no `ensureColumn` migration adds it to pre-existing DBs —
`CREATE TABLE IF NOT EXISTS` never touches them. Old DBs crashed every cycle.

## Files touched
- `src/main/db/schema.ts` — allowlisted `profile_extensions`, added
  `ensureColumn(db, 'profile_extensions', 'launch_args', 'TEXT')`.
- `tests/unit/schemaColumns.test.ts` — old-schema fixture gains the column on `migrate()`,
  sync-style SELECT succeeds.
- `src/renderer/src/pages/CloudSync.tsx` — connected-state redesign:
  - R02: 6-cell grid + 8-button bar → one status card (● Connected · account · Last Synced ·
    conflicts) + one primary Sync now button.
  - R03: Verify/Check/Pull/Push/Log/Change/Disconnect inside collapsed `<details> Advanced`.
  - R04: Disconnect/Pull/Push via `openConfirm` + shared `Modal` (title + consequences +
    Cancel/Confirm). Passphrase flow already two-step, untouched.
  - R05: raw `lastError` → human sentence (`getHumanSyncErrorMessage`: schema/locked/
    auth/network/fallback) + Details disclosure (raw) + Retry (Sync now).
  - R06: Chromium Mirror block moved inside Advanced.
- `src/renderer/src/i18n.tsx` — EN/RU strings for card, Advanced, confirms, human errors.

## Acceptance check
- `npx tsc -p src/renderer/tsconfig.json --noEmit` → clean.
- `vitest schemaColumns + gdrive + noirTokens + cloud` → 10 files, 94/94 pass.
- Main tsc + full suite deferred to release CI (tag run).
- Visual check: NOT verifiable here (no running app in this session) — oracle reviews code.
