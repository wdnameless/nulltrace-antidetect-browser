/**
 * Three-way merge over row hashes.
 *
 * The one-way design compared timestamps and then either overwrote everything or aborted. That is
 * not a sync: it cannot tell "changed here" from "changed there" from "changed in both places", and a
 * deletion on one machine is indistinguishable from a row that machine never had.
 *
 * The fix is a **base snapshot** — the row hashes as of the last successful sync, stored locally.
 * With local, base and remote in hand, every row's fate is decidable:
 *
 * | local vs base | remote vs base | outcome |
 * |---|---|---|
 * | unchanged | changed | apply remote |
 * | changed | unchanged | push local |
 * | unchanged | unchanged | nothing |
 * | changed | changed, same hash | nothing |
 * | changed, differing | changed, differing | conflict → policy |
 * | **row gone** | present | local deletion → tombstone propagates |
 * | present | **row gone** | remote deletion → delete applies here |
 *
 * The last two rows are what make deletions work. Without them a profile deleted on machine A is
 * simply absent from A's payload, so machine B still has it, still finds it "newer", and pushes it
 * back — which is exactly the resurrection the old design produced.
 *
 * Tombstones are carried IN the payload rather than only locally, because a machine that has been
 * offline for a month has never seen a tombstone recorded on another machine, and would otherwise
 * treat the deleted row as a local addition and push it straight back.
 *
 * The base snapshot is machine state, not user data: it is never uploaded, and it is stored beside
 * the database rather than in settings.json.
 */

import * as fs from 'fs';
import {
  SYNC_TABLES_SORTED,
  BASE_SNAPSHOT_PATH,
  dumpTable,
  hashRow,
  rowKey,
  type EntityTable,
  type GDriveScope,
  isTableEnabledInScope,
} from './syncEntities';

/** `table -> key -> hash`, the shape of both the base snapshot and a computed row-hash set. */
export type RowHashes = Record<string, Record<string, string>>;

/** `table -> key -> portable row`. */
export type PortableRows = Record<string, Record<string, Record<string, unknown>>>;

/** `table -> key -> delete timestamp`. A tombstone outlives the row it deleted. */
export type Tombstones = Record<string, Record<string, number>>;

export type MergeResolution = 'keep_local' | 'overwrite_remote';

export interface MergeConflict {
  table: string;
  key: string;
  localHash: string;
  remoteHash: string;
}

export interface MergeResult {
  /** Rows to write locally, already merged, in table apply order. */
  rows: Array<{ table: string; portable: Record<string, unknown> }>;
  /** Rows to delete locally. */
  deletes: Array<{ table: string; key: string }>;
  /** What the next push must contain: merged rows plus retained bodies for tombstoned keys. */
  outgoing: PortableRows;
  /** Tombstones the merge produced or inherited, to be persisted and re-uploaded. */
  tombstones: Tombstones;
  conflicts: MergeConflict[];
  counts: { pulled: number; pushed: number; deleted: number; unchanged: number };
}

/**
 * How long a tombstone is honoured before it is dropped.
 *
 * A tombstone can only be discarded once every machine has seen it, and machines that are offline
 * for months are normal. 180 days covers a holiday and keeps the payload bounded. A row re-created
 * after its tombstone expired simply arrives as a new row, which is the correct outcome.
 */
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Base snapshot persistence
// ---------------------------------------------------------------------------

/**
 * Read the base snapshot.
 *
 * A missing or unreadable file yields empty maps, which the merge reads as "no baseline" — the
 * correct fallback. With no baseline, `localChanged` and `remoteChanged` are both true for every
 * differing row, so every divergence is reported as a conflict instead of silently resolved.
 */
export function loadBaseSnapshot(): { base: RowHashes; tombstones: Tombstones } {
  try {
    const raw = JSON.parse(fs.readFileSync(BASE_SNAPSHOT_PATH, 'utf8')) as {
      base?: RowHashes;
      tombstones?: Tombstones;
    };
    return { base: raw.base ?? {}, tombstones: raw.tombstones ?? {} };
  } catch {
    return { base: {}, tombstones: {} };
  }
}

/**
 * Persist the base snapshot atomically.
 *
 * Written tmp-then-renamed because a half-written JSON file is indistinguishable from a corrupt one,
 * and a corrupt base degrades every later merge to conflict-everything — silently.
 */
