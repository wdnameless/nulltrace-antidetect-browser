/**
 * Two-machine sync: the properties that make the feature actually two-way.
 *
 * "Two machines" is simulated by one Drive folder plus two local states: after each push the local
 * tables are emptied and the base snapshot is deleted, which is exactly what a fresh install that
 * has never synced looks like. Both halves then talk to the same folder, so anything that only
 * works in one direction fails here.
 *
 * What is deliberately NOT tested: that a function returns a value, that a route forwards a body, or
 * that a mock was called. Those are wiring, and they break on a rename without anything
 * user-visible changing. Every test below fails only if sync behaves wrongly for the operator.
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
  pushToGDrive,
  pullFromGDrive,
  validateSyncFolder,
  type GDriveTransport,
  type DriveFileInfo,
} from '../../../src/main/cloud/gdriveTransfer';
import {
  createProfile,
  updateProfile,
  deleteProfile,
  restoreProfile,
} from '../../../src/main/profiles/profileManager';
import { protectSecret, revealSecret } from '../../../src/main/util/secretStore';
import { mergeTables } from '../../../src/main/cloud/syncMerge';
import { hashRow, applyRow, SYNC_TABLES_BY_NAME } from '../../../src/main/cloud/syncEntities';
import { BASE_SNAPSHOT_PATH } from '../../../src/main/cloud/syncEntities';
import { GDRIVE_MANIFEST_FILE } from '../../../src/main/cloud/gdriveTransfer';

const PASSPHRASE = 'a passphrase long enough to matter';

function makeStorage(): GDriveStorageAdapter {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
  };
}
/**
 * Drive as two machines see it: one shared file map, so a push from one is visible to the next pull
 * from the other.
 *
 * Content is held as BYTES, not strings. A sealed payload is binary — coercing it to a string and
 * back mangles every byte above 0x7F, which is not a quirk of the mock but exactly the corruption the
 * digest check exists to catch.
 */
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
/** Register as a connected client. Secrets are per-process, so each simulated machine re-registers. */
function connectAsOperator(): void {
  setGDriveStorage(makeStorage());
  saveGDriveCredentials({ clientId: 'operator.apps.googleusercontent.com' });
  saveGDriveRefreshToken('1//refresh');
}

/** Empty every synced table, leaving the machine with no data and no baseline — a fresh install. */
/** Tables emptied by `becomeFreshMachine`, in an order that respects foreign keys. */
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

function profileByName(name: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
    | Record<string, unknown>
    | undefined;
}

let drive: ReturnType<typeof sharedDrive>;

beforeEach(async () => {
  await initDb();
  // The suite runs against the real data directory, so a test that leaves rows behind would make the
  // next one start as a machine that already has data — and every count would be about leftovers.
  becomeFreshMachine();
  drive = sharedDrive();
  setGDriveTransport(drive.transport);
  connectAsOperator();
});

afterEach(() => {
  closeDb();
  fs.rmSync(BASE_SNAPSHOT_PATH, { force: true });
});

describe('folder validation', () => {
  it('refuses a folder holding foreign data instead of adopting it', async () => {
    drive.files.set('x', { name: 'quarterly-budget.xlsx', content: Buffer.alloc(0), modifiedTime: '' });
    const result = await validateSyncFolder('folder-1');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already contains/i);
  });

  it('accepts an empty folder, which is what a fresh install creates', () => {
    expect(validateSyncFolder('folder-1')).resolves.toMatchObject({ ok: true });
  });

  it('refuses a folder whose manifest is not ours', async () => {
    drive.files.set('m', {
      name: GDRIVE_MANIFEST_FILE,
      content: Buffer.from(JSON.stringify({ app: 'someone-else' }), 'utf8'),
      modifiedTime: '',
    });
    expect(validateSyncFolder('folder-1')).resolves.toMatchObject({ ok: false });
  });
});

