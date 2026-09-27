import fetch from 'node-fetch';
import { createHash } from 'crypto';
import {
  ensureValidAccessToken,
} from './gdriveClient';
import {
  getGDriveFolderId,
  saveGDriveFolderId,
  recordGDrivePushTimestamp,
  recordGDrivePullTimestamp,
  getGDriveTimestamps,
} from './gdriveAuth';
import {
  exportProfileBundle,
  importProfileBundle,
  getLiveProfile,
  listProfiles,
  updateProfile,
  type ProfileListItem,
  type ProfileBundle,
} from '../profiles/profileManager';
import { getDb } from '../db';
import { getSetting, setSetting } from '../config';
import {
  sealPayload,
  openPayload,
  SyncDecryptError,
  SYNC_ENVELOPE_MAGIC,
} from './syncCrypto';
import { protectSecret, revealSecret } from '../util/secretStore';
import { createTag, attachTag } from '../tags/tagManager';

export const GDRIVE_FOLDER_NAME = 'nulltrace data';
export const LEGACY_GDRIVE_FOLDER_NAME = 'NullTrace_Sync';
export const GDRIVE_MANIFEST_FILE = 'manifest.json';
export const GDRIVE_PROFILES_FILE = 'profiles.json';
export const GDRIVE_SCRIPTS_FILE = 'scripts.json';
export const GDRIVE_SETTINGS_FILE = 'settings.json';
export const GDRIVE_VAULT_FILE = 'vault.json';

/**
 * Parse a payload that came BACK from the cloud, refusing to throw on malformed input.
 *
 * Every value here originated in a remote Drive folder: a `manifest.json` a hand-edit produced, a
 * file truncated by an interrupted upload, or a blob written by a different build. A bare
 * `JSON.parse` on that content throws a `SyntaxError` out of `pullFromGDrive`, which surfaces as an
 * unhandled rejection rather than as the "the remote copy is unreadable" message the operator can
 * act on — and it aborts the whole pull, so one bad file blocks the settings, scripts and vault
 * that were perfectly fine.
 *
 * Returning `undefined` lets each caller keep the value it already had, which is the only safe
 * choice: the local data still works, and nothing is overwritten by a payload that could not be
 * read. The reason is logged with the file it came from.
 */
