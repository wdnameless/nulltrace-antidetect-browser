import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchWithTimeout,
  extractHost,
  formatTimeoutError,
  DEFAULT_FETCH_TIMEOUT_MS,
  PAYLOAD_FETCH_TIMEOUT_MS,
} from '../../../src/main/cloud/fetchWithTimeout';
import {
  getSyncStatus,
  getSyncLog,
  stopSyncEngine,
  requestSync,
  unlockSession,
  clearSyncSession,
  setSyncStartedAtForTest,
  setIsSyncingForTest,
  setPhaseForTest,
  waitForSyncIdleForTest,
  STUCK_CEILING_MS,
} from '../../../src/main/cloud/gdriveSync';
import {
  setGDriveStorage,
  saveGDriveCredentials,
  saveGDriveRefreshToken,
  type GDriveStorageAdapter,
} from '../../../src/main/cloud/gdriveAuth';
import {
  setGDriveTransport,
  type GDriveTransport,
} from '../../../src/main/cloud/gdriveTransfer';
import { makePassphraseVerifier } from '../../../src/main/cloud/syncCrypto';
import { setSetting } from '../../../src/main/config';
import { initDb, closeDb } from '../../../src/main/db';

function makeStorage(): GDriveStorageAdapter {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}

describe('fetchWithTimeout', () => {
  it('extracts URL host safely without leaking tokens', () => {
    const sensitiveUrl =
      'https://oauth2.googleapis.com/token?access_token=SUPER_SECRET_TOKEN&refresh_token=ANOTHER_SECRET';
    const host = extractHost(sensitiveUrl);
    expect(host).toBe('oauth2.googleapis.com');
    expect(host).not.toContain('SUPER_SECRET');

    const err = formatTimeoutError(sensitiveUrl, 60_000);
    expect(err.message).toContain('oauth2.googleapis.com');
    expect(err.message).toContain('60s');
    expect(err.message).toContain('60000ms');
    expect(err.message).not.toContain('SUPER_SECRET');
  });

  it('rejects with timeout error when request hangs beyond ceiling', async () => {
    // Hanging request with short timeout
    const hangingUrl = 'https://www.googleapis.com/drive/v3/files?secret=SECRET123';
    await expect(
      fetchWithTimeout(hangingUrl, undefined, 25)
    ).rejects.toThrow(/timed out after 25ms/);

    try {
      await fetchWithTimeout(hangingUrl, undefined, 25);
    } catch (err: unknown) {
      expect(err instanceof Error).toBe(true);
      if (err instanceof Error) {
        expect(err.message).toContain('www.googleapis.com');
        expect(err.message).not.toContain('SECRET123');
      }
    }
  });

  it('exports expected default and payload timeout constants', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(60_000);
    expect(PAYLOAD_FETCH_TIMEOUT_MS).toBe(300_000);
  });
});

describe('sync watchdog and stuck detection', () => {
  beforeEach(() => {
    clearSyncSession();
  });

  afterEach(() => {
    setIsSyncingForTest(false);
    setSyncStartedAtForTest(null);
    setPhaseForTest('idle');
  });

  it('reports stuck: false when not syncing even if start time is old', () => {
    setIsSyncingForTest(false);
    setSyncStartedAtForTest(Date.now() - 10 * 60 * 1000);
    const status = getSyncStatus();
    expect(status.syncing).toBe(false);
    expect(status.stuck).toBe(false);
  });

  it('reports stuck: false when syncing is within 5-minute ceiling', () => {
    setIsSyncingForTest(true);
    setSyncStartedAtForTest(Date.now() - 2 * 60 * 1000); // 2 minutes ago
    const status = getSyncStatus();
    expect(status.syncing).toBe(true);
    expect(status.stuck).toBe(false);
  });

  it('reports stuck: true when syncing exceeds 5-minute ceiling', () => {
    setIsSyncingForTest(true);
    setSyncStartedAtForTest(Date.now() - (STUCK_CEILING_MS + 10_000)); // > 5 minutes
    const status = getSyncStatus();
    expect(status.syncing).toBe(true);
    expect(status.stuck).toBe(true);
  });

  it('reports additive phase and syncStartedAt fields', () => {
    const started = Date.now() - 5000;
    setIsSyncingForTest(true);
    setSyncStartedAtForTest(started);
    setPhaseForTest('inspecting');

    const status = getSyncStatus();
    expect(status.phase).toBe('inspecting');
    expect(status.syncStartedAt).toBe(started);
    expect(status.stuck).toBe(false);
  });
});

describe('hanging cycle fails and resets isSyncing', () => {
  beforeEach(async () => {
    await initDb();
    clearSyncSession();
    setGDriveStorage(makeStorage());
    saveGDriveCredentials({ clientId: 'operator.apps.googleusercontent.com' });
    saveGDriveRefreshToken('1//fake-refresh-token');
  });

  afterEach(() => {
    stopSyncEngine();
    closeDb();
  });

  it('cycle fails with timeout row and resets isSyncing when transport call times out', async () => {
    const hangingTransport: GDriveTransport = {
      listFiles: vi.fn(async () => {
        throw new Error('Request to www.googleapis.com timed out after 60s (60000ms)');
      }),
      createFolder: vi.fn(async () => 'folder-1'),
      findFolder: vi.fn(async () => 'folder-1'),
      uploadFile: vi.fn(async () => 'file-1'),
      downloadFile: vi.fn(async () => ''),
      downloadBuffer: vi.fn(async () => Buffer.alloc(0)),
      deleteFile: vi.fn(async () => {}),
    };

    setSetting('syncPassphraseVerifier', makePassphraseVerifier('my test passphrase 123').toString('base64'));
    // Hanging transport BEFORE unlock: the verifier check is local (no network), so unlock
    // succeeds, then its launch cycle fails on the hanging transport.
    setGDriveTransport(hangingTransport);
    const unlocked = await unlockSession('my test passphrase 123');
    expect(unlocked).toBe(true);
    // Unlock fired a launch cycle that is still in flight; requestSync piggybacks on it.
    // waitForSyncIdleForTest then settles the launch, the manual, and any queued
    // successor — real engine promises only, no timers.
    await requestSync('manual');
    await waitForSyncIdleForTest();
    const status = getSyncStatus();
    expect(status.syncing).toBe(false);
    expect(status.phase).toBe('idle');
    expect(status.lastError).toContain('timed out after 60s');
    // Confirm that a log row was recorded
    const log = getSyncLog(5);
    expect(log.length).toBeGreaterThan(0);
    const lastEntry = log[0];
    expect(lastEntry.outcome).toBe('failed');
    expect(lastEntry.error).toContain('timed out');
  });
});