export function saveBaseSnapshot(base: RowHashes, tombstones: Tombstones): void {
  const tmp = `${BASE_SNAPSHOT_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ base, tombstones }), 'utf8');
    fs.renameSync(tmp, BASE_SNAPSHOT_PATH);
  } catch {
    // Best effort: a missing base costs conflict-reporting next run, not data.
  }
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

export function hashLocalTables(): RowHashes {
  const hashes: RowHashes = {};
  for (const spec of SYNC_TABLES_SORTED) {
    const byKey: Record<string, string> = {};
    for (const row of dumpTable(spec)) {
      byKey[rowKey(spec.pk, row)] = hashRow(row, spec.columns);
    }
    hashes[spec.table] = byKey;
  }
  return hashes;
}

/** Read every table into the `table -> key -> row` shape the merge consumes. */
export function dumpAllTables(scope?: Partial<GDriveScope>): PortableRows {
  const rows: PortableRows = {};
  for (const spec of SYNC_TABLES_SORTED) {
    if (scope && !isTableEnabledInScope(spec.table, scope)) {
      rows[spec.table] = {};
      continue;
    }
    const byKey: Record<string, Record<string, unknown>> = {};
    for (const row of dumpTable(spec)) {
      byKey[rowKey(spec.pk, row)] = row;
    }
    rows[spec.table] = byKey;
  }
  return rows;
}

/**
 * Base snapshot for the NEXT run: hashes of whatever the machines now agree on.
 *
 * It describes `outgoing`, not the merged local state — the base must be the state both sides hold,
 * or the next run would compare against a baseline neither side ever had.
 */
export function nextBaseSnapshot(
  result: MergeResult,
  tables: readonly EntityTable[],
  previousBase?: RowHashes | null
): RowHashes {
  const base: RowHashes = {};
  for (const spec of tables) {
    if (result.outgoing[spec.table] !== undefined) {
      const byKey: Record<string, string> = {};
      for (const [key, row] of Object.entries(result.outgoing[spec.table] ?? {})) {
        byKey[key] = hashRow(row, spec.columns);
      }
      base[spec.table] = byKey;
    } else if (previousBase?.[spec.table]) {
      base[spec.table] = previousBase[spec.table];
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/**
 * Merge local and remote into a single converged state.
 *
 * `remote` of `null` means there is no remote revision at all (a first run, or an empty folder), so
 * everything local is pushed as-is and nothing is pulled.
 *
 * `outgoing` is what the push writes, and it is the MERGED state rather than the local state.
 * Pushing local after applying remote would undo the merge on the other machine, which is how a
 * naive pull-then-push loop oscillates forever.
 */
export function mergeTables(args: {
  local: PortableRows;
  base: RowHashes | null;
  remote: PortableRows | null;
  tombstones?: Tombstones;
  remoteTombstones?: Tombstones;
  resolution: MergeResolution;
  now?: number;
  scope?: Partial<GDriveScope>;
}): MergeResult {
  const { local, base, remote, resolution, scope } = args;
  const now = args.now ?? Date.now();
  const knownTombstones = args.tombstones ?? {};
  const incomingTombstones = args.remoteTombstones ?? {};

  const rows: MergeResult['rows'] = [];
  const deletes: MergeResult['deletes'] = [];
  const outgoing: PortableRows = {};
  const tombstones: Tombstones = {};
  const conflicts: MergeConflict[] = [];
  const counts = { pulled: 0, pushed: 0, deleted: 0, unchanged: 0 };

  for (const spec of SYNC_TABLES_SORTED) {
    const table = spec.table;
    if (scope && !isTableEnabledInScope(table, scope)) {
      continue;
    }
    const localTable = local[table] ?? {};
    const remoteTable = remote ? (remote[table] ?? null) : null;
    const baseTable = base?.[table] ?? {};
    const localTombs = knownTombstones[table] ?? {};
    const remoteTombs = incomingTombstones[table] ?? {};

    const outTable: Record<string, Record<string, unknown>> = {};

    // The union of every key any side knows about. A key present on one side only IS the
    // added/deleted case, so the union is what makes those decidable at all.
    const keys = new Set([
      ...Object.keys(localTable),
      ...Object.keys(remoteTable ?? {}),
      ...Object.keys(baseTable),
    ]);

    for (const key of keys) {
      const localRow = localTable[key];
      const remoteRow = remoteTable ? remoteTable[key] : undefined;
      const baseHash = baseTable[key];

      /*
       * A live tombstone is a deletion, and row comparison must not second-guess it: the row body
       * deliberately stays in the payload so an un-delete has content to restore, which means the
       * delete would otherwise read as "unchanged" and the row would never go away.
       *
       * One exception, and it is the operator's own action: if the local row has CHANGED since the
       * baseline that recorded the tombstone, this machine was deliberately edited after the delete —
       * in practice, the operator hit Restore. Honouring the tombstone there re-trashes the profile on
       * every cycle and the restore can never stick, which is worse than a stale tombstone.
       */
      const deletedAt = remoteTombs[key] ?? localTombs[key];
      if (deletedAt !== undefined && now - deletedAt <= TOMBSTONE_TTL_MS) {
        const restoredLocally =
          localRow !== undefined &&
          baseHash !== undefined &&
          hashRow(localRow, spec.columns) !== baseHash;
        if (restoredLocally) {
          // The local edit wins and the tombstone is dropped, so the next cycle converges instead of
          // oscillating between the two machines.
          outTable[key] = localRow;
          counts.pushed++;
          continue;
        }
        tombstones[table] = { ...(tombstones[table] ?? {}), [key]: deletedAt };
        if (localRow) {
          deletes.push({ table, key });
          counts.deleted++;
        }
        if (remoteRow) outTable[key] = remoteRow;
        continue;
      }

      // No remote revision: nothing to reconcile, local wins outright.
      if (remoteTable === null) {
        if (localRow) {
          outTable[key] = localRow;
          counts.pushed++;
        }
        continue;
      }

      // Local row absent. Was it deleted here, or simply never here?
      if (!localRow) {
        if (!remoteRow) continue;
        if (baseHash === undefined) {
          // No baseline for this key: the remote has a row this machine has never seen, so it is an
          // addition to be pulled — the normal state for a second machine on its first sync. Treating
          // it as a deletion here is what made a fresh install silently ignore the whole remote
          // payload and report a successful sync.
          rows.push({ table, portable: remoteRow });
          outTable[key] = remoteRow;
          counts.pulled++;
          continue;
        }
        // Known before, gone now, still on the remote: a local deletion, which travels as a
        // tombstone so the other machine stops resurrecting it. When both sides deleted it the remote
        // is already gone and no tombstone is needed — the absence itself says so.
        tombstones[table] = { ...(tombstones[table] ?? {}), [key]: now };
        outTable[key] = remoteRow;
        counts.deleted++;
        continue;
      }

      // Local row present, remote row absent. Known to the base on both sides → remote deleted it.
      if (!remoteRow) {
        if (baseHash !== undefined) {
          deletes.push({ table, key });
          counts.deleted++;
          continue;
        }
        // Remote never had it: a local addition.
        outTable[key] = localRow;
        counts.pushed++;
        continue;
      }

      const localHash = hashRow(localRow, spec.columns);
      const remoteHash = hashRow(remoteRow, spec.columns);

      if (localHash === remoteHash) {
        // Identical on both sides. Travels so the remote keeps the row even when nothing else in
        // this table changed — an unchanged row must not be dropped from the next payload.
        outTable[key] = localRow;
        counts.unchanged++;
        continue;
      }

      const localChanged = baseHash === undefined || localHash !== baseHash;
      const remoteChanged = baseHash === undefined || remoteHash !== baseHash;

      if (!localChanged && remoteChanged) {
        rows.push({ table, portable: remoteRow });
        outTable[key] = remoteRow;
        counts.pulled++;
        continue;
      }

      if (!localChanged && !remoteChanged) {
        // Equal to the base yet unequal to each other is impossible; treat as unchanged rather than
        // inventing a conflict the operator cannot act on.
        outTable[key] = localRow;
        counts.unchanged++;
        continue;
      }

      if (localChanged && !remoteChanged) {
        outTable[key] = localRow;
        counts.pushed++;
        continue;
      }

      // Both sides changed, and differently. A genuine conflict.
      conflicts.push({ table, key, localHash, remoteHash });
      if (resolution === 'overwrite_remote') {
        rows.push({ table, portable: remoteRow });
        outTable[key] = remoteRow;
        counts.pulled++;
      } else {
        // Default: keep what the operator is looking at, and push it so the remote converges too.
        // Dropping the remote edit instead would silently discard work done on a machine nobody is
        // currently sitting at.
        outTable[key] = localRow;
        counts.pushed++;
      }
    }

    if (Object.keys(outTable).length > 0) outgoing[table] = outTable;
  }

  // `rows` inherits SYNC_TABLES_SORTED order because the loop above iterates it, which is the order
  // FK resolution needs: a profile lands after the group and proxy rows it points at.
  return { rows, deletes, outgoing, tombstones, conflicts, counts };
}