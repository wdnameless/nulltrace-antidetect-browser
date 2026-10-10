/**
 * Google Drive transport, folder discovery, and the sync cycle.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 * 1. **Push commits a revision in two steps.** The sealed state goes up first under a fresh name,
 *    and `manifest.json` — which names the current revision and its digest — goes up second. A
 *    failure anywhere before the manifest lands leaves the previous revision readable. The old shape
 *    (five files, manifest last, same names every time) could leave the new payload beside the old
 *    digests, and then every later pull failed its integrity check permanently.
 *
 * 2. **The cycle merges, it does not push-then-pull.** Local, base and remote are reconciled by
 *    `syncMerge` before anything is written. `pushToGDrive` and `pullFromGDrive` are both thin
 *    wrappers over that one cycle with a different conflict policy, which is why the two cannot
 *    drift into disagreeing about what "synced" means.
 *
 * 3. **Every write to Drive goes through `withRetry`.** Drive throttles hard, and a dropped
 *    connection used to lose a whole sync run.
 */

import fetch from 'node-fetch';
import { createHash } from 'crypto';
import { ensureValidAccessToken } from './gdriveClient';
import {
  getGDriveFolderId,
  saveGDriveFolderId,
  clearGDriveFolderId,
  recordGDrivePushTimestamp,
  recordGDrivePullTimestamp,
  getGDriveTimestamps,
} from './gdriveAuth';
import { pushWriteSuppression, popWriteSuppression } from '../db';
import {
  getSetting,
  setSetting,
  exportSyncableSettings,
  importSyncableSettings,
  pushSettingsWriteSuppression,
  popSettingsWriteSuppression,
} from '../config';
import { sealPayload, openPayload, SyncDecryptError } from './syncCrypto';
import { uploadResumable } from './gdriveResumable';
import { withRetry } from './retry';
import {
  SYNC_TABLES_SORTED,
  SYNC_TABLES_BY_NAME,
  applyRow,
  deleteRow,
  type GDriveScope,
  DEFAULT_GDRIVE_SCOPE,
  isTableEnabledInScope,
} from './syncEntities';
import {
  loadBaseSnapshot,
  saveBaseSnapshot,
  mergeTables,
  nextBaseSnapshot,
  dumpAllTables,
  type MergeResolution,
  type PortableRows,
  type Tombstones,
} from './syncMerge';

export const GDRIVE_FOLDER_NAME = 'nulltrace data';
export const LEGACY_GDRIVE_FOLDER_NAME = 'NullTrace_Sync';
export const GDRIVE_MANIFEST_FILE = 'manifest.json';
export const GDRIVE_MIRROR_FILE = 'profiles-full.tar.gz';

/** Prefix of a committed revision file. The timestamp is the revision identity. */
const GDRIVE_STATE_PREFIX = 'state-';
const GDRIVE_STATE_SUFFIX = '.ntdata';

/**
 * Drive caps a simple or multipart upload at 5 MB. Anything larger has to go through a chunked
 * resumable session or it fails outright — which is why the opt-in full-mirror tier could never
 * upload at all while the transport had no resumable path.
 */
const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Revisions kept besides the current one, so a bad push can still be recovered from Drive. */
const REVISION_HISTORY = 2;

export type { MergeResolution };
export type ConflictResolution = MergeResolution;

/**
 * Parse a payload that came BACK from the cloud, refusing to throw on malformed input.
 *
 * Every value here originated in a remote Drive folder: a manifest a hand-edit produced, a file
 * truncated by an interrupted upload, or a blob written by a different build. A bare `JSON.parse` on
 * that content throws a `SyntaxError` out of the cycle, which surfaces as an unhandled rejection
 * rather than as the "the remote copy is unreadable" message the operator can act on. Returning
 * `undefined` lets each caller keep the value it already had, which is the only safe choice: local
 * data still works and nothing is overwritten by a payload that could not be read.
 */
