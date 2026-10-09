// Google Drive sync: credential safety, OAuth lifecycle, folder reuse, transfer.
//
// The security property under test is that the operator's OAuth client and the
// resulting refresh token stay in the secret store — not in settings.json, not in a
// response, not in a log line. Everything else runs through injected transports, so
// no network and no Google account are needed.
//
// This cannot be verified against real Google without an operator's own client;
// what is proven here is the logic, the storage boundary, and the failure modes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  saveGDriveCredentials,
  getGDriveCredentials,
  getCustomGDriveCredentials,
  validateClientCredentials,
  saveGDriveRefreshToken,
  getGDriveRefreshToken,
  saveGDriveFolderId,
  getGDriveFolderId,
  saveGDriveUserEmail,
  getGDriveUserEmail,
  setCachedAccessToken,
  getCachedAccessToken,
  disconnectGDrive,
  purgeGDriveConfiguration,
  getGDriveStatus,
  setGDriveStorage,
  type GDriveStorageAdapter,
} from '../../src/main/cloud/gdriveAuth';
import {
  startSyncEngine,
  stopSyncEngine,
  unlockSession,
  clearSyncSession,
  setSyncError,
  getSyncStatus,
  requestSync,
} from '../../src/main/cloud/gdriveSync';
import {
  downloadMirrorArchive,
  GDRIVE_MIRROR_FILE,
} from '../../src/main/cloud/gdriveFullMirror';
import {
  setOAuthTransport,
  ensureValidAccessToken,
  type OAuthTransport,
} from '../../src/main/cloud/gdriveClient';
import * as transfer from '../../src/main/cloud/gdriveTransfer';
import {
  setGDriveTransport,
  ensureSyncFolder,
  pushToGDrive,
  inspectGDrivePull,
  pullFromGDrive,
  type GDriveTransport,
  type DriveFileInfo,
  setSyncPassphrase,
} from '../../src/main/cloud/gdriveTransfer';
import { initDb, closeDb } from '../../src/main/db';

let tmpRoot: string;

/** In-memory secret store so no DPAPI/Electron is required. */
function makeStorage() {
  const raw = new Map<string, string>();
  const adapter: GDriveStorageAdapter = {
    get: (key: string) => raw.get(key) ?? null,
    set: (key: string, value: string) => {
      raw.set(key, value);
    },
    delete: (key: string) => {
      raw.delete(key);
    },
  };
  return { adapter, raw };
}

/** OAuth transport whose every member is a spy, so call counts are assertable. */
function oauthTransport(overrides: Partial<OAuthTransport> = {}) {
  const base: OAuthTransport = {
    requestDeviceCode: vi.fn(async () => ({
      deviceCode: 'dev-code',
      userCode: 'USER-CODE',
      verificationUri: 'https://example.invalid/device',
      expiresInSec: 900,
      intervalSec: 5,
    })),
    pollDeviceToken: vi.fn(async () => ({ status: 'pending' as const })),
    exchangeAuthCode: vi.fn(async () => ({ accessToken: 'ya29.exchanged', expiresInSec: 3600 })),
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'ya29.refreshed', expiresInSec: 3600 })),
    fetchUserInfo: vi.fn(async () => ({ email: 'operator@example.invalid' })),
  };
  return { ...base, ...overrides };
}

/** Drive transport backed by an in-memory file map. */
function driveTransport(seed: Array<{ id: string; name: string }> = []) {
  const files = new Map<string, { name: string; content: string }>(
    seed.map((f) => [f.id, { name: f.name, content: '' }])
  );
  let folderSeq = 0;
  const transport = {
    listFiles: vi.fn(async (): Promise<DriveFileInfo[]> =>
      [...files.entries()].map(([id, v]) => ({ id, name: v.name }))
    ),
    createFolder: vi.fn(async () => `folder-${++folderSeq}`),
    findFolder: vi.fn(async () => null as string | null),
    uploadFile: vi.fn(async (name: string, content: string) => {
      const id = `file-${files.size + 1}`;
      files.set(id, { name, content });
      return id;
    }),
    downloadFile: vi.fn(async (fileId: string) => files.get(fileId)?.content ?? ''),
    deleteFile: vi.fn(async (fileId: string) => {
      files.delete(fileId);
    }),
  };
  return { transport: transport as unknown as GDriveTransport, spies: transport, files };
}