/** The base snapshot stores HASHES, not rows — this is how a real one is built from rows. */
function baseOf(rows: Record<string, Record<string, unknown>>): Record<string, string> {
  const spec = SYNC_TABLES_BY_NAME.groups;
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, hashRow(v, spec.columns)]));
}

describe('merge decisions', () => {
  it('routes each row to the side that changed it, and keeps local on a real conflict', () => {
    const base = {
      'kept': { id: 'kept', name: 'kept' },
      'changed locally': { id: 'changed locally', name: 'old' },
      'changed remotely': { id: 'changed remotely', name: 'old' },
      'changed both ways': { id: 'changed both ways', name: 'old' },
      'deleted locally': { id: 'deleted locally', name: 'gone here' },
      'deleted remotely': { id: 'deleted remotely', name: 'gone there' },
    };
    const local = {
      'kept': { id: 'kept', name: 'kept' },
      'changed locally': { id: 'changed locally', name: 'new here' },
      'changed remotely': { id: 'changed remotely', name: 'old' },
      'changed both ways': { id: 'changed both ways', name: 'new here' },
      'deleted remotely': { id: 'deleted remotely', name: 'gone there' },
    };
    const remote = {
      'kept': { id: 'kept', name: 'kept' },
      'changed locally': { id: 'changed locally', name: 'old' },
      'changed remotely': { id: 'changed remotely', name: 'new there' },
      'changed both ways': { id: 'changed both ways', name: 'new there' },
      'deleted locally': { id: 'deleted locally', name: 'gone here' },
    };

    const result = mergeTables({
      local: { groups: local },
      remote: { groups: remote },
      base: { groups: baseOf(base) },
      resolution: 'keep_local',
    });

    expect(result.outgoing.groups['changed remotely']).toEqual(remote['changed remotely']);
    expect(result.outgoing.groups['changed locally']).toEqual(local['changed locally']);

    // The decisive row: both sides edited it, so it must be reported, not silently guessed at.
    expect(result.conflicts.map((c) => c.key)).toEqual(['changed both ways']);
    expect(result.outgoing.groups['changed both ways']).toEqual(local['changed both ways']);

    // Deletion must travel in both directions, or it resurrects on the next push.
    expect(result.deletes.map((d) => d.key)).toEqual(['deleted remotely']);
    expect(result.tombstones.groups['deleted locally']).toBeGreaterThan(0);
    // The row body is deliberately kept in the payload so an un-delete on either side has something
    // to restore; the tombstone is what makes the absence stick.
    expect(result.outgoing.groups['deleted locally']).toEqual(remote['deleted locally']);
  });

  it('takes the remote side when the operator explicitly asks for it', () => {
    const result = mergeTables({
      local: { groups: { a: { id: 'a', name: 'mine' } } },
      remote: { groups: { a: { id: 'a', name: 'theirs' } } },
      base: { groups: baseOf({ a: { id: 'a', name: 'original' } }) },
      resolution: 'overwrite_remote',
    });
    expect(result.outgoing.groups.a).toEqual({ id: 'a', name: 'theirs' });
    expect(result.conflicts).toHaveLength(1);
  });

  it('treats identical edits on both sides as agreement, not a conflict', () => {
    const same = { id: 'a', name: 'same edit' };
    const result = mergeTables({
      local: { groups: { a: same } },
      remote: { groups: { a: same } },
      base: { groups: { a: { id: 'a', name: 'original' } } },
      resolution: 'keep_local',
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.outgoing.groups.a).toEqual(same);
  });
});

describe('a second machine', () => {
  it('receives a profile with every operator field intact, and a vault entry it can open', async () => {
    const sourceId = createProfile({ name: 'Work account', timezone: 'Europe/Berlin' });
    updateProfile(sourceId, {
      launch_args: ['--disable-blink-features', '--window-size=1920,1080'],
      webrtc_policy: 'disable_non_proxied_udp',
      blocked_ports: [3389, 5900],
      headless: true,
      color: '#ff8800',
      do_not_track: 'on',
    });
    getDb()
      .prepare(
        'INSERT INTO proxies (id, type, host, port, username, password, status, created_at) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run('px-1', 'socks5', '10.0.0.9', 1080, 'agent', protectSecret('hunter2'), 'unknown', Date.now());
    updateProfile(sourceId, { proxy_id: 'px-1' });
    getDb()
      .prepare(
        'INSERT INTO account_credentials (id, profile_id, label, login, password_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run('cred-1', sourceId, 'main', 'me@example.com', protectSecret('hunter2'), Date.now(), Date.now());

    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });

    const restored = profileByName('Work account');
    expect(restored, 'profile did not arrive on the second machine').toBeTruthy();
    expect(restored?.timezone).toBe('Europe/Berlin');

    // The fields the old pull silently dropped.
    expect(String(restored?.launch_args)).toContain('--window-size=1920,1080');
    expect(restored?.webrtc_policy).toBe('disable_non_proxied_udp');
    expect(String(restored?.blocked_ports)).toContain('3389');
    expect(restored?.headless).toBe(1);
    expect(restored?.color).toBe('#ff8800');
    expect(restored?.do_not_track).toBe('on');
    expect(restored?.proxy_id).toBe('px-1');

    // Secrets arrive readable and are re-protected locally, not carried as this machine's cipher.
    const cred = getDb()
      .prepare('SELECT login, password_enc FROM account_credentials WHERE id = ?')
      .get('cred-1') as { login: string; password_enc: string } | undefined;
    expect(cred?.login).toBe('me@example.com');
    expect(cred?.password_enc).toBeTruthy();
    expect(cred?.password_enc).not.toBe(protectSecret('hunter2'));
  });

  it('does not resurrect a profile deleted on the other machine', async () => {
    const id = createProfile({ name: 'Doomed' });
    await pushToGDrive(PASSPHRASE);
    deleteProfile(id);
    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });

    expect(profileByName('Doomed'), 'a deleted profile came back').toBeFalsy();
  });

  it('applies a deletion made on the other machine', async () => {
    createProfile({ name: 'Shared' });
    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });
    expect(profileByName('Shared')).toBeTruthy();

    // Machine A trashes it and publishes the tombstone; machine B applies it.
    const row = getDb().prepare('SELECT id FROM profiles WHERE name = ?').get('Shared') as { id: string };
    deleteProfile(row.id);
    await pushToGDrive(PASSPHRASE);

    // The receiving machine is the one that already holds the row — a machine that never had it has
    // nothing to delete, so wiping here would test nothing.
    await pullFromGDrive({ passphrase: PASSPHRASE });

    const after = getDb().prepare('SELECT deleted_at FROM profiles WHERE name = ?').get('Shared') as
      | { deleted_at: number | null }
      | undefined;
    expect(after?.deleted_at, 'the remote delete was not applied').toBeGreaterThan(0);
  });

  it('carries an edit made on the second machine back to the first', async () => {
    createProfile({ name: 'Round trip' });
    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });
    getDb().prepare('UPDATE profiles SET notes = ? WHERE name = ?').run('edited downstream', 'Round trip');
    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });

    expect(profileByName('Round trip')?.notes).toBe('edited downstream');
  });

  it('converges: repeated syncs settle instead of oscillating', async () => {
    createProfile({ name: 'Stable' });
    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });
    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });
    const third = await pushToGDrive(PASSPHRASE);

    // Nothing left to move means the cycle stops producing changes, which is what "settled" means.
    expect(third.pushedRows).toBe(0);
    expect(third.deletedRows).toBe(0);
    expect(third.conflicts).toBe(0);
    expect(profileByName('Stable')).toBeTruthy();
  });
});