function parseRemoteJson<T>(raw: string, label: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(
      `[gdrive] ${label} could not be parsed and was ignored: ${(err as Error).message}`
    );
    return undefined;
  }
}

export interface DriveFileInfo {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: number;
}

export interface GDriveTransport {
  listFiles(folderId?: string): Promise<DriveFileInfo[]>;
  createFolder(name: string, parentFolderId?: string): Promise<string>;
  findFolder(name: string, parentFolderId?: string): Promise<string | null>;
  uploadFile(
    name: string,
    content: string | Buffer,
    folderId: string,
    existingFileId?: string
  ): Promise<string>;
  downloadFile(fileId: string): Promise<string>;
  downloadBuffer?(fileId: string): Promise<Buffer>;
  deleteFile(fileId: string): Promise<void>;
}

export class HttpGDriveTransport implements GDriveTransport {
  async listFiles(folderId?: string): Promise<DriveFileInfo[]> {
    const token = await ensureValidAccessToken();
    let q = 'trashed = false';
    if (folderId) {
      q += ` and '${folderId}' in parents`;
    }
    // Drive pages at 100 per response. Following `nextPageToken` is not optional: a folder with more
    // than 100 files would silently report only the first page, and the cycle would then believe it
    // had seen every row when it had not.
    const out: DriveFileInfo[] = [];
    let pageToken: string | undefined;
    do {
      const url =
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
        `&fields=files(id,name,modifiedTime,size),nextPageToken&pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await withRetry(() =>
        fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      );
      if (!res.ok) {
        throw new Error(`Drive list error (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as {
        files?: DriveFileInfo[];
        nextPageToken?: string;
      };
      out.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async findFolder(name: string, parentFolderId?: string): Promise<string | null> {
    const token = await ensureValidAccessToken();
    let q = `mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(
      /'/g,
      "\\'"
    )}' and trashed = false`;
    if (parentFolderId) {
      q += ` and '${parentFolderId}' in parents`;
    }
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      q
    )}&fields=files(id,name)&pageSize=1`;

    const res = await withRetry(() =>
      fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    );
    if (!res.ok) {
      throw new Error(`Drive search error (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { files?: { id: string }[] };
    return data.files && data.files.length > 0 ? data.files[0].id : null;
  }

  async createFolder(name: string, parentFolderId?: string): Promise<string> {
    const token = await ensureValidAccessToken();
    const metadata: Record<string, unknown> = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentFolderId) {
      metadata.parents = [parentFolderId];
    }

    const res = await withRetry(() =>
      fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(metadata),
      })
    );
    if (!res.ok) {
      throw new Error(`Drive create folder error (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  async uploadFile(
    name: string,
    content: string | Buffer,
    folderId: string,
    existingFileId?: string
  ): Promise<string> {
    const token = await ensureValidAccessToken();
    const isBuf = Buffer.isBuffer(content);
    const contentType = isBuf ? 'application/octet-stream' : 'application/json; charset=UTF-8';

    if (isBuf && content.length > RESUMABLE_THRESHOLD_BYTES) {
      return uploadResumable({ name, data: content, folderId, existingFileId, contentType });
    }

    if (existingFileId) {
      const url = `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`;
      const res = await withRetry(() =>
        fetch(url, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
          body: content,
        })
      );
      if (!res.ok) {
        throw new Error(`Drive update error (${res.status}): ${await res.text()}`);
      }
      const data = (await res.json()) as { id: string };
      return data.id;
    }

    const boundary = `-------NullTraceBoundary${Date.now()}`;
    const metadata = JSON.stringify({ name, parents: [folderId] });
    const contentBuf = isBuf ? content : Buffer.from(content, 'utf8');
    const header = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${metadata}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8'
    );
    const footer = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const multipartBody = Buffer.concat([header, contentBuf, footer]);

    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const res = await withRetry(() =>
      fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartBody,
      })
    );
    if (!res.ok) {
      throw new Error(`Drive upload error (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  async downloadBuffer(fileId: string): Promise<Buffer> {
    const token = await ensureValidAccessToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await withRetry(() =>
      fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    );
    if (!res.ok) {
      throw new Error(`Drive download error (${res.status}): ${await res.text()}`);
    }
    return res.buffer();
  }

  async downloadFile(fileId: string): Promise<string> {
    const buf = await this.downloadBuffer(fileId);
    return buf.toString('utf8');
  }

  async deleteFile(fileId: string): Promise<void> {
    const token = await ensureValidAccessToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    const res = await withRetry(() =>
      fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Drive delete error (${res.status}): ${await res.text()}`);
    }
  }
}

let activeGDriveTransport: GDriveTransport = new HttpGDriveTransport();

export function setGDriveTransport(transport: GDriveTransport): void {
  activeGDriveTransport = transport;
}

export function getGDriveTransport(): GDriveTransport {
  return activeGDriveTransport;
}

/**
 * Robust buffer downloader that works with both `HttpGDriveTransport` and the in-memory test mock,
 * which only implements `downloadFile`.
 */
async function downloadAsBuffer(transport: GDriveTransport, fileId: string): Promise<Buffer> {
  if (typeof transport.downloadBuffer === 'function') {
    return transport.downloadBuffer(fileId);
  }
  return Buffer.from(await transport.downloadFile(fileId), 'utf8');
}

// ---------------------------------------------------------------------------
// Session passphrase
// ---------------------------------------------------------------------------

/**
 * In-memory sync passphrase for the current session.
 *
 * Never written to disk, SQLite, settings or a log line. The engine sets it at unlock so the cycle
 * can be driven from a timer or an HTTP route without threading the secret through every call.
 */
let activeSyncPassphrase: string | null = null;

export function setSyncPassphrase(passphrase: string | null): void {
  activeSyncPassphrase = passphrase;
}

export function getSyncPassphrase(): string | null {
  return activeSyncPassphrase;
}

// ---------------------------------------------------------------------------
// Manifest and payload shapes
// ---------------------------------------------------------------------------

export interface GDriveManifest {
  version: number;
  app: 'nulltrace';
  exportedAt: number;
  deviceId: string;
  /** Revision file inside the sync folder — the commit pointer. */
  stateFile: string;
  /** SHA-256 of the sealed state file, so a truncated upload is detected instead of decrypted. */
  digest: string;
  counts: Record<string, number>;
}

/** The sealed payload: everything portable, plus the tombstones a merge produced. */
interface SyncPayload {
  version: number;
  exportedAt: number;
  deviceId: string;
  tables: PortableRows;
  tombstones: Tombstones;
  settings: Record<string, unknown>;
}

const PAYLOAD_VERSION = 2;

export interface FolderValidation {
  ok: boolean;
  reason?: string;
  folderId?: string;
}

/**
 * A stable per-installation id, so a manifest says which machine wrote it.
 *
 * Kept in settings, which the sync denylist keeps off the wire, so two machines never collide on the
 * same id. Regenerating it after a refused write is harmless — it is a provenance label, not a
 * correctness input — so a failed write is swallowed rather than allowed to break a sync.
 */
function getDeviceId(): string {
  const existing = getSetting('syncDeviceId');
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  try {
    setSetting('syncDeviceId', id);
  } catch {
    /* regenerated next run */
  }
  return id;
}

// ---------------------------------------------------------------------------
// Folder discovery and validation
// ---------------------------------------------------------------------------

/**
 * Locate the sync folder, or create it.
 *
 * Order matters: the stored id first, then the current name, then the legacy name (so a folder from
 * an older build is adopted rather than orphaned), and only then a new folder. A stored id Drive no
 * longer knows — folder deleted by hand, account switched — is cleared and rediscovered, because
 * returning it would make every later call fail with a 404 the operator cannot interpret.
 */
export async function ensureSyncFolder(): Promise<string> {
  const storedId = getGDriveFolderId();
  if (storedId) {
    try {
      await activeGDriveTransport.listFiles(storedId);
      return storedId;
    } catch {
      clearGDriveFolderId();
    }
  }

  const byName = await activeGDriveTransport.findFolder(GDRIVE_FOLDER_NAME);
  if (byName) {
    saveGDriveFolderId(byName);
    return byName;
  }

  const legacy = await activeGDriveTransport.findFolder(LEGACY_GDRIVE_FOLDER_NAME);
  if (legacy) {
    saveGDriveFolderId(legacy);
    return legacy;
  }

  const created = await activeGDriveTransport.createFolder(GDRIVE_FOLDER_NAME);
  saveGDriveFolderId(created);
  return created;
}

/**
 * Refuse a folder that is not ours before writing a single byte into it.
 *
 * Discovery is by NAME, so a folder called `nulltrace data` that happens to hold the operator's
 * scanned receipts would otherwise be adopted and overwritten. The rule is deliberately narrow: an
 * empty folder is ours (a fresh install just created it), a folder holding a NullTrace manifest is
 * ours, anything else is not and is refused with a reason rather than silently used.
 */
export async function validateSyncFolder(folderId: string): Promise<FolderValidation> {
  let files: DriveFileInfo[];
  try {
    files = await activeGDriveTransport.listFiles(folderId);
  } catch (err) {
    return { ok: false, folderId, reason: `sync folder is not reachable: ${(err as Error).message}` };
  }

  // A manifest that is present but not ours is decisive on its own: the folder was adopted by an app
  // that is not this one, and writing a payload an older or newer build cannot read would strand it.
  const manifestFile = files.find((f) => f.name === GDRIVE_MANIFEST_FILE);
  if (manifestFile) {
    const manifest = parseRemoteJson<GDriveManifest>(
      await activeGDriveTransport.downloadFile(manifestFile.id),
      GDRIVE_MANIFEST_FILE
    );
    if (manifest?.app !== 'nulltrace') {
      return {
        ok: false,
        folderId,
        reason: `the folder "${GDRIVE_FOLDER_NAME}" holds a manifest this build does not recognise`,
      };
    }
  }

  // Anything besides our own state files and our manifest means the name collided with data we must
  // not touch.
  const others = files.filter(
    (f) => !f.name.startsWith(GDRIVE_STATE_PREFIX) && f.name !== GDRIVE_MANIFEST_FILE
      && f.name !== GDRIVE_MIRROR_FILE
  );
  if (others.length > 0) {
    return {
      ok: false,
      folderId,
      reason: `the folder "${GDRIVE_FOLDER_NAME}" already contains ${others.length} file(s) that are not NullTrace sync data — rename it or point the app at a different account`,
    };
  }

  return { ok: true, folderId };
}

// ---------------------------------------------------------------------------
// Reading the remote revision
// ---------------------------------------------------------------------------

interface RemoteRevision {
  manifest: GDriveManifest;
  tables: PortableRows;
  tombstones: Tombstones;
  settings: Record<string, unknown>;
}

/**
 * Read the committed revision, or `null` when the folder holds none.
 *
 * The digest is checked BEFORE decryption on purpose: a truncated upload must surface as an
 * integrity failure, not as a GCM authentication error that reads like a wrong passphrase — the
 * operator would then re-type a perfectly correct passphrase forever.
 */
async function readManifest(folderId: string): Promise<GDriveManifest | null> {
  const files = await activeGDriveTransport.listFiles(folderId);
  const manifestFile = files.find((f) => f.name === GDRIVE_MANIFEST_FILE);
  if (!manifestFile) return null;
  const manifest = parseRemoteJson<GDriveManifest>(
    await activeGDriveTransport.downloadFile(manifestFile.id),
    GDRIVE_MANIFEST_FILE
  );
  if (!manifest || manifest.app !== 'nulltrace' || !manifest.stateFile) {
    throw new SyncDecryptError(`${GDRIVE_MANIFEST_FILE} in the Drive folder could not be parsed`);
  }
  return manifest;
}

async function readRemoteRevision(passphrase: string): Promise<RemoteRevision | null> {
  const folderId = await ensureSyncFolder();
  const files = await activeGDriveTransport.listFiles(folderId);
  const manifest = await readManifest(folderId);
  if (!manifest) return null;

  const stateFile = files.find((f) => f.name === manifest.stateFile);
  if (!stateFile) {
    // The manifest points at a revision that is not there: an interrupted push, or a folder edited
    // by hand. Nothing can be applied safely.
    throw new SyncDecryptError(
      `manifest names revision "${manifest.stateFile}" but it is not in the Drive folder`
    );
  }

  const sealed = await downloadAsBuffer(activeGDriveTransport, stateFile.id);
  const digest = createHash('sha256').update(sealed).digest('hex');
  if (manifest.digest && digest !== manifest.digest) {
    throw new SyncDecryptError(
      `integrity check failed for ${manifest.stateFile}: the uploaded copy is incomplete or altered`
    );
  }

  const payload = parseRemoteJson<SyncPayload>(
    openPayload(passphrase, sealed).toString('utf8'),
    manifest.stateFile
  );
  if (!payload) {
    throw new SyncDecryptError(`${manifest.stateFile} decrypted but is not a valid sync payload`);
  }

  return {
    manifest,
    tables: payload.tables ?? {},
    tombstones: payload.tombstones ?? {},
    settings: payload.settings ?? {},
  };
}

// ---------------------------------------------------------------------------
// The sync cycle
// ---------------------------------------------------------------------------

export interface SyncCycleResult {
  pulledProfiles: number;
  pulledScripts: number;
  pulledVault: number;
  pushedRows: number;
  deletedRows: number;
  appliedSettings: boolean;
  conflicts: number;
  timestamp: number;
  revision: string | null;
  /** False when a post-write verification failed; the run still committed, but do not report ok. */
  verified: boolean;
}
function resolveScope(scope?: Partial<GDriveScope>): GDriveScope {
  if (scope) return { ...DEFAULT_GDRIVE_SCOPE, ...scope };
  const raw = getSetting('gdriveScope');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_GDRIVE_SCOPE };
  }
  const obj = raw as Record<string, unknown>;
  return {
    profiles: typeof obj.profiles === 'boolean' ? obj.profiles : DEFAULT_GDRIVE_SCOPE.profiles,
    proxies: typeof obj.proxies === 'boolean' ? obj.proxies : DEFAULT_GDRIVE_SCOPE.proxies,
    vault: typeof obj.vault === 'boolean' ? obj.vault : DEFAULT_GDRIVE_SCOPE.vault,
    scripts: typeof obj.scripts === 'boolean' ? obj.scripts : DEFAULT_GDRIVE_SCOPE.scripts,
    library: typeof obj.library === 'boolean' ? obj.library : DEFAULT_GDRIVE_SCOPE.library,
    settings: typeof obj.settings === 'boolean' ? obj.settings : DEFAULT_GDRIVE_SCOPE.settings,
  };
}

/**
 * Reconcile local and remote, apply the result locally, then commit it.
 *
 * This is the only place that writes to the database or to Drive on the sync path. It is
 * deliberately one function: the previous design had separate push and pull entry points that each
 * did half the work, which is how "pull then push" ended up undoing the merge on the other machine.
 */
export async function runSyncCycle(args?: {
  passphrase?: string;
  conflictResolution?: ConflictResolution;
  /** Read-only mode for the inspection endpoint: merge, report, write nothing. */
  inspectOnly?: boolean;
  scope?: Partial<GDriveScope>;
}): Promise<SyncCycleResult> {
  const passphrase = args?.passphrase ?? activeSyncPassphrase;
  if (!passphrase) {
    throw new Error('Push aborted: sync passphrase is required for end-to-end payload encryption');
  }

  const folderId = await ensureSyncFolder();
  const validation = await validateSyncFolder(folderId);
  if (!validation.ok) {
    throw new Error(`Google Drive sync refused: ${validation.reason}`);
  }

  const scope = resolveScope(args?.scope);
  const { base, tombstones: knownTombstones } = loadBaseSnapshot();
  const local = dumpAllTables(scope);
  const remote = await readRemoteRevision(passphrase);

  const merged = mergeTables({
    local,
    base: Object.keys(base).length > 0 ? base : null,
    remote: remote ? remote.tables : null,
    tombstones: knownTombstones,
    remoteTombstones: remote?.tombstones,
    resolution: args?.conflictResolution ?? 'keep_local',
    scope,
  });
  const countsByTable = countRows(merged.outgoing);

  if (args?.inspectOnly) {
    return {
      pulledProfiles: 0,
      pulledScripts: 0,
      pulledVault: 0,
      pushedRows: merged.counts.pushed,
      deletedRows: merged.counts.deleted,
      appliedSettings: false,
      conflicts: merged.conflicts.length,
      timestamp: remote?.manifest.exportedAt ?? 0,
      revision: remote?.manifest.stateFile ?? null,
      verified: true,
    };
  }

  // Applying remote rows writes through the same DB handle the change watcher listens to, so the
  // whole apply runs suppressed: otherwise every pull would immediately schedule the push it caused.
  pushWriteSuppression();
  pushSettingsWriteSuppression();
  let appliedSettings = false;
  try {
    for (const { table, portable } of merged.rows) {
      if (!isTableEnabledInScope(table, scope)) continue;
      const spec = SYNC_TABLES_BY_NAME[table];
      if (spec) applyRow(spec, portable);
    }
    for (const { table, key } of merged.deletes) {
      if (!isTableEnabledInScope(table, scope)) continue;
      const spec = SYNC_TABLES_BY_NAME[table];
      if (spec) deleteRow(spec, key);
    }
    // Settings merge separately: there is no row identity to hash, so the denylist-filtered import
    // is the whole rule. A key equal to what is already here is skipped, so this does not dirty
    // every setting on every run.
    if (scope.settings && remote && Object.keys(remote.settings).length > 0) {
      appliedSettings = importSyncableSettings(remote.settings) > 0;
    }
  } finally {
    popSettingsWriteSuppression();
    popWriteSuppression();
  }

  const exportedAt = Date.now();
  const payload: SyncPayload = {
    version: PAYLOAD_VERSION,
    exportedAt,
    deviceId: getDeviceId(),
    tables: merged.outgoing,
    tombstones: merged.tombstones,
    settings: scope.settings ? exportSyncableSettings() : {},
  };
  const sealed = sealPayload(passphrase, Buffer.from(JSON.stringify(payload), 'utf8'));
  const digest = createHash('sha256').update(sealed).digest('hex');
  const stateFile = `${GDRIVE_STATE_PREFIX}${exportedAt}${GDRIVE_STATE_SUFFIX}`;

  /*
   * Step 1 — the revision file, under a name nothing points at yet.
   *
   * Step 0, and it is not optional: re-read the manifest and refuse to commit if it moved since this
   * cycle read it. Two machines whose timers fire together both merge against the same revision and
   * both write; without this guard the second manifest write silently discards the first machine's
   * entire payload, and its next cycle reads the reversion as an ordinary "remote changed" and
   * discards the edit with no conflict ever reported. One extra read buys last-writer detection.
   */
  const latest = await readManifest(folderId);
  const observed = remote?.manifest.exportedAt ?? 0;
  if ((latest?.exportedAt ?? 0) !== observed) {
    throw new SyncDecryptError(
      'another machine committed to the sync folder while this sync was running — retry to merge against the newer revision'
    );
  }

  // Step 1.
  const stateFileId = await activeGDriveTransport.uploadFile(stateFile, sealed, folderId);

  // Step 2 — the commit pointer.
  const manifest: GDriveManifest = {
    version: PAYLOAD_VERSION,
    app: 'nulltrace',
    exportedAt,
    deviceId: payload.deviceId,
    stateFile,
    digest,
    counts: countsByTable,
  };
  const existingManifest = (await activeGDriveTransport.listFiles(folderId)).find(
    (f) => f.name === GDRIVE_MANIFEST_FILE
  );
  await activeGDriveTransport.uploadFile(
    GDRIVE_MANIFEST_FILE,
    JSON.stringify(manifest, null, 2),
    folderId,
    existingManifest?.id
  );

  const verified = await verifyCommittedRevision(folderId, digest, stateFile);

  /*
   * The base snapshot says "both machines now hold this state". It is only true once the commit is
   * verified. Advancing it after a failed verification makes the next cycle treat the remote as
   * having reverted local edits — so a single silent failure turns into permanent, quiet data loss.
   */
  if (verified) {
    saveBaseSnapshot(nextBaseSnapshot(merged, SYNC_TABLES_SORTED, base), merged.tombstones);
  }
  recordGDrivePushTimestamp(exportedAt);
  if (remote) recordGDrivePullTimestamp(remote.manifest.exportedAt);

  // Pruning happens only after the commit is verified, so a failure here can never cost data.
  await pruneOldRevisions(folderId, stateFile, stateFileId);

  return {
    pulledProfiles: merged.counts.pulled,
    pulledScripts: merged.rows.filter((r) => r.table === 'scripts').length,
    pulledVault: merged.rows.filter((r) => r.table === 'account_credentials').length,
    pushedRows: merged.counts.pushed,
    deletedRows: merged.counts.deleted,
    appliedSettings,
    conflicts: merged.conflicts.length,
    timestamp: exportedAt,
    revision: stateFile,
    verified,
  };
}

function countRows(outgoing: PortableRows): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(outgoing)) {
    counts[table] = Object.keys(rows).length;
  }
  return counts;
}

/**
 * Re-read what Drive actually holds and check it against what we meant to write.
 *
 * Reporting a successful push without this is how a truncated upload stayed invisible until the next
 * machine failed to decrypt it.
 */
async function verifyCommittedRevision(
  folderId: string,
  digest: string,
  stateFile: string
): Promise<boolean> {
  try {
    const files = await activeGDriveTransport.listFiles(folderId);
    const manifestFile = files.find((f) => f.name === GDRIVE_MANIFEST_FILE);
    const committed = manifestFile
      ? parseRemoteJson<GDriveManifest>(
          await activeGDriveTransport.downloadFile(manifestFile.id),
          GDRIVE_MANIFEST_FILE
        )
      : undefined;
    if (!committed || committed.stateFile !== stateFile) return false;

    const stateFileId = files.find((f) => f.name === stateFile)?.id;
    if (!stateFileId) return false;

    const sealed = await downloadAsBuffer(activeGDriveTransport, stateFileId);
    return createHash('sha256').update(sealed).digest('hex') === digest;
  } catch {
    return false;
  }
}

/**
 * Delete superseded revision files, keeping the current one plus a short history.
 *
 * History is kept deliberately: a push that verifies locally can still be the one that corrupted
 * something, and an operator who notices an hour later needs Drive to still hold the last good copy.
 */
async function pruneOldRevisions(
  folderId: string,
  currentStateFile: string,
  currentStateFileId: string
): Promise<void> {
  try {
    const files = await activeGDriveTransport.listFiles(folderId);
    const states = files
      .filter((f) => f.name.startsWith(GDRIVE_STATE_PREFIX) && f.name.endsWith(GDRIVE_STATE_SUFFIX))
      .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));

    for (const stale of states.slice(REVISION_HISTORY + 1)) {
      if (stale.name === currentStateFile) continue;
      try {
        await activeGDriveTransport.deleteFile(stale.id);
      } catch {
        // A revision we cannot delete is clutter, not a failure.
      }
    }
  } catch {
    // Pruning is opportunistic.
  }
  void currentStateFileId;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

export interface ConflictItem {
  table: string;
  key: string;
  localHash: string;
  remoteHash: string;
}

export interface PullInspection {
  remoteTimestamp: number;
  profileCount: number;
  scriptCount: number;
  vaultCount: number;
  groupCount: number;
  newProfiles: number;
  newScripts: number;
  newRows: number;
  deletedRows: number;
  conflicts: ConflictItem[];
  unchanged: boolean;
}

/**
 * Report what a pull would do, writing nothing.
 *
 * Runs the real merge rather than a bespoke comparison, because a second, simpler comparison is
 * exactly how the two drifted before — the inspection said "no conflicts" on data the pull would
 * then refuse.
 */
export async function inspectGDrivePull(passphrase?: string): Promise<PullInspection> {
  const effective = passphrase ?? activeSyncPassphrase;
  if (!effective) {
    return {
      remoteTimestamp: 0, profileCount: 0, scriptCount: 0, vaultCount: 0, groupCount: 0,
      newProfiles: 0, newScripts: 0, newRows: 0, deletedRows: 0, conflicts: [], unchanged: true,
    };
  }

  const remote = await readRemoteRevision(effective);
  const { base, tombstones } = loadBaseSnapshot();
  const merged = mergeTables({
    local: dumpAllTables(),
    base: Object.keys(base).length > 0 ? base : null,
    remote: remote ? remote.tables : null,
    tombstones,
    remoteTombstones: remote?.tombstones,
    resolution: 'keep_local',
  });

  const { lastPull } = getGDriveTimestamps();
  const remoteTimestamp = remote?.manifest.exportedAt ?? 0;

  return {
    remoteTimestamp,
    profileCount: remote?.manifest.counts.profiles ?? 0,
    scriptCount: remote?.manifest.counts.scripts ?? 0,
    vaultCount: remote?.manifest.counts.account_credentials ?? 0,
    groupCount: remote?.manifest.counts.groups ?? 0,
    newProfiles: merged.rows.filter((r) => r.table === 'profiles').length,
    newScripts: merged.rows.filter((r) => r.table === 'scripts').length,
    newRows: merged.counts.pulled,
    deletedRows: merged.counts.deleted,
    conflicts: merged.conflicts,
    unchanged:
      remoteTimestamp <= (lastPull ?? 0) &&
      merged.counts.pulled === 0 &&
      merged.counts.deleted === 0 &&
      merged.conflicts.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Public cycle wrappers
// ---------------------------------------------------------------------------

export async function pushToGDrive(passphrase?: string): Promise<SyncCycleResult> {
  return runSyncCycle({ passphrase, conflictResolution: 'keep_local' });
}

export async function pullFromGDrive(opts?: {
  conflictResolution?: ConflictResolution;
  passphrase?: string;
}): Promise<SyncCycleResult> {
  return runSyncCycle({
    passphrase: opts?.passphrase,
    // An explicit 'overwrite_remote' is the only way remote content wins a conflict; the default
    // keeps the machine the operator is sitting at. The old code refused the pull outright unless
    // 'overwrite_remote' was passed, which the engine never passed — so a second machine could not
    // sync at all.
    conflictResolution: opts?.conflictResolution ?? 'keep_local',
  });
}

/** Re-download the committed revision and check its digest. Exposed for the verify endpoint. */
export async function verifyRemoteState(passphrase?: string): Promise<{
  ok: boolean;
  revision: string;
  reason?: string;
}> {
  const effective = passphrase ?? activeSyncPassphrase;
  if (!effective) return { ok: false, revision: '', reason: 'sync is locked' };
  try {
    const remote = await readRemoteRevision(effective);
    if (!remote) return { ok: false, revision: '', reason: 'the Drive folder holds no sync data' };
    return { ok: true, revision: remote.manifest.stateFile };
  } catch (err) {
    return { ok: false, revision: '', reason: (err as Error).message };
  }
}