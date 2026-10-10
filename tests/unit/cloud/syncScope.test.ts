/**
 * Two-machine sync scope: profiles travel, categories isolate.
 *
 * Same harness shape as `twowaySync.test.ts` (one shared Drive mock, `becomeFreshMachine`
 * between roles), but each cycle passes an explicit `scope` — which is exactly how two
 * machines with different per-machine settings behave, since scope never travels.
 *
 * This suite is also the hang detector for "profiles never arrive": every cycle below must
 * complete. A cycle that throws or never resolves fails loudly instead of sitting at
 * "Syncing... / Last Synced: Never" the way the UI did.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { initDb, closeDb, getDb } from '../../../src/main/db';
import {
  setGDriveStorage,
  saveGDriveCredentials,
  saveGDriveRefreshToken,
  type GDriveStorageAdapter,
} from '../../../src/main/cloud/gdriveAuth';
import {
  setGDriveTransport,
  runSyncCycle,
  type GDriveTransport,
  type DriveFileInfo,
} from '../../../src/main/cloud/gdriveTransfer';
import {
  SYNC_TABLES,
  SYNC_CATEGORY_TABLES,
  DEFAULT_GDRIVE_SCOPE,
  type GDriveScope,
} from '../../../src/main/cloud/syncEntities';
import { BASE_SNAPSHOT_PATH } from '../../../src/main/cloud/syncEntities';
import { createProfile } from '../../../src/main/profiles/profileManager';
import { setSetting, getSetting, SETTINGS_SYNC_DENYLIST } from '../../../src/main/config';
import { setGDriveScope, getGDriveScope } from '../../../src/main/cloud/gdriveSync';

const PASSPHRASE = 'a passphrase long enough to matter';
const ALL_ON: GDriveScope = { ...DEFAULT_GDRIVE_SCOPE };

function makeStorage(): GDriveStorageAdapter {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}

function sharedDrive() {
  const files = new Map<string, { name: string; content: Buffer; modifiedTime: string }>();
  let seq = 0;
  const transport: GDriveTransport = {
    listFiles: vi.fn(async (): Promise<DriveFileInfo[]> =>
      [...files.entries()].map(([id, v]) => ({ id, name: v.name, modifiedTime: v.modifiedTime }))
    ),
    createFolder: vi.fn(async () => 'folder-1'),
    findFolder: vi.fn(async () => 'folder-1'),
    uploadFile: vi.fn(async (name: string, content: string | Buffer, _folder: string, existing?: string) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      if (existing && files.has(existing)) {
        files.set(existing, { name, content: bytes, modifiedTime: new Date().toISOString() });
        return existing;
      }
      const id = `file-${++seq}`;
      files.set(id, { name, content: bytes, modifiedTime: new Date().toISOString() });
      return id;
    }),
    downloadFile: vi.fn(async (id: string) => files.get(id)?.content.toString('utf8') ?? ''),
    downloadBuffer: vi.fn(async (id: string) => files.get(id)?.content ?? Buffer.alloc(0)),
    deleteFile: vi.fn(async (id: string) => void files.delete(id)),
  };
  return { transport, files };
}

function connectAsOperator(): void {
  setGDriveStorage(makeStorage());
  saveGDriveCredentials({ clientId: 'operator.apps.googleusercontent.com' });
  saveGDriveRefreshToken('1//refresh');
}

const SYNCED_TABLES: readonly string[] = [
  'profile_tags', 'profile_extensions', 'account_credentials', 'triggers',
  'profiles', 'scripts', 'tags', 'extensions', 'fingerprints',
  'proxies', 'groups', 'global_keys',
];

function becomeFreshMachine(): void {
  const db = getDb();
  for (const t of SYNCED_TABLES) {
    try {
      db.prepare(`DELETE FROM ${t}`).run(); // pi-lens-ignore: sql-injection
    } catch {
      /* table absent in this build */
    }
  }
  fs.rmSync(BASE_SNAPSHOT_PATH, { force: true });
}

let drive: ReturnType<typeof sharedDrive>;

beforeEach(async () => {
  await initDb();
  becomeFreshMachine();
  drive = sharedDrive();
  setGDriveTransport(drive.transport);
  connectAsOperator();
});

afterEach(() => {
  closeDb();
  fs.rmSync(BASE_SNAPSHOT_PATH, { force: true });
});

describe('scope map completeness', () => {
  it('covers every sync table exactly once', () => {
    const mapped = Object.values(SYNC_CATEGORY_TABLES).flat();
    const specTables = SYNC_TABLES.map((s) => s.table).sort();
    expect([...mapped].sort()).toEqual(specTables);
    expect(new Set(mapped).size).toBe(mapped.length);
  });
});