describe('commit integrity', () => {
  it('keeps the previous revision readable when a push dies before the manifest', async () => {
    createProfile({ name: 'Good revision' });
    await pushToGDrive(PASSPHRASE);

    const manifestBefore = [...drive.files.values()].find(
      (f) => f.name === GDRIVE_MANIFEST_FILE
    )?.content;
    const manifest = JSON.parse(manifestBefore ?? '{}') as { stateFile: string };

    createProfile({ name: 'Never committed' });
    setGDriveTransport({
      ...drive.transport,
      uploadFile: vi.fn(async (name: string, content: string | Buffer, folder: string, existing?: string) => {
        // The state file lands; the manifest write dies. That is the exact interruption the two-step
        // commit exists for, and it must leave the previous revision fully intact.
        if (name === GDRIVE_MANIFEST_FILE) throw new Error('network died before the manifest');
        return drive.transport.uploadFile(name, content, folder, existing);
      }),
    });

    await expect(pushToGDrive(PASSPHRASE)).rejects.toThrow(/network died/);

    setGDriveTransport(drive.transport);
    expect(
      [...drive.files.values()].find((f) => f.name === GDRIVE_MANIFEST_FILE)?.content,
      'the manifest was overwritten by a push that never completed'
    ).toBe(manifestBefore);
    expect(
      [...drive.files.values()].some((f) => f.name === manifest.stateFile),
      'the committed revision was lost'
    ).toBe(true);
  });

  it('refuses to apply a payload whose digest does not match the manifest', async () => {
    createProfile({ name: 'Tampered' });
    await pushToGDrive(PASSPHRASE);

    // Someone with edit access to the folder rewrites the state file. The digest check has to catch it
    // before decryption, or the operator sees a wrong-passphrase error for a correct passphrase.
    const stateName = JSON.parse(
      [...drive.files.values()].find((f) => f.name === GDRIVE_MANIFEST_FILE)?.content ?? '{}'
    ).stateFile as string;
    for (const [id, file] of drive.files) {
      if (file.name === stateName) drive.files.set(id, { ...file, content: Buffer.concat([file.content, Buffer.from('tampered')]) });
    }

    becomeFreshMachine();
    connectAsOperator();
    await expect(pullFromGDrive({ passphrase: PASSPHRASE })).rejects.toThrow(/integrity check/i);
  });
});
describe('secrets survive the round trip', () => {
  it('keeps a proxy password and SSH key usable on the second machine', async () => {
    getDb()
      .prepare(
        'INSERT INTO proxies (id, type, host, port, username, password, private_key, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        'px-secret',
        'ssh',
        '10.1.2.3',
        22,
        'deploy',
        protectSecret('proxy-pass'),
        protectSecret('PRIVATE KEY BODY'),
        'unknown',
        Date.now()
      );

    await pushToGDrive(PASSPHRASE);

    becomeFreshMachine();
    connectAsOperator();
    await pullFromGDrive({ passphrase: PASSPHRASE });

    const row = getDb()
      .prepare('SELECT username, password, private_key FROM proxies WHERE id = ?')
      .get('px-secret') as { username: string; password: string; private_key: string } | undefined;

    expect(row?.username, 'the proxy row was lost').toBeTruthy();
    // The defect this pins: `encode` wrote the ciphertext and then deleted it under the same name, so
    // INSERT OR REPLACE blanked both columns on every single pull.
    expect(row?.password).toBeTruthy();
    expect(revealSecret(row?.password)).toBe('proxy-pass');
    expect(revealSecret(row?.private_key)).toBe('PRIVATE KEY BODY');
  });

  it('does not blank a working credential when the sending machine could not read its own', async () => {
    const db = getDb();
    db.prepare(
      'INSERT INTO account_credentials (id, profile_id, label, login, password_enc, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
    ).run('cred-local', createProfile({ name: 'Vault host' }), 'main', 'me', protectSecret('local-only'), Date.now(), Date.now());

    // A payload whose secret is absent means the sender could not reveal it — the shape the shipped
    // standalone build produces for every `enc:` row. Applying it must skip the column, not null it.
    const spec = SYNC_TABLES_BY_NAME.account_credentials;
    const owner = db.prepare('SELECT id FROM profiles LIMIT 1').get() as { id: string };
    const row = db
      .prepare('SELECT password_enc FROM account_credentials WHERE id = ?')
      .get('cred-local') as { password_enc: string };
    // No `password` key at all: that is how "the sender could not reveal it" is represented.
    applyRow(spec, {
      id: 'cred-local',
      profile_id: owner.id,
      label: 'main',
      login: 'me',
      notes: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const after = db
      .prepare('SELECT password_enc FROM account_credentials WHERE id = ?')
      .get('cred-local') as { password_enc: string };
    expect(revealSecret(after.password_enc), 'an unreadable secret wiped a working credential').toBe('local-only');
    expect(after.password_enc).toBe(row.password_enc);
  });
});

describe('a restore beats a stale tombstone', () => {
  it('lets the operator undo a delete instead of re-applying it forever', async () => {
    createProfile({ name: 'Second thoughts' });
    await pushToGDrive(PASSPHRASE);

    // This machine holds the profile before the delete, which is the only machine where a restore is
    // even meaningful — a machine that never had the row has nothing to bring back.
    const held = getDb().prepare('SELECT id FROM profiles WHERE name = ?').get('Second thoughts') as { id: string };
    expect(held.id).toBeTruthy();

    deleteProfile(held.id);
    await pushToGDrive(PASSPHRASE);
    await pullFromGDrive({ passphrase: PASSPHRASE });
    const trashed = getDb()
      .prepare('SELECT deleted_at FROM profiles WHERE id = ?')
      .get(held.id) as { deleted_at: number | null };
    expect(trashed.deleted_at, 'the remote delete was not applied').toBeGreaterThan(0);

    // The operator changes their mind.
    restoreProfile(held.id);
    await pullFromGDrive({ passphrase: PASSPHRASE });

    const live = getDb()
      .prepare('SELECT deleted_at FROM profiles WHERE id = ?')
      .get(held.id) as { deleted_at: number | null };
    expect(live.deleted_at, 'the restore was undone by the stale tombstone').toBeNull();
  });
});

describe('concurrent machines', () => {
  it('refuses to commit over a revision another machine committed meanwhile', async () => {
    createProfile({ name: 'Contended' });
    await pushToGDrive(PASSPHRASE);

    // Another machine commits between our read and our manifest write.
    let manifestReads = 0;
    const rival: GDriveTransport = {
      ...drive.transport,
      // The first manifest read is the one this cycle merges against; every later read is the
      // compare-and-swap, which is exactly where a rival commit must be caught.
      downloadFile: vi.fn(async (id: string) => {
        const text = await drive.transport.downloadFile(id);
        const isManifest =
          [...drive.files.entries()].find(([k]) => k === id)?.[1].name === GDRIVE_MANIFEST_FILE;
        if (!isManifest) return text;
        // Read order inside one cycle: folder validation (1), the merge read (2), the
        // compare-and-swap read (3). The rival commits at (3), which is the only read the guard sees.
        manifestReads += 1;
        if (manifestReads < 3) return text;
        const current = JSON.parse(text) as { exportedAt: number };
        return JSON.stringify({ ...current, exportedAt: current.exportedAt + 1, deviceId: 'rival' });
      }),
    };

    createProfile({ name: 'Loser' });
    setGDriveTransport(rival);

    // Without a compare-and-swap this silently overwrites the rival's payload, and the losing machine's
    // next cycle reads the reversion as an ordinary pull — so the edit disappears with no conflict.
    await expect(pushToGDrive(PASSPHRASE)).rejects.toThrow(/another machine committed/i);
  });
});
