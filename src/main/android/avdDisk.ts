// Disk accounting and cleanup for per-profile AVDs.
//
// Measured problem: 13 profiles occupied 87 GB. Almost all of it was per-AVD `ram.img`
// (6.1 GB for a 6144 MB guest — the hypervisor preallocates its swap image at RAM size) plus a
// `userdata-qemu.img.qcow2` that grows with use. Two leaks made that permanent:
//   1. `purgeProfile` removed only the profile's user-data directory — the AVD lives in
//      `~/.android/avd` and was never deleted, so trashed profiles kept their disks forever;
//   2. nothing ever reported the total, so growth was invisible until the disk was full.
// This module owns both: one inventory call, one reclaim call.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Root every per-profile AVD lives under (the emulator's own home, not the profile dir). */
export function avdRoot(): string {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.android', 'avd');
}

/** AVD name a profile owns. Mirrors `ensureAvd` — the two must agree or cleanup misses. */
export function avdNameFor(profileId: string): string {
  return `antidetect_${profileId.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

function directorySize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += directorySize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      // A file removed mid-walk contributes nothing; the number must not throw.
    }
  }
  return total;
}

/** Largest regular file anywhere under `dir`, or null when it is empty/unreadable. */
function largestFileIn(dir: string): { name: string; bytes: number } | null {
  let best: { name: string; bytes: number } | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = largestFileIn(full);
      if (nested && (!best || nested.bytes > best.bytes)) best = nested;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const size = fs.statSync(full).size;
      if (!best || size > best.bytes) best = { name: entry.name, bytes: size };
    } catch {
      // vanished mid-walk; contributes nothing
    }
  }
  return best;
}

export interface AvdUsage {
  name: string;
  profileId: string | null;
  bytes: number;
  /** Largest single file in the AVD — usually `ram.img`, the hypervisor swap image. */
  largestFile: { name: string; bytes: number } | null;
  modifiedAt: number;
}

export interface AvdInventory {
  root: string;
  totalBytes: number;
  avds: AvdUsage[];
  /** Set when the root is unreadable, so an empty list cannot be mistaken for "no AVDs". */
  error?: string;
}

/** Every `antidetect_*.avd` under the root, with its size and biggest file. */
export function scanAvds(): AvdInventory {
  const root = avdRoot();
  const inv: AvdInventory = { root, totalBytes: 0, avds: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    inv.error = err instanceof Error ? err.message : String(err);
    return inv;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('antidetect_') || !entry.name.endsWith('.avd')) continue;
    const dir = path.join(root, entry.name);
    const bytes = directorySize(dir);
    // Recursive: the dominating file is almost always NESTED
    // (`snapshots/default_boot/ram.img`, measured 6.00 GB), so a direct-children scan reports
    // `userdata-qemu.img` and hides the reason the profile is huge.
    const largestFile = largestFileIn(dir);
    const base = entry.name.slice(0, -'.avd'.length);
    inv.avds.push({
      name: entry.name,
      profileId: base.startsWith('antidetect_') ? base.slice('antidetect_'.length) : null,
      bytes,
      largestFile,
      modifiedAt: (() => {
        try {
          return fs.statSync(dir).mtimeMs;
        } catch {
          return 0;
        }
      })(),
    });
    inv.totalBytes += bytes;
  }
  inv.avds.sort((a, b) => b.bytes - a.bytes);
  return inv;
}

/** Removes one profile's AVD directory and its `.ini`. Returns freed bytes (0 = nothing there). */
export function removeAvdForProfile(profileId: string): number {
  const root = avdRoot();
  const name = avdNameFor(profileId);
  const dir = path.join(root, `${name}.avd`);
  const ini = path.join(root, `${name}.ini`);
  const bytes = directorySize(dir) + (fs.existsSync(ini) ? fs.statSync(ini).size : 0);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ini, { force: true });
  } catch {
    return 0;
  }
  return bytes;
}

/**
 * Deletes AVDs whose profile no longer exists (or is soft-deleted) and that nothing is running.
 *
 * `keep` lists profile ids that must survive regardless — the caller passes the live profiles so
 * a rename or a just-created profile cannot be collected by a stale scan.
 */
export function reclaimOrphanAvds(keep: Set<string>): { removed: string[]; freedBytes: number } {
  const inv = scanAvds();
  const removed: string[] = [];
  let freedBytes = 0;
  for (const avd of inv.avds) {
    if (!avd.profileId) continue;
    if (keep.has(avd.profileId)) continue;
    const freed = removeAvdForProfile(avd.profileId);
    if (freed > 0) {
      removed.push(avd.name);
      freedBytes += freed;
    }
  }
  return { removed, freedBytes };
}

/**
 * Deletes quickboot snapshots older than `olderThanMs`.
 *
 * The snapshot is a CACHE, not data: its `ram.img` is written at guest RAM size (measured:
 * 6.00 GB for a 6144 MB guest) and dominates the per-profile footprint. Dropping it costs one
 * cold boot and nothing else — the profile's own `userdata-qemu.img` is untouched, so installed
 * apps, accounts and the spoofed identity survive.
 *
 * Deliberately NOT automatic on every launch: a cold boot is 90-240 s, and an operator who
 * starts a profile daily should keep the snapshot. The caller chooses.
 */
export function pruneSnapshots(olderThanMs: number, keep: Set<string>): { removed: string[]; freedBytes: number } {
  const root = avdRoot();
  const removed: string[] = [];
  let freedBytes = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, freedBytes };
  }
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('antidetect_') || !entry.name.endsWith('.avd')) continue;
    const base = entry.name.slice(0, -'.avd'.length);
    const profileId = base.startsWith('antidetect_') ? base.slice('antidetect_'.length) : null;
    // A running profile must keep its snapshot: the emulator may be writing to it right now.
    if (profileId && keep.has(profileId)) continue;
    const snapshotsDir = path.join(root, entry.name, 'snapshots');
    let snapshotModified = 0;
    try {
      snapshotModified = fs.statSync(snapshotsDir).mtimeMs;
    } catch {
      continue; // no snapshots dir — nothing to prune
    }
    if (snapshotModified > cutoff) continue;
    const bytes = directorySize(snapshotsDir);
    try {
      fs.rmSync(snapshotsDir, { recursive: true, force: true });
      removed.push(entry.name);
      freedBytes += bytes;
    } catch {
      // locked file: report nothing rather than a number that was not actually freed
    }
  }
  return { removed, freedBytes };
}