// Full cycles with real crypto; under parallel CI load a single cycle was measured well
// above the default hook ceiling, so the file carries its own timeout like twowaySync.
describe('two machines', { timeout: 120000 }, () => {
  it('a profile created on A arrives on B with its operator fields', async () => {
    const id = createProfile({ name: 'Traveler', timezone: 'Europe/Berlin' });
    expect(id).toBeTruthy();
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    becomeFreshMachine();
    connectAsOperator();
    const result = await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    expect(result.verified).toBe(true);
    const row = getDb().prepare('SELECT * FROM profiles WHERE name = ?').get('Traveler') as
      | Record<string, unknown>
      | undefined;
    expect(row, 'profile did not arrive on the second machine').toBeTruthy();
    expect(row?.timezone).toBe('Europe/Berlin');
  });

  it('a proxy created on B arrives on A', async () => {
    // A syncs first (empty), then B adds a proxy and syncs; A pulls it.
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    becomeFreshMachine();
    connectAsOperator();
    getDb()
      .prepare(
        'INSERT INTO proxies (id, type, host, port, username, password, status, created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run('px-scope', 'http', '10.9.9.9', 8080, 'u', 'pw', 'unknown', Date.now());
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    becomeFreshMachine();
    connectAsOperator();
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    const row = getDb().prepare('SELECT * FROM proxies WHERE id = ?').get('px-scope');
    expect(row, 'proxy did not arrive back on the first machine').toBeTruthy();
  });

  it('a setting changed on A arrives on B', async () => {
    setSetting('theme', 'midnight-test-value');
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    becomeFreshMachine();
    connectAsOperator();
    setSetting('theme', 'daylight-before-pull');
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    expect(getSetting('theme')).toBe('midnight-test-value');
  });

  it('proxies OFF isolates proxy rows both directions while profiles converge', async () => {
    const noProxies: GDriveScope = { ...ALL_ON, proxies: false };

    // A (proxies OFF) creates a profile + a proxy and syncs.
    createProfile({ name: 'Scoped' });
    getDb()
      .prepare(
        'INSERT INTO proxies (id, type, host, port, status, created_at) VALUES (?,?,?,?,?,?)'
      )
      .run('px-hidden', 'http', '10.8.8.8', 8080, 'unknown', Date.now());
    await runSyncCycle({ passphrase: PASSPHRASE, scope: noProxies });

    // B (everything ON) pulls: profile arrives, proxy does not.
    becomeFreshMachine();
    connectAsOperator();
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });
    expect(getDb().prepare('SELECT * FROM profiles WHERE name = ?').get('Scoped')).toBeTruthy();
    expect(
      getDb().prepare('SELECT * FROM proxies WHERE id = ?').get('px-hidden'),
      'a proxy crossed despite the sender having proxies OFF'
    ).toBeFalsy();

    // B creates its own proxy and syncs; A (still OFF) pulls: profile converges, proxy stays out.
    getDb()
      .prepare(
        'INSERT INTO proxies (id, type, host, port, status, created_at) VALUES (?,?,?,?,?,?)'
      )
      .run('px-remote', 'http', '10.7.7.7', 8080, 'unknown', Date.now());
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    becomeFreshMachine();
    connectAsOperator();
    // A still has its profile locally (fresh wipe removes it; recreate to prove convergence).
    createProfile({ name: 'Scoped' });
    await runSyncCycle({ passphrase: PASSPHRASE, scope: noProxies });
    expect(
      getDb().prepare('SELECT * FROM proxies WHERE id = ?').get('px-remote'),
      'a remote proxy was applied despite the receiver having proxies OFF'
    ).toBeFalsy();
  });

  it('scope itself never syncs: asymmetric scopes persist across cycles', async () => {
    setGDriveScope({ scripts: false });
    createProfile({ name: 'Scope keeper' });
    await runSyncCycle({ passphrase: PASSPHRASE, scope: { ...ALL_ON, scripts: false } });

    // Peer syncs with everything ON; our stored scope must be untouched afterwards.
    becomeFreshMachine();
    connectAsOperator();
    setGDriveScope({ ...ALL_ON });
    await runSyncCycle({ passphrase: PASSPHRASE, scope: ALL_ON });

    // Back to "our" machine role: the stored scope is whatever THIS process holds — the
    // assertion is that no payload write touched it. Re-read and confirm all-ON as set.
    expect(getGDriveScope().scripts).toBe(true);
    // And the denylist guards the key even if a payload tried to carry it.
    expect(SETTINGS_SYNC_DENYLIST).toContain('gdriveScope');
  });
});
