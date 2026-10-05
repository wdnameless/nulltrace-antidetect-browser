# Interfaces — two-way Google Drive sync

Boundaries, signatures and owners. Every public symbol listed here is exported from the named file
and nowhere else.

## 1. Write-notification chokepoints

Every write in the app already funnels through two places. They gain a listener so the sync engine
can react to a change without any call site being edited.

**Owner: `src/main/db/index.ts`**

```ts
export type DbWriteListener = () => void;

/** Subscribe to database mutations. Returns an unsubscribe function. */
export function onDbWrite(fn: DbWriteListener): () => void;

/**
 * Silence write notifications while the sync engine applies remote rows, so a pull cannot
 * schedule the push it just caused. Reference-counted: nested suppress/resume pairs are safe.
 */
export function pushWriteSuppression(): void;
export function popWriteSuppression(): void;
```

Fires from `Statement.run` when `changes > 0`, and from `exec`. Never from `get`/`all`.

**Owner: `src/main/config.ts`**

```ts
export function onSettingsWrite(fn: () => void): () => void;
export function pushSettingsWriteSuppression(): void;
export function popSettingsWriteSuppression(): void;

/** Every persisted setting except these travels between machines. */
export const SETTINGS_SYNC_DENYLIST: readonly string[];

/** Portable projection of settings.json, denylist applied. */
export function exportSyncableSettings(): Record<string, unknown>;

/** Merge a remote settings object in, denylist applied. Machine-local keys are never touched. */
export function importSyncableSettings(remote: Record<string, unknown>): number;
```

Denylist must cover at minimum: `dataDir`, `dataMode`, `syncPassphraseVerifier`, every `gdrive:`
key, anything holding a token/secret, and any port/host binding.

## 2. Sync log

**Owner: `src/main/db/schema.ts`** — new table, additive:

```sql
CREATE TABLE IF NOT EXISTS sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  direction    TEXT    NOT NULL,          -- 'push' | 'pull' | 'merge' | 'mirror' | 'error'
  outcome      TEXT    NOT NULL,          -- 'ok' | 'failed'
  rows_pushed  INTEGER NOT NULL DEFAULT 0,
  rows_pulled  INTEGER NOT NULL DEFAULT 0,
  conflicts    INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
```

**Owner: `src/main/cloud/gdriveSync.ts`**

```ts
export interface SyncLogEntry {
  id: number;
  at: number;
  direction: string;
  outcome: string;
  rowsPushed: number;
  rowsPulled: number;
  conflicts: number;
  error: string | null;
}
export function getSyncLog(limit?: number): SyncLogEntry[];
```

## 3. Entity layer

**Owner: `src/main/cloud/syncEntities.ts`** (new)

```ts
export interface EntityCodec {
  /** Stored row → portable form (secrets revealed). */
  decode(row: Record<string, unknown>): Record<string, unknown>;
  /** Portable form → stored column values (secrets re-protected). */
  encode(portable: Record<string, unknown>): Record<string, unknown>;
}

export interface EntityTable {
  table: string;
  /** Primary key columns, in order. A composite key is joined with U+0000. */
  pk: readonly string[];
  /** Columns carried between machines. */
  columns: readonly string[];
  codec?: EntityCodec;
  /** Order tables are applied in; a profile must land after the rows it points at. */
  order: number;
}

export const SYNC_TABLES: readonly EntityTable[];

export function rowKey(pk: readonly string[], row: Record<string, unknown>): string;
export function stableStringify(value: unknown): string;
export function hashRow(row: Record<string, unknown>, columns: readonly string[]): string;
export function dumpTable(spec: EntityTable): Array<Record<string, unknown>>;
export function applyRow(spec: EntityTable, portable: Record<string, unknown>): void;
```

Tables carried: `devices`, `groups`, `proxies`, `fingerprints`, `extensions`, `tags`, `profile_tags`,
`profile_extensions`, `triggers`, `scripts`, `profiles`, `account_credentials`, `global_keys`.
Never carried: `sync_sessions`, `script_runs`, `proxy_usage`, `preserved_browser_data`,
`task_runs`, `task_logs`.

`profiles.deleted_at` IS carried — a deleted profile travels as a row with a delete stamp, which is
what makes deletion propagate instead of resurrecting.

## 4. Merge layer

**Owner: `src/main/cloud/syncMerge.ts`** (new)

```ts
export type MergeResolution = 'keep_local' | 'overwrite_remote';

export interface MergeConflict {
  table: string;
  key: string;
  localHash: string;
  remoteHash: string;
}

export interface MergeResult {
  /** Rows that must be written locally (already merged). */
  rows: Array<{ table: string; portable: Record<string, unknown> }>;
  /** Rows that must be removed locally. */
  deletes: Array<{ table: string; key: string }>;
  /** What the next push must contain: merged rows plus tombstones. */
  outgoing: Record<string, Record<string, unknown>>;
  conflicts: MergeConflict[];
  counts: { pulled: number; pushed: number; deleted: number };
}

export function mergeTables(args: {
  tables: readonly EntityTable[];
  local: Record<string, Record<string, Record<string, unknown>>>;
  base: Record<string, Record<string, string>> | null;
  remote: Record<string, Record<string, Record<string, unknown>>> | null;
  tombstones: Record<string, Record<string, number>>;
  resolution: MergeResolution;
}): MergeResult;

export function loadBaseSnapshot(): Record<string, Record<string, string>> | null;
export function saveBaseSnapshot(base: Record<string, Record<string, string>>): void;
export function recordTombstones(out: MergeResult): void;
```

