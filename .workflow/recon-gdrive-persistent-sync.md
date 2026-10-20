# Recon — Google Drive: persistent connection + per-device sync switch

## Measured defect (live)
`GET /api/v1/cloud/gdrive/status` on the running 0.6.72 app answered
`{"configured":true,"connected":false,...}` — the UI renders "[CONFIGURED / DISCONNECTED]",
exactly the badge in the report.

Root cause: `src/main/cloud/gdriveAuth.ts` kept all state in `DefaultInMemoryStorage` (a `Map`),
and **nothing in production ever called `setGDriveStorage`**. `saveGDriveRefreshToken` therefore
wrote into a Map that died with the process, so `getGDriveStatus().connected` was `false` on every
launch — and `startSyncEngine()` / `runCycle()` both gate on that flag, so sync never armed either.

## Changes
1. `gdriveAuth.ts`
   - New default adapter `createSettingsGDriveStorage()` over `settings.json`
     (`getSetting`/`setSetting`/`tryWriteSettings`). Keys are already in
     `SETTINGS_SYNC_DENYLIST` and `isDenylistedSetting` blocks `gdrive:*`, so a refresh token
     never travels to another machine.
   - Deleted the now-unused `DefaultInMemoryStorage` class.
   - `GDriveStatus.syncEnabled` + `isGDriveSyncEnabled()` / `setGDriveSyncEnabled()`
     (key `gdrive:syncEnabled`, default ON).
2. `gdriveSync.ts` — `runCycle` returns early (no error) when the device switch is off, so the
   connection stays valid and this machine simply stops syncing.
3. `routes/cloud.ts`
   - `POST /api/v1/cloud/gdrive/sync-enabled {enabled}` — starts/stops the engine for this device.
   - `disconnect` now also calls `stopSyncEngine()` (it previously left the timer and the
     db/settings subscriptions armed).
4. Renderer
   - `CloudSync.tsx`: visible per-device checkbox "Sync on this device: On/Paused" with a
     tooltip stating it does NOT disconnect other devices, plus an explicit "Disconnect" button
     that says it removes the connection everywhere.
   - `api.ts`: `cloudGdriveSetSyncEnabled()` + `syncEnabled` on `GDriveStatusData`.
   - `i18n.tsx`: EN + RU strings.

## Verification
- `npx vitest run tests/unit/cloud tests/unit/gdrive.test.ts` → 11 files / 109 tests pass.
- New `tests/unit/cloud/gdrivePersistence.test.ts` (6 tests): token persists through the adapter,
  pausing preserves the refresh token, resuming restores it, status reports `syncEnabled`.
- `tsc -p tsconfig.main.json` and `tsc -p src/renderer/tsconfig.json` → 0 errors.
- `npm run build:renderer` → built.

## Acceptance check
After install: reload CloudSync → badge shows `[CONNECTED] <email>` after one connect, survives
an app restart; the checkbox toggles without dropping the connection; `GET /status` returns
`syncEnabled` and `connected:true`.