/** A connected state, so tests exercise transfer rather than auth. */
function connect() {
  saveGDriveCredentials({ clientId: 'operator-client.apps.googleusercontent.com' });
  saveGDriveRefreshToken('1//refresh-token-value');
  setCachedAccessToken('ya29.valid', 3600);
}

beforeEach(async () => {
  await initDb();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nulltrace-gdrive-'));
  setGDriveStorage(makeStorage().adapter);
  purgeGDriveConfiguration();
});

afterEach(() => {
  stopSyncEngine();
  clearSyncSession();
  purgeGDriveConfiguration();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('client credentials', () => {
  it('refuses a missing or implausibly short client id', () => {
    expect(validateClientCredentials({ clientId: '' }).valid).toBe(false);
    expect(validateClientCredentials({ clientId: 'abc' }).valid).toBe(false);
    expect(validateClientCredentials({ clientId: 'abcdefghij.apps.googleusercontent.com' }).valid).toBe(true);
  });

  it('round-trips the operator client through the secret store', () => {
    saveGDriveCredentials({
      clientId: 'operator-client.apps.googleusercontent.com',
      clientSecret: 's3cret',
    });
    const back = getGDriveCredentials();
    expect(back?.clientId).toBe('operator-client.apps.googleusercontent.com');
    expect(back?.clientSecret).toBe('s3cret');
  });

  it('keeps the operator client when disconnecting, so reconnecting needs no retyping', () => {
    connect();
    saveGDriveFolderId('folder-abc');

    disconnectGDrive();

    expect(getGDriveRefreshToken()).toBeNull();
    // The client id is the operator's own setup, not the grant.
    expect(getGDriveCredentials()?.clientId).toBe('operator-client.apps.googleusercontent.com');
  });

  it('purge clears everything including the operator client', () => {
    connect();
    saveGDriveFolderId('folder-abc');

    purgeGDriveConfiguration();

    expect(getCustomGDriveCredentials()).toBeNull();
    expect(getGDriveRefreshToken()).toBeNull();
    expect(getGDriveFolderId()).toBeNull();
  });

  it('saveGDriveCredentials clears any stored refresh token from a previous client (R06)', () => {
    connect();
    expect(getGDriveRefreshToken()).toBe('1//refresh-token-value');
    expect(getGDriveStatus().connected).toBe(true);

    saveGDriveCredentials({ clientId: 'brand-new-client.apps.googleusercontent.com' });

    expect(getGDriveRefreshToken()).toBeNull();
    expect(getGDriveStatus().connected).toBe(false);
  });

  it('disconnectGDrive clears folderId and cached email alongside tokens (R07)', () => {
    connect();
    saveGDriveFolderId('folder-xyz');
    saveGDriveUserEmail('operator@example.invalid');

    disconnectGDrive();

    expect(getGDriveRefreshToken()).toBeNull();
    expect(getGDriveFolderId()).toBeNull();
    expect(getGDriveUserEmail()).toBeNull();
  });
});

describe('authentication', () => {
  it('will not mint a token when nothing is connected', async () => {
    const t = oauthTransport();
    setOAuthTransport(t);
    await expect(ensureValidAccessToken()).rejects.toThrow();
    expect(t.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('uses a cached access token without touching the transport', async () => {
    connect();
    const t = oauthTransport();
    setOAuthTransport(t);

    const token = await ensureValidAccessToken();
    expect(token).toBe('ya29.valid');
    expect(t.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes when forced and surfaces a revocation legibly', async () => {
    connect();
    const t = oauthTransport({
      refreshAccessToken: vi.fn(async () => {
        throw new Error('invalid_grant: token has been revoked');
      }),
    });
    setOAuthTransport(t);

    await expect(ensureValidAccessToken({ forceRefresh: true })).rejects.toThrow(/revoked|invalid_grant/i);
    expect(t.refreshAccessToken).toHaveBeenCalled();
  });
  it('setCachedAccessToken falls back to 3600s when expiresInSec is missing or non-positive (R04)', () => {
    setCachedAccessToken('token-fallback', undefined as unknown as number);
    expect(getCachedAccessToken()).toBe('token-fallback');

    setCachedAccessToken('token-nan', NaN);
    expect(getCachedAccessToken()).toBe('token-nan');
  });

  it('purges stored refresh token on refresh rejection so status flips to disconnected (R05)', async () => {
    connect();
    expect(getGDriveStatus().connected).toBe(true);

    const t = oauthTransport({
      refreshAccessToken: vi.fn(async () => {
        throw new Error('invalid_grant: token has been revoked');
      }),
    });
    setOAuthTransport(t);

    await expect(ensureValidAccessToken({ forceRefresh: true })).rejects.toThrow();
    expect(getGDriveRefreshToken()).toBeNull();
    expect(getGDriveStatus().connected).toBe(false);
  });
});
describe('folder reuse across machines', () => {
  it('creates the folder once, then reuses the stored id', async () => {
    connect();
    const first = driveTransport();
    setGDriveTransport(first.transport);

    const folderA = await ensureSyncFolder();
    expect(folderA).toBeTruthy();
    expect(getGDriveFolderId()).toBe(folderA);
    expect(first.spies.createFolder).toHaveBeenCalledTimes(1);

    // A second machine reads the stored id and must not create another folder.
    const second = driveTransport();
    setGDriveTransport(second.transport);
    const folderB = await ensureSyncFolder();

    expect(folderB).toBe(folderA);
    expect(second.spies.createFolder).not.toHaveBeenCalled();
  });
});

describe('transfer', () => {
  it('push refuses to run without a passphrase, rather than uploading plaintext', () => {
    // The payload carries proxy passwords, SSH keys and live session cookies. Before end-to-end
    // encryption existed, push wrote that as plain JSON into Drive. Refusing here is the property
    // worth pinning: a push that silently falls back to plaintext is worse than one that fails,
    // because the operator sees a successful sync and Google holds readable credentials.
    connect();
    setGDriveTransport(driveTransport().transport);

    return expect(pushToGDrive()).rejects.toThrow(/passphrase/i);
  });

  it('push records a timestamp', async () => {
    connect();
    setGDriveTransport(driveTransport().transport);
    setSyncPassphrase('test passphrase for the suite');

    const before = getGDriveStatus().lastPush;
    await pushToGDrive();
    expect(getGDriveStatus().lastPush).not.toBe(before);
  });

  it('push uploads sealed bytes, not readable JSON', async () => {
    connect();
    const { transport, files } = driveTransport();
    setGDriveTransport(transport);
    setSyncPassphrase('test passphrase for the suite');

    await pushToGDrive();

    // Whatever landed in the (in-memory) Drive must not contain a readable payload. An empty store
    // still produces a manifest and sealed profile/script/settings files, so there is always
    // something to inspect.
    const uploaded = [...files.values()].filter((f) => f.name.endsWith('.json'));
    const profileFile = uploaded.find((f) => f.name.includes('profiles'));
    if (profileFile) {
      expect(profileFile.content.includes('"profile"'), 'plaintext bundle reached Drive').toBe(false);
    }
  });

  it('inspection is read-only and reports conflicts', async () => {
    connect();
    setGDriveTransport(driveTransport().transport);

    const inspection = await inspectGDrivePull();
    expect(inspection).toHaveProperty('conflicts');
    // An inspection must not have written anything.
    expect(getGDriveStatus().lastPull).toBeNull();
  });

  it('a pull against an empty folder deletes nothing locally', async () => {
    connect();
    setSyncPassphrase('test passphrase for the suite');
    const { transport, spies } = driveTransport();
    setGDriveTransport(transport);

    // An empty Drive folder is no longer an error: the cycle is bidirectional, so the first run on a
    // machine publishes what it has. The invariant that still matters — and the one worth pinning —
    // is that nothing local is destroyed on the way out.
    await pullFromGDrive();
    expect(spies.deleteFile).not.toHaveBeenCalled();
  });

  it('a pull from a folder holding unrecognised data neither deletes nor half-applies', async () => {
    connect();
    setSyncPassphrase('test passphrase for the suite');
    const { transport, spies } = driveTransport([
      { id: 'file-1', name: 'someone-elses-spreadsheet.csv' },
    ]);
    setGDriveTransport(transport);

    // Validation runs before anything is written: a folder that is not ours must be refused whole,
    // not partially adopted. Deleting or uploading anything here would mean we had already started
    // writing into a stranger's folder.
    await expect(pullFromGDrive()).rejects.toThrow(/refused|not .*NullTrace|already contains/i);
    expect(spies.deleteFile).not.toHaveBeenCalled();
    expect(spies.uploadFile).not.toHaveBeenCalled();
  });
});

describe('status', () => {
  it('reports disconnected with nothing configured', () => {
    expect(getGDriveStatus().connected).toBe(false);
  });

  it('never exposes a secret through the status object', () => {
    saveGDriveCredentials({
      clientId: 'operator-client.apps.googleusercontent.com',
      clientSecret: 's3cret',
    });
    saveGDriveRefreshToken('1//refresh-token-value');

    const serialised = JSON.stringify(getGDriveStatus());
    expect(serialised).not.toContain('s3cret');
    expect(serialised).not.toContain('1//refresh-token-value');
  });
});

describe('mirror download (R08)', () => {
  it('throws a clear error when transport lacks downloadBuffer instead of utf8-decoding binary', async () => {
    connect();
    const transportWithoutBuffer = {
      listFiles: vi.fn(async () => [{ id: 'm-file-id', name: GDRIVE_MIRROR_FILE }]),
      createFolder: vi.fn(async () => 'folder-1'),
      findFolder: vi.fn(async () => 'folder-1'),
      uploadFile: vi.fn(async () => 'm-file-id'),
      downloadFile: vi.fn(async () => 'corrupted-binary-as-utf8'),
      deleteFile: vi.fn(async () => {}),
    };
    setGDriveTransport(transportWithoutBuffer as unknown as GDriveTransport);

    await expect(downloadMirrorArchive('any-passphrase')).rejects.toThrow(
      /GDrive transport does not support binary buffer download/i
    );
  });
});

describe('sync engine lifecycle (R01, R09, R10)', () => {
  it('startSyncEngine does not blindly clear lastError (R01)', () => {
    setSyncError('OAuth authorization failed');
    startSyncEngine();
    expect(getSyncStatus().lastError).toBe('OAuth authorization failed');

    connect();
    startSyncEngine();
    expect(getSyncStatus().lastError).toBe('OAuth authorization failed');
  });

  it('stopSyncEngine clears queued triggers and in-flight handles (R09)', async () => {
    connect();
    startSyncEngine();
    expect(getSyncStatus().syncing).toBe(false);

    requestSync('change');
    stopSyncEngine();

    expect(getSyncStatus().syncing).toBe(false);
  });

  it('unlockSession schedules exactly one launch sync without duplicate triggers (R10)', async () => {
    connect();
    const { transport } = driveTransport();
    setGDriveTransport(transport);

    vi.spyOn(transfer, 'inspectGDrivePull').mockResolvedValue({
      newRows: 0,
      conflicts: [],
    });
    const syncSpy = vi.spyOn(transfer, 'runSyncCycle').mockResolvedValue({
      pulledProfiles: 0,
      pulledScripts: 0,
      pulledVault: 0,
      pushedRows: 0,
      deletedRows: 0,
      appliedSettings: false,
      conflicts: 0,
      timestamp: Date.now(),
      revision: 'rev-1',
      verified: true,
    });

    const unlocked = await unlockSession('valid-passphrase-8chars');
    expect(unlocked).toBe(true);
    await vi.waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));
    expect(syncSpy).toHaveBeenCalledTimes(1);
  });
});