Merge rules, per row: unchanged-local+changed-remote → apply remote; changed-local+unchanged-remote →
push local; both-changed-equal → nothing; both-changed-differing → conflict, `keep_local` keeps and
pushes the local value, `overwrite_remote` applies the remote one; present-in-base+absent-locally →
tombstone; present-in-base+absent-remotely → delete locally.

Base snapshot lives at `<DATA_DIR>/gdrive-sync-base.json`, not in settings.json: it is machine state,
not user data, and must never be pushed.

## 5. Transport + folder

**Owner: `src/main/cloud/gdriveTransfer.ts`** (rewrite of push/pull, transport unchanged in shape)

```ts
export const GDRIVE_FOLDER_NAME: string;         // 'nulltrace data'
export const LEGACY_GDRIVE_FOLDER_NAME: string;  // 'NullTrace_Sync'
export const GDRIVE_MANIFEST_FILE: string;      // 'manifest.json'
export const GDRIVE_MIRROR_FILE: string;        // 'profiles-full.tar.gz'

export interface GDriveManifest {
  version: number;
  app: 'nulltrace';
  exportedAt: number;
  deviceId: string;
  /** Revision file name inside the sync folder. */
  stateFile: string;
  /** SHA-256 of the sealed state file. */
  digest: string;
  counts: Record<string, number>;
}

export interface FolderValidation {
  ok: boolean;
  reason?: string;
  folderId?: string;
}

/** Discover by name, adopt legacy, or create. Clears a remembered id Drive no longer knows. */
export async function ensureSyncFolder(): Promise<string>;

/** Refuse a folder holding foreign data. Never reads or writes a folder it did not create. */
export async function validateSyncFolder(folderId: string): Promise<FolderValidation>;

export async function pushToGDrive(passphrase?: string): Promise<{ timestamp: number }>;
export async function pullFromGDrive(opts?: {
  conflictResolution?: 'keep_local' | 'overwrite_remote';
  passphrase?: string;
}): Promise<{
  pulledProfiles: number; pulledScripts: number; pulledVault: number;
  appliedSettings: boolean; timestamp: number; conflicts: number;
}>;
```

Push order is load-bearing: upload `state-<ts>.bin` under a fresh name FIRST, write `manifest.json`
SECOND. A failure before the manifest leaves the previous revision intact. After the manifest lands,
state files other than the current one and the immediately previous one are pruned.

`uploadFile` routes payloads over 5 MB through `uploadResumable` from `./gdriveResumable`.

## 6. Engine

**Owner: `src/main/cloud/gdriveSync.ts`**

```ts
export type SyncTrigger = 'launch' | 'change' | 'timer' | 'exit' | 'manual';

export interface SyncStatus {
  connected: boolean;
  account: string | null;
  unlocked: boolean;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  pendingRemoteChanges: number;
  conflicts: number;
  mirrorEnabled: boolean;
  folderName: string | null;
  lastVerifiedAt: number | null;
}

export function getSyncStatus(): SyncStatus;
export function requestSync(reason: SyncTrigger): Promise<void> | void;
export function startSyncEngine(): void;
export function stopSyncEngine(): void;
export function clearSyncSession(): void;
export function unlockSession(passphrase: string): Promise<boolean>;
export function getSyncLog(limit?: number): SyncLogEntry[];

/** Rotate the sync passphrase: verifies the old one, then pushes a fresh revision under the new. */
export function changePassphrase(current: string, next: string): Promise<{ changed: boolean; reason?: string }>;

/** Re-download the committed revision and check its digest. */
export function verifyRemoteState(): Promise<{ ok: boolean; revision: string; reason?: string }>;
```

The engine subscribes to `onDbWrite` and `onSettingsWrite` at `startSyncEngine`, debounces 3 s, and
requests a `'change'` sync. Writes made under `pushWriteSuppression` do not fire.

Mirror is two-way and driven by the engine, not by a manual route only: when enabled, a push uploads
the archive through the resumable transport, and a pull restores any remote archive newer than the
last local restore.

## 7. HTTP

**Owner: `src/main/api/routes/cloud.ts`** — existing routes keep their shapes. Additive:

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/v1/cloud/gdrive/log` | — | `{ entries: SyncLogEntry[] }` |
| POST | `/api/v1/cloud/gdrive/passphrase` | `{ current, next }` | `{ changed: true }` or 400 `BAD_PASSPHRASE` |
| POST | `/api/v1/cloud/gdrive/verify` | — | `{ ok, revision, reason? }` |
| POST | `/api/v1/cloud/gdrive/mirror/pull` | — | `{ restoredProfiles, fileCount }` or 400 |

`/gdrive/status` gains `conflicts`, `folderName`, `lastVerifiedAt`. All other fields unchanged.

## 8. Renderer

**Owner: `src/renderer/src/api.ts`** — adds `cloudGdriveLog`, `cloudGdriveChangePassphrase`,
`cloudGdriveVerify`, `cloudGdriveMirrorPull`; `GDriveStatusData` gains the three new status fields.

**Owner: `src/renderer/src/pages/CloudSync.tsx`** — sync log panel, verify button, passphrase change
dialog, conflict count surfaced next to "Sync now".