function parseRemoteJson<T>(raw: string, label: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(
      `[gdrive] ${label} could not be parsed and was ignored: ${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Page size used when enumerating profiles for a push. Large enough that a normal
 * installation is a single query, while still going through the same paged path the
 * UI uses rather than a separate unpaged accessor.
 */
export const GDRIVE_PROFILE_PAGE_SIZE = 10_000;

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
    let q = "trashed = false";
    if (folderId) {
      q += ` and '${folderId}' in parents`;
    }
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      q
    )}&fields=files(id,name,modifiedTime,size)&pageSize=100`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Drive list error (${res.status}): ${err}`);
    }
    const data = (await res.json()) as { files?: DriveFileInfo[] };
    return data.files || [];
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

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Drive search error (${res.status}): ${err}`);
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

    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Drive create folder error (${res.status}): ${err}`);
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

    if (existingFileId) {
      // Update existing content
      const url = `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=media`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType,
        },
        body: content,
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Drive update error (${res.status}): ${err}`);
      }
      const data = (await res.json()) as { id: string };
      return data.id;
    }

    // Multipart create file in folder
    const boundary = '-------NullTraceBoundary' + Date.now();
    const metadata = JSON.stringify({
      name,
      parents: [folderId],
    });

    const contentBuf = isBuf ? content : Buffer.from(content, 'utf8');
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
      'utf8'
    );
    const footer = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const multipartBody = Buffer.concat([header, contentBuf, footer]);

    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Drive upload error (${res.status}): ${err}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  async downloadBuffer(fileId: string): Promise<Buffer> {
    const token = await ensureValidAccessToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Drive download error (${res.status}): ${err}`);
    }
    return res.buffer();
  }

  async downloadFile(fileId: string): Promise<string> {
    const buf = await this.downloadBuffer(fileId);
    return buf.toString('binary');
  }

  async deleteFile(fileId: string): Promise<void> {
    const token = await ensureValidAccessToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`Drive delete error (${res.status}): ${err}`);
    }
  }
}

// Swappable transport for testing
let activeGDriveTransport: GDriveTransport = new HttpGDriveTransport();

export function setGDriveTransport(transport: GDriveTransport): void {
  activeGDriveTransport = transport;
}

export function getGDriveTransport(): GDriveTransport {
  return activeGDriveTransport;
}

/**
 * Robust buffer downloader that works with both HttpGDriveTransport and test mocks.
 */
async function downloadAsBuffer(transport: GDriveTransport, fileId: string): Promise<Buffer> {
  if (typeof transport.downloadBuffer === 'function') {
    return transport.downloadBuffer(fileId);
  }
  const content = await transport.downloadFile(fileId);
  if (Buffer.isBuffer(content)) {
    return content;
  }
  return Buffer.from(content, 'binary');
}

/**
 * In-memory sync passphrase storage for the current session.
 * The passphrase is NEVER written to disk, SQLite, settings, or log lines.
 */
let activeSyncPassphrase: string | null = null;

export function setSyncPassphrase(passphrase: string | null): void {
  activeSyncPassphrase = passphrase;
}

export function getSyncPassphrase(): string | null {
  return activeSyncPassphrase;
}

/**
 * Locates existing Sync folder or creates one.
 * First checks for the modern folder name ('nulltrace data').
 * If missing, adopts the legacy folder name ('NullTrace_Sync') so existing data is not orphaned.
 * If neither exists, creates 'nulltrace data'.
 */
export async function ensureSyncFolder(): Promise<string> {
  let storedId = getGDriveFolderId();
  if (storedId) {
    return storedId;
  }

  // Look for new folder name first ('nulltrace data')
  const newFolderId = await activeGDriveTransport.findFolder(GDRIVE_FOLDER_NAME);
  if (newFolderId) {
    saveGDriveFolderId(newFolderId);
    return newFolderId;
  }

  // Fallback: adopt legacy folder ('NullTrace_Sync') if already present in operator's Drive
  const legacyFolderId = await activeGDriveTransport.findFolder(LEGACY_GDRIVE_FOLDER_NAME);
  if (legacyFolderId) {
    saveGDriveFolderId(legacyFolderId);
    return legacyFolderId;
  }

  // Neither exists: create new folder under the canonical name
  const createdId = await activeGDriveTransport.createFolder(GDRIVE_FOLDER_NAME);
  saveGDriveFolderId(createdId);
  return createdId;
}

/**
 * Manifest format recording export metadata (Zone A contract)
 */
export interface GDriveManifest {
  version: 1;
  app: 'nulltrace';
  exportedAt: number;
  sealed: boolean;
  profileCount: number;
  scriptCount: number;
  vaultCount: number;
  hasSettings?: boolean;
  /** Which payload files exist this revision, so a pull knows what to expect. */
  files: string[];
  /** SHA-256 of each sealed file, hex. Detects a truncated/tampered upload. */
  digests: Record<string, string>;
}

/**
 * Settings bundle shape (selected transportable settings)
 */
export interface GDriveSettingsBundle {
  captureProtection?: boolean;
  autoLockMinutes?: number;
  catalogUrl?: string;
  theme?: string;
}

/**
 * Push local profiles, scripts, settings, and vault to Drive.
 * Every user-data file is encrypted with AES-256-GCM via sealPayload.
 * manifest.json stays plaintext with SHA-256 digests over the sealed payloads.
 */
export async function pushToGDrive(passphrase?: string): Promise<{
  pushedProfiles: number;
  pushedScripts: number;
  pushedVault: number;
  timestamp: number;
}> {
  const effectivePassphrase = passphrase ?? activeSyncPassphrase;
  if (!effectivePassphrase) {
    throw new Error('Push aborted: sync passphrase is required for end-to-end payload encryption');
  }

  const folderId = await ensureSyncFolder();
  const remoteFiles = await activeGDriveTransport.listFiles(folderId);
  const fileMap: Record<string, string> = {};
  for (const f of remoteFiles) {
    fileMap[f.name] = f.id;
  }

  // 1. Gather Profiles using explicit pagination to guarantee no silent truncation
  const localProfiles: ProfileListItem[] = [];
  let page = 1;
  let reportedTotal = 0;
  while (true) {
    const res = listProfiles(page, GDRIVE_PROFILE_PAGE_SIZE);
    reportedTotal = res.total;
    localProfiles.push(...res.list);
    if (localProfiles.length >= res.total || res.list.length === 0) {
      break;
    }
    page++;
  }
  if (localProfiles.length !== reportedTotal) {
    throw new Error(
      `Push aborted: profile list was truncated or changed during enumeration (collected ${localProfiles.length} of ${reportedTotal} profiles)`
    );
  }

  const bundles = [];
  for (const p of localProfiles) {
    const bundle = exportProfileBundle(p.user_id);
    if (bundle) {
      const live = getLiveProfile(p.user_id);
      bundles.push({
        id: p.user_id,
        name: p.name,
        updated_at: live?.updated_at ?? bundle.exported_at,
        bundle,
      });
    }
  }

  // 2. Gather User Scripts
  const db = getDb();
  const scripts = db
    .prepare('SELECT id, name, code, created_at, updated_at, last_run_at, last_status FROM scripts')
    .all() as Array<{
    id: string;
    name: string;
    code: string;
    created_at: number;
    updated_at: number;
    last_run_at: number | null;
    last_status: string | null;
  }>;

  // 3. Gather Safe Settings
  const settingsBundle: GDriveSettingsBundle = {
    captureProtection: Boolean(getSetting('captureProtection')),
    autoLockMinutes: typeof getSetting('autoLockMinutes') === 'number' ? (getSetting('autoLockMinutes') as number) : 15,
    catalogUrl: typeof getSetting('catalogUrl') === 'string' ? (getSetting('catalogUrl') as string) : '',
  };

  // 4. Gather Vault (account_credentials) for live profiles
  /*
   * Secrets are carried in a PORTABLE form, not in their stored `enc:`/`aes:` form.
   *
   * The stored value is bound to THIS machine: the shipped build never calls `setSecretCipher`
   * (that path is only reached inside the Tauri shell), so credentials are `aes:` under a key file
   * at `DATA_DIR/secret.key`. Uploading that ciphertext verbatim produced rows a peer machine could
   * not open — `revealSecret` returns undefined there — so a synced vault appeared in the UI with
   * every password silently unusable, while this machine still read them fine. That is the worst
   * shape for this class of bug: it looks correct on the machine that pushed.
   *
   * So the plaintext is revealed HERE, on the machine that can still read it, and the whole file is
   * then sealed by `sealPayload` under the operator's sync passphrase — which every machine sharing
   * the Drive folder knows. On pull the value is re-protected for the receiving machine. A value
   * that cannot be revealed (a row written by an older build under a key that is gone) is carried
   * as an explicit marker rather than as ciphertext that would silently fail on the peer.
   */
  const vaultRows = db
    .prepare(
      `SELECT ac.id, ac.profile_id, ac.label, ac.login, ac.password_enc, ac.totp_secret_enc, ac.notes, ac.created_at, ac.updated_at
       FROM account_credentials ac
       JOIN profiles p ON p.id = ac.profile_id
       WHERE p.deleted_at IS NULL`
    )
    .all() as Array<{
    id: string;
    profile_id: string;
    label: string | null;
    login: string | null;
    password_enc: string | null;
    totp_secret_enc: string | null;
    notes: string | null;
    created_at: number;
    updated_at: number;
  }>;

  const vaultForTransport = vaultRows.map((row) => ({
    ...row,
    // `password`/`totp_secret` are the portable fields. A null means the stored value could not be
    // revealed on this machine; the pull side keeps its local copy in that case rather than
    // overwriting a working credential with nothing.
    password: revealSecret(row.password_enc) ?? null,
    totp_secret: revealSecret(row.totp_secret_enc) ?? null,
    password_enc: undefined,
    totp_secret_enc: undefined,
  }));

  const now = Date.now();

  // Seal every payload file with sealPayload before upload
  const profilesBuf = sealPayload(
    effectivePassphrase,
    Buffer.from(JSON.stringify(bundles, null, 2), 'utf8')
  );
  const scriptsBuf = sealPayload(
    effectivePassphrase,
    Buffer.from(JSON.stringify(scripts, null, 2), 'utf8')
  );
  const settingsBuf = sealPayload(
    effectivePassphrase,
    Buffer.from(JSON.stringify(settingsBundle, null, 2), 'utf8')
  );
  const vaultBuf = sealPayload(
    effectivePassphrase,
    Buffer.from(JSON.stringify(vaultForTransport, null, 2), 'utf8')
  );

  const files = [
    GDRIVE_PROFILES_FILE,
    GDRIVE_SCRIPTS_FILE,
    GDRIVE_SETTINGS_FILE,
    GDRIVE_VAULT_FILE,
  ];

  const digests: Record<string, string> = {
    [GDRIVE_PROFILES_FILE]: createHash('sha256').update(profilesBuf).digest('hex'),
    [GDRIVE_SCRIPTS_FILE]: createHash('sha256').update(scriptsBuf).digest('hex'),
    [GDRIVE_SETTINGS_FILE]: createHash('sha256').update(settingsBuf).digest('hex'),
    [GDRIVE_VAULT_FILE]: createHash('sha256').update(vaultBuf).digest('hex'),
  };

  // manifest.json stays plaintext
  const manifest: GDriveManifest = {
    version: 1,
    app: 'nulltrace',
    exportedAt: now,
    sealed: true,
    profileCount: bundles.length,
    scriptCount: scripts.length,
    vaultCount: vaultRows.length,
    hasSettings: true,
    files,
    digests,
  };

  await activeGDriveTransport.uploadFile(
    GDRIVE_PROFILES_FILE,
    profilesBuf,
    folderId,
    fileMap[GDRIVE_PROFILES_FILE]
  );

  await activeGDriveTransport.uploadFile(
    GDRIVE_SCRIPTS_FILE,
    scriptsBuf,
    folderId,
    fileMap[GDRIVE_SCRIPTS_FILE]
  );

  await activeGDriveTransport.uploadFile(
    GDRIVE_SETTINGS_FILE,
    settingsBuf,
    folderId,
    fileMap[GDRIVE_SETTINGS_FILE]
  );

  await activeGDriveTransport.uploadFile(
    GDRIVE_VAULT_FILE,
    vaultBuf,
    folderId,
    fileMap[GDRIVE_VAULT_FILE]
  );

  await activeGDriveTransport.uploadFile(
    GDRIVE_MANIFEST_FILE,
    JSON.stringify(manifest, null, 2),
    folderId,
    fileMap[GDRIVE_MANIFEST_FILE]
  );

  recordGDrivePushTimestamp(now);

  return {
    pushedProfiles: bundles.length,
    pushedScripts: scripts.length,
    pushedVault: vaultRows.length,
    timestamp: now,
  };
}

export interface ConflictItem {
  type: 'profile' | 'script';
  id: string;
  name: string;
  localUpdatedAt: number;
  remoteUpdatedAt: number;
}

export interface PullInspection {
  remoteTimestamp: number;
  profileCount: number;
  scriptCount: number;
  vaultCount?: number;
  newProfiles: number;
  newScripts: number;
  conflicts: ConflictItem[];
  unchanged: boolean;
}

/**
 * Inspect remote Drive state without modifying local data.
 * Detects conflicts (different timestamps or newer local data).
 */
export async function inspectGDrivePull(passphrase?: string): Promise<PullInspection> {
  const folderId = await ensureSyncFolder();
  const remoteFiles = await activeGDriveTransport.listFiles(folderId);
  const fileMap: Record<string, string> = {};
  for (const f of remoteFiles) {
    fileMap[f.name] = f.id;
  }

  if (!fileMap[GDRIVE_MANIFEST_FILE]) {
    return {
      remoteTimestamp: 0,
      profileCount: 0,
      scriptCount: 0,
      vaultCount: 0,
      newProfiles: 0,
      newScripts: 0,
      conflicts: [],
      unchanged: true,
    };
  }

  const manifestStr = await activeGDriveTransport.downloadFile(fileMap[GDRIVE_MANIFEST_FILE]);
  const manifest = parseRemoteJson<GDriveManifest>(manifestStr, 'manifest.json');
  if (!manifest) {
    // Without a manifest there is nothing to apply safely, so the pull stops here with a reason
    // rather than half-applying a folder that may not match what it claims to be.
    throw new SyncDecryptError('manifest.json in the Drive folder could not be parsed');
  }

  const effectivePassphrase = passphrase ?? activeSyncPassphrase;

  let remoteProfiles: Array<{ id: string; name: string; updated_at: number; bundle: ProfileBundle }> = [];
  let remoteScripts: Array<{ id: string; name: string; updated_at: number }> = [];

  if (fileMap[GDRIVE_PROFILES_FILE]) {
    const rawBuf = await downloadAsBuffer(activeGDriveTransport, fileMap[GDRIVE_PROFILES_FILE]);
    if (manifest.sealed || rawBuf.subarray(0, 4).equals(SYNC_ENVELOPE_MAGIC)) {
      if (effectivePassphrase) {
        const decrypted = openPayload(effectivePassphrase, rawBuf);
        remoteProfiles = parseRemoteJson<typeof remoteProfiles>(decrypted.toString('utf8'), 'profiles.json') ?? [];
      }
    } else {
      remoteProfiles = parseRemoteJson<typeof remoteProfiles>(rawBuf.toString('utf8'), 'profiles.json') ?? [];
    }
  }

  if (fileMap[GDRIVE_SCRIPTS_FILE]) {
    const rawBuf = await downloadAsBuffer(activeGDriveTransport, fileMap[GDRIVE_SCRIPTS_FILE]);
    if (manifest.sealed || rawBuf.subarray(0, 4).equals(SYNC_ENVELOPE_MAGIC)) {
      if (effectivePassphrase) {
        const decrypted = openPayload(effectivePassphrase, rawBuf);
        remoteScripts = parseRemoteJson<typeof remoteScripts>(decrypted.toString('utf8'), 'scripts.json') ?? [];
      }
    } else {
      remoteScripts = parseRemoteJson<typeof remoteScripts>(rawBuf.toString('utf8'), 'scripts.json') ?? [];
    }
  }

  const localProfiles = listProfiles(1, GDRIVE_PROFILE_PAGE_SIZE).list;
  const localProfileMap: Record<string, { id: string; name: string | null; updated_at: number }> = {};
  for (const p of localProfiles) {
    const row = getLiveProfile(p.user_id);
    localProfileMap[p.user_id] = {
      id: p.user_id,
      name: p.name,
      updated_at: row?.updated_at ?? 0,
    };
  }

  const db = getDb();
  const localScripts = db.prepare('SELECT id, name, updated_at FROM scripts').all() as Array<{
    id: string;
    name: string;
    updated_at: number;
  }>;
  const localScriptMap: Record<string, { id: string; name: string; updated_at: number }> = {};
  for (const s of localScripts) {
    localScriptMap[s.id] = s;
  }

  const conflicts: ConflictItem[] = [];
  let newProfiles = 0;
  let newScripts = 0;

  for (const rp of remoteProfiles) {
    const local = localProfileMap[rp.id];
    if (!local) {
      newProfiles++;
    } else if (local.updated_at > rp.updated_at) {
      conflicts.push({
        type: 'profile',
        id: rp.id,
        name: rp.name,
        localUpdatedAt: local.updated_at,
        remoteUpdatedAt: rp.updated_at,
      });
    }
  }

  for (const rs of remoteScripts) {
    const local = localScriptMap[rs.id];
    if (!local) {
      newScripts++;
    } else if (local.updated_at > rs.updated_at) {
      conflicts.push({
        type: 'script',
        id: rs.id,
        name: rs.name,
        localUpdatedAt: local.updated_at,
        remoteUpdatedAt: rs.updated_at,
      });
    }
  }

  const { lastPull } = getGDriveTimestamps();
  const unchanged =
    manifest.exportedAt <= (lastPull ?? 0) &&
    conflicts.length === 0 &&
    newProfiles === 0 &&
    newScripts === 0;

  return {
    remoteTimestamp: manifest.exportedAt,
    profileCount: manifest.profileCount,
    scriptCount: manifest.scriptCount,
    vaultCount: manifest.vaultCount ?? 0,
    newProfiles,
    newScripts,
    conflicts,
    unchanged,
  };
}

export type ConflictResolution = 'keep_local' | 'overwrite_remote' | 'cancel';

/**
 * Applies pull from Google Drive.
 * RULE: Refuses to overwrite local profiles/scripts when conflicts exist,
 * UNLESS conflictResolution is explicitly set to 'overwrite_remote'.
 *
 * CRITICAL INVARIANT:
 * All payloads are downloaded and decrypted with openPayload BEFORE any
 * database write is performed. A wrong passphrase throws SyncDecryptError
 * and aborts immediately without corrupting or partially overwriting local data.
 */
export async function pullFromGDrive(opts?: {
  conflictResolution?: ConflictResolution;
  passphrase?: string;
}): Promise<{
  pulledProfiles: number;
  pulledScripts: number;
  pulledVault: number;
  appliedSettings: boolean;
  timestamp: number;
}> {
  const effectivePassphrase = opts?.passphrase ?? activeSyncPassphrase;

  const folderId = await ensureSyncFolder();
  const remoteFiles = await activeGDriveTransport.listFiles(folderId);
  const fileMap: Record<string, string> = {};
  for (const f of remoteFiles) {
    fileMap[f.name] = f.id;
  }

  if (!fileMap[GDRIVE_MANIFEST_FILE]) {
    throw new Error('No NullTrace sync files found in Google Drive');
  }

  const manifestStr = await activeGDriveTransport.downloadFile(fileMap[GDRIVE_MANIFEST_FILE]);
  const manifest = parseRemoteJson<GDriveManifest>(manifestStr, 'manifest.json');
  if (!manifest) {
    // Without a manifest there is nothing to apply safely, so the pull stops here with a reason
    // rather than half-applying a folder that may not match what it claims to be.
    throw new SyncDecryptError('manifest.json in the Drive folder could not be parsed');
  }

  if (manifest.sealed && !effectivePassphrase) {
    throw new SyncDecryptError('Sync passphrase is required to pull sealed Google Drive data');
  }

  // 1. Download all files and verify digests BEFORE decrypting or modifying DB
  const rawBuffers: Record<string, Buffer> = {};
  const filesToFetch = manifest.files && manifest.files.length > 0
    ? manifest.files
    : [GDRIVE_PROFILES_FILE, GDRIVE_SCRIPTS_FILE, GDRIVE_SETTINGS_FILE, GDRIVE_VAULT_FILE];

  for (const fName of filesToFetch) {
    if (fileMap[fName]) {
      const buf = await downloadAsBuffer(activeGDriveTransport, fileMap[fName]);
      if (manifest.digests?.[fName]) {
        const hash = createHash('sha256').update(buf).digest('hex');
        if (hash !== manifest.digests[fName]) {
          throw new SyncDecryptError(`Integrity check failed for ${fName}: digest mismatch`);
        }
      }
      rawBuffers[fName] = buf;
    }
  }

  // 2. Decrypt all sealed files BEFORE touching database!
  // If openPayload fails, it throws SyncDecryptError and aborts without touching local data.
  let remoteProfiles: Array<{ id: string; name: string; updated_at: number; bundle: ProfileBundle }> = [];
  if (rawBuffers[GDRIVE_PROFILES_FILE]) {
    const buf = rawBuffers[GDRIVE_PROFILES_FILE];
    const isSealed = manifest.sealed || buf.subarray(0, 4).equals(SYNC_ENVELOPE_MAGIC);
    const plain = isSealed ? openPayload(effectivePassphrase!, buf) : buf;
    remoteProfiles = parseRemoteJson<typeof remoteProfiles>(plain.toString('utf8'), 'profiles.json') ?? [];
  }

  let remoteScripts: Array<{
    id: string;
    name: string;
    description?: string;
    code: string;
    url_patterns?: string;
    run_at?: string;
    enabled?: number;
    updated_at: number;
  }> = [];
  if (rawBuffers[GDRIVE_SCRIPTS_FILE]) {
    const buf = rawBuffers[GDRIVE_SCRIPTS_FILE];
    const isSealed = manifest.sealed || buf.subarray(0, 4).equals(SYNC_ENVELOPE_MAGIC);
    const plain = isSealed ? openPayload(effectivePassphrase!, buf) : buf;
    remoteScripts = parseRemoteJson<typeof remoteScripts>(plain.toString('utf8'), 'scripts.json') ?? [];
  }

  let remoteSettings: GDriveSettingsBundle | null = null;
  if (rawBuffers[GDRIVE_SETTINGS_FILE]) {
    const buf = rawBuffers[GDRIVE_SETTINGS_FILE];
    const isSealed = manifest.sealed || buf.subarray(0, 4).equals(SYNC_ENVELOPE_MAGIC);
    const plain = isSealed ? openPayload(effectivePassphrase!, buf) : buf;
    remoteSettings = parseRemoteJson<GDriveSettingsBundle>(plain.toString('utf8'), 'settings.json') ?? remoteSettings;
  }

  let remoteVault: Array<{
    id: string;
    profile_id: string;
    label: string | null;
    login: string | null;
    /** Portable plaintext carried by the push. Absent for entries written before this change. */
    password?: string | null;
    totp_secret?: string | null;
    /** Machine-bound ciphertext from an older payload; kept only so such entries are detectable. */
    password_enc?: string | null;
    totp_secret_enc?: string | null;
    notes: string | null;
    created_at: number;
    updated_at: number;
  }> = [];
  if (rawBuffers[GDRIVE_VAULT_FILE]) {
    const buf = rawBuffers[GDRIVE_VAULT_FILE];
    const isSealed = manifest.sealed || buf.subarray(0, 4).equals(SYNC_ENVELOPE_MAGIC);
    const plain = isSealed ? openPayload(effectivePassphrase!, buf) : buf;
    remoteVault = parseRemoteJson<typeof remoteVault>(plain.toString('utf8'), 'vault.json') ?? [];
  }

  // 3. Conflict detection
  const localProfiles = listProfiles(1, GDRIVE_PROFILE_PAGE_SIZE).list;
  const localProfileMap: Record<string, { id: string; name: string | null; updated_at: number }> = {};
  for (const p of localProfiles) {
    const row = getLiveProfile(p.user_id);
    localProfileMap[p.user_id] = {
      id: p.user_id,
      name: p.name,
      updated_at: row?.updated_at ?? 0,
    };
  }

  const db = getDb();
  const localScripts = db.prepare('SELECT id, name, updated_at FROM scripts').all() as Array<{
    id: string;
    name: string;
    updated_at: number;
  }>;
  const localScriptMap: Record<string, { id: string; name: string; updated_at: number }> = {};
  for (const s of localScripts) {
    localScriptMap[s.id] = s;
  }

  const conflicts: ConflictItem[] = [];
  for (const rp of remoteProfiles) {
    const local = localProfileMap[rp.id];
    if (local && local.updated_at > rp.updated_at) {
      conflicts.push({
        type: 'profile',
        id: rp.id,
        name: rp.name,
        localUpdatedAt: local.updated_at,
        remoteUpdatedAt: rp.updated_at,
      });
    }
  }

  for (const rs of remoteScripts) {
    const local = localScriptMap[rs.id];
    if (local && local.updated_at > rs.updated_at) {
      conflicts.push({
        type: 'script',
        id: rs.id,
        name: rs.name,
        localUpdatedAt: local.updated_at,
        remoteUpdatedAt: rs.updated_at,
      });
    }
  }

  if (conflicts.length > 0 && opts?.conflictResolution !== 'overwrite_remote') {
    const conflictNames = conflicts.map((c) => `${c.type} "${c.name}"`).join(', ');
    throw new Error(
      `Pull aborted: local data differs from remote (${conflictNames}). To overwrite, specify conflictResolution: 'overwrite_remote'`
    );
  }

  // 4. Decryption and integrity checks passed — now apply to local database
  let pulledProfiles = 0;
  let pulledScripts = 0;
  let pulledVault = 0;

  // A. Profiles
  for (const rp of remoteProfiles) {
    const existing = getLiveProfile(rp.id);
    if (!existing) {
      const newId = importProfileBundle(rp.bundle, { exactName: true });
      if (newId !== rp.id) {
        try {
          db.prepare('UPDATE profiles SET id = ? WHERE id = ?').run(rp.id, newId);
        } catch {
          // retain generated id if conflict
        }
      }
      pulledProfiles++;
    } else if (opts?.conflictResolution === 'overwrite_remote' || rp.updated_at > existing.updated_at) {
      updateProfile(rp.id, {
        name: rp.bundle.profile?.name ?? rp.name ?? undefined,
        user_agent: rp.bundle.profile?.user_agent,
        timezone: rp.bundle.profile?.timezone,
        start_urls: rp.bundle.profile?.start_urls,
        notes: rp.bundle.profile?.notes ?? rp.bundle.notes ?? undefined,
      });

      if (rp.bundle.profile?.cookies?.length) {
        db.prepare('UPDATE profiles SET cookies_json = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(rp.bundle.profile.cookies),
          Date.now(),
          rp.id
        );
      }

      const tagsToSync = rp.bundle.profile?.tags ?? rp.bundle.tags;
      if (Array.isArray(tagsToSync)) {
        for (const tagName of tagsToSync) {
          if (!tagName || !tagName.trim()) continue;
          const cleanName = tagName.trim();
          const existingTag = db.prepare('SELECT id FROM tags WHERE lower(name) = lower(?)').get(cleanName) as
            | { id: string }
            | undefined;
          let tagId = existingTag?.id;
          if (!tagId) {
            const created = createTag(cleanName);
            if (created.ok) tagId = created.data.id;
          }
          if (tagId) attachTag(tagId, [rp.id]);
        }
      }

      pulledProfiles++;
    }
  }

  // B. Scripts
  for (const rs of remoteScripts) {
    const existing = db.prepare('SELECT id, updated_at FROM scripts WHERE id = ?').get(rs.id) as
      | { id: string; updated_at: number }
      | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO scripts (id, name, description, code, url_patterns, run_at, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        rs.id,
        rs.name,
        rs.description ?? '',
        rs.code,
        rs.url_patterns ?? '',
        rs.run_at ?? 'document_end',
        rs.enabled ?? 1,
        Date.now(),
        rs.updated_at
      );
      pulledScripts++;
    } else if (opts?.conflictResolution === 'overwrite_remote' || rs.updated_at > existing.updated_at) {
      db.prepare(
        `UPDATE scripts SET name = ?, description = ?, code = ?, url_patterns = ?, run_at = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        rs.name,
        rs.description ?? '',
        rs.code,
        rs.url_patterns ?? '',
        rs.run_at ?? 'document_end',
        rs.enabled ?? 1,
        rs.updated_at,
        rs.id
      );
      pulledScripts++;
    }
  }

  // C. Vault (account_credentials)
  for (const entry of remoteVault) {
    const existing = db
      .prepare('SELECT id, updated_at FROM account_credentials WHERE id = ?')
      .get(entry.id) as { id: string; updated_at: number } | undefined;

    /*
     * The receiving machine protects the secret under ITS OWN key.
     *
     * The payload carries plaintext (see the push side): re-protecting here is what makes a synced
     * credential usable on this machine. When the payload has no portable value — an entry written
     * by a build before this change, which carried only machine-bound ciphertext — the local row is
     * left untouched rather than overwritten with a value this machine cannot read. Losing an
     * existing working credential is worse than skipping one remote update.
     */
    const portablePassword = typeof entry.password === 'string' ? entry.password : null;
    const portableTotp = typeof entry.totp_secret === 'string' ? entry.totp_secret : null;
    const hasPortable = portablePassword !== null || portableTotp !== null;

    if (!existing) {
      // Nothing local to preserve, so an old-style entry lands with whatever it carried.
      try {
        db.prepare(
          `INSERT INTO account_credentials (id, profile_id, label, login, password_enc, totp_secret_enc, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          entry.id,
          entry.profile_id,
          entry.label,
          entry.login,
          portablePassword !== null ? protectSecret(portablePassword) : entry.password_enc ?? null,
          portableTotp !== null ? protectSecret(portableTotp) : entry.totp_secret_enc ?? null,
          entry.notes,
          entry.created_at,
          entry.updated_at
        );
        pulledVault++;
      } catch {
        // profile_id FK constraint if profile was deleted locally
      }
    } else if (opts?.conflictResolution === 'overwrite_remote' || entry.updated_at > existing.updated_at) {
      if (!hasPortable && (entry.password_enc || entry.totp_secret_enc)) {
        // A pre-change payload: its ciphertext is bound to the SENDING machine and would be
        // unreadable here. Keep the local value and count the entry as skipped.
        continue;
      }
      db.prepare(
        `UPDATE account_credentials
         SET profile_id = ?, label = ?, login = ?, password_enc = ?, totp_secret_enc = ?, notes = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        entry.profile_id,
        entry.label,
        entry.login,
        portablePassword !== null ? protectSecret(portablePassword) : entry.password_enc ?? null,
        portableTotp !== null ? protectSecret(portableTotp) : entry.totp_secret_enc ?? null,
        entry.notes,
        entry.updated_at,
        entry.id
      );
      pulledVault++;
    }
  }

  // D. Settings
  let appliedSettings = false;
  if (remoteSettings) {
    if (typeof remoteSettings.captureProtection === 'boolean') {
      setSetting('captureProtection', remoteSettings.captureProtection);
    }
    if (typeof remoteSettings.autoLockMinutes === 'number') {
      setSetting('autoLockMinutes', remoteSettings.autoLockMinutes);
    }
    if (typeof remoteSettings.catalogUrl === 'string') {
      setSetting('catalogUrl', remoteSettings.catalogUrl);
    }
    appliedSettings = true;
  }

  recordGDrivePullTimestamp(manifest.exportedAt);

  return {
    pulledProfiles,
    pulledScripts,
    pulledVault,
    appliedSettings,
    timestamp: manifest.exportedAt,
  };
}
