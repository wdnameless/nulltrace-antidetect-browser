import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The AVD root is derived from USERPROFILE/HOME, so each test points those at a temp dir and
 * exercises the real filesystem: the module's whole job is file accounting, and mocking `fs`
 * would test the mock instead of the sizes it reports.
 */
describe('AVD disk accounting (measured growth: 87 GB over 13 profiles)', () => {
  let tmp: string;
  let prevProfile: string | undefined;
  let prevHome: string | undefined;
  let mod: typeof import('../../src/main/android/avdDisk');

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avd-disk-'));
    prevProfile = process.env.USERPROFILE;
    prevHome = process.env.HOME;
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    fs.mkdirSync(path.join(tmp, '.android', 'avd'), { recursive: true });
    mod = await import('../../src/main/android/avdDisk');
  });

  afterEach(() => {
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeAvd(profileId: string, files: Record<string, number>): void {
    const root = path.join(tmp, '.android', 'avd');
    const dir = path.join(root, `${mod.avdNameFor(profileId)}.avd`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, `${mod.avdNameFor(profileId)}.ini`), 'x');
    for (const [name, bytes] of Object.entries(files)) {
      const full = path.join(dir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.alloc(bytes));
    }
  }

  it('reports each AVD with its size and largest file', () => {
    makeAvd('p_one', { 'userdata-qemu.img': 100, 'snapshots/default_boot/ram.img': 5000 });
    makeAvd('p_two', { 'userdata-qemu.img': 300 });
    const inv = mod.scanAvds();
    expect(inv.avds).toHaveLength(2);
    expect(inv.totalBytes).toBe(5400);
    const first = inv.avds[0];
    expect(first.profileId).toBe('p_one');
    expect(first.largestFile?.name).toBe('ram.img');
    expect(first.largestFile?.bytes).toBe(5000);
  });

  it('removes one profile AVD with its .ini and reports freed bytes', () => {
    makeAvd('p_one', { 'userdata-qemu.img': 1234 });
    expect(mod.removeAvdForProfile('p_one')).toBeGreaterThan(1234);
    expect(mod.scanAvds().avds).toHaveLength(0);
  });

  it('reclaims AVDs whose profile is gone, and keeps the ones still live', () => {
    makeAvd('p_live', { 'userdata-qemu.img': 10 });
    makeAvd('p_orphan', { 'userdata-qemu.img': 20 });
    const res = mod.reclaimOrphanAvds(new Set(['p_live']));
    expect(res.removed).toHaveLength(1);
    expect(res.freedBytes).toBeGreaterThan(20);
    const left = mod.scanAvds();
    expect(left.avds.map((a) => a.profileId)).toEqual(['p_live']);
  });

  it('prunes only snapshots older than the cutoff and never a running profile', () => {
    makeAvd('p_old', { 'snapshots/default_boot/ram.img': 4000 });
    makeAvd('p_running', { 'snapshots/default_boot/ram.img': 4000 });
    // Age the snapshot dirs by an hour so a 30-minute cutoff applies to both.
    const ancient = Date.now() - 60 * 60 * 1000;
    for (const id of ['p_old', 'p_running']) {
      const dir = path.join(tmp, '.android', 'avd', `${mod.avdNameFor(id)}.avd`, 'snapshots');
      fs.utimesSync(dir, ancient / 1000, ancient / 1000);
    }
    const res = mod.pruneSnapshots(30 * 60 * 1000, new Set(['p_running']));
    expect(res.removed).toEqual([mod.avdNameFor('p_old') + '.avd']);
    // The running profile keeps its snapshot; the other lost only the cache, not userdata.
    const running = path.join(tmp, '.android', 'avd', `${mod.avdNameFor('p_running')}.avd`, 'snapshots');
    expect(fs.existsSync(running)).toBe(true);
    const pruned = path.join(tmp, '.android', 'avd', `${mod.avdNameFor('p_old')}.avd`, 'snapshots');
    expect(fs.existsSync(pruned)).toBe(false);
  });

  it('keeps userdata when a snapshot is pruned (cache, not data)', () => {
    makeAvd('p_keep', { 'userdata-qemu.img': 777, 'snapshots/default_boot/ram.img': 100 });
    const dir = path.join(tmp, '.android', 'avd', `${mod.avdNameFor('p_keep')}.avd`, 'snapshots');
    const old = (Date.now() - 7200_000) / 1000;
    fs.utimesSync(dir, old, old);
    mod.pruneSnapshots(1000, new Set());
    expect(fs.existsSync(path.join(tmp, '.android', 'avd', `${mod.avdNameFor('p_keep')}.avd`, 'userdata-qemu.img'))).toBe(true);
  });

  it('reports an error instead of a silent empty list when the root is missing', () => {
    fs.rmSync(path.join(tmp, '.android'), { recursive: true, force: true });
    const inv = mod.scanAvds();
    expect(inv.avds).toEqual([]);
    expect(inv.error).toBeTruthy();
  });

  it('names AVDs the same way the launcher does (cleanup would otherwise miss)', () => {
    expect(mod.avdNameFor('p_abc-123')).toBe('antidetect_p_abc-123');
    expect(mod.avdNameFor('p/a b')).toBe('antidetect_p_a_b');
  });
});
