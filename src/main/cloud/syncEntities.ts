/**
 * Portable entity layer for cloud sync.
 *
 * Every table the operator would miss on a second machine is described here once: which columns
 * travel, which are machine-local, and in what order rows must be written so foreign keys resolve.
 * The merge engine in `syncMerge.ts` is generic over these specs; nothing here knows about Drive,
 * so the same description serves any future transport.
 *
 * Three rules shape the design:
 *
 * 1. **Secrets travel as plaintext and are re-protected on arrival.** `proxies.password`,
 *    `account_credentials.password_enc` and `global_keys.value_enc` are bound to THIS machine's
 *    secret key. Copying that ciphertext to a peer produces a credential that looks present in the
 *    UI and cannot be opened — the worst shape for this class of bug, because it reads correctly on
 *    the machine that pushed. So `decode` reveals and `encode` re-protects, and the whole payload is
 *    sealed by the sync passphrase underneath.
 *
 * 2. **A row absent locally is a deletion, and it must propagate.** That is why `profiles.deleted_at`
 *    is a portable column: a trashed profile travels as a row carrying its delete stamp instead of
 *    vanishing, which is what stops it resurrecting on the next pull.
 *
 * 3. **Hashes must be stable across machines.** `hashRow` projects only the declared columns and
 *    serialises them with sorted keys, so a row read from SQLite and the same row decoded from
 *    another machine's JSON produce identical hashes.
 */

import { createHash } from 'crypto';
import { getDb } from '../db';
import { DATA_DIR } from '../config';
import { protectSecret, revealSecret } from '../util/secretStore';
import { findProxyByEndpoint } from '../proxy/proxyManager';
import {
  exportProfileBundle,
  importProfileBundle,
  updateProfile,
  getLiveProfile,
  deleteProfile,
  type ProfileBundle,
} from '../profiles/profileManager';

/**
 * Composite key separator.
 *
 * U+0000 is the one character no operator-supplied value can contain — not a name, not a script
 * body, not a base64 blob — so a joined key can never be ambiguous between `["ab","c"]` and
 * `["a","bc"]`.
 */
const KEY_SEP = '\u0000';

export interface EntityCodec {
  /** Stored row → portable form (secrets revealed). */
  decode(row: Record<string, unknown>): Record<string, unknown>;
  /** Portable form → stored column values (secrets re-protected). */
  encode(portable: Record<string, unknown>): Record<string, unknown>;
}

export interface EntityTable {
  /** Logical entity name; also the table name except for `profiles`, which carry a bundle. */
  table: string;
  /** Primary key columns, in order. Composite keys are joined with U+0000. */
  pk: readonly string[];
  /**
   * Portable column names — the shape that is hashed and compared.
   *
   * Usually identical to the database column names. It differs exactly where a secret column is
   * stored under a name that says how it is protected (`password_enc`, `value_enc`) and travels
   * under one that says what it is (`password`, `value`).
   */
  columns: readonly string[];
  /**
   * Columns to SELECT and INSERT, in the database's own naming.
   *
   * Defaults to `columns`. It exists so `dumpTable` never has to guess: selecting `password` from
   * `account_credentials` fails outright, and selecting `password_enc` would carry machine-bound
   * ciphertext rather than the revealed secret.
   */
  dbColumns?: readonly string[];
  codec?: EntityCodec;
  /** Apply order. A profile must land after the group/proxy/fingerprint rows it points at. */
  order: number;
}

/**
 * Deterministic JSON: object keys sorted recursively.
 *
 * Two machines must hash identical content to the same value, and `JSON.stringify` preserves
 * insertion order — which differs between a row read from SQLite and a row decoded from a JSON
 * payload written by another machine. Without sorting, every row would look permanently changed to
 * the other side and the merge would never converge.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    });
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hashRow(row: Record<string, unknown>, columns: readonly string[]): string {
  const projected: Record<string, unknown> = {};
  for (const col of columns) {
    if (row[col] !== undefined) projected[col] = row[col];
  }
  return createHash('sha256').update(stableStringify(projected)).digest('hex');
}

export function rowKey(pk: readonly string[], row: Record<string, unknown>): string {
  return pk.map((c) => String(row[c] ?? '')).join(KEY_SEP);
}

// ---------------------------------------------------------------------------
// Secret codecs
// ---------------------------------------------------------------------------

/**
 * Reveal-on-push / re-protect-on-pull for rows whose secret columns are encrypted at rest.
 *
 * The column names differ between the stored and portable forms because `global_keys` keeps its
 * ciphertext in `value_enc` while the portable projection calls it `value` — the same secret under
 * a name that says what it is.
 *
 * A value that cannot be revealed (written by an older build under a key that no longer exists) is
 * NOT represented as an empty secret. `null` here would mean "this machine has no password", and
 * applying it would overwrite a credential the receiving machine can still open with nothing. It is
 * dropped from the portable row instead, and `applyRow` carries the local ciphertext forward — losing
 * a usable secret is strictly worse than skipping one update.
 *
 * The portable name is removed from the encoded row only when it DIFFERS from the stored name. For
 * `proxies` the two are the same string, and deleting unconditionally threw away the ciphertext the
 * line above had just written, so every pull silently blanked proxy passwords and SSH keys.
 */
function secretCodec(stored: readonly string[], portableName: readonly string[]): EntityCodec {
  return {
    decode(row) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = v;
      stored.forEach((col, i) => {
        if (!(col in out)) return;
        const revealed = revealSecret(out[col] as string | null);
        delete out[col];
        // Absent rather than null: "cannot be read here" and "there is no secret" are different
        // facts, and only the second one may overwrite a working credential.
        if (revealed !== undefined) out[portableName[i]] = revealed;
      });
      return out;
    },
    encode(portable) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(portable)) out[k] = v;
      stored.forEach((col, i) => {
        if (!(portableName[i] in out)) return;
        out[col] = protectSecret(portable[portableName[i]] as string | null) ?? null;
        if (portableName[i] !== col) delete out[portableName[i]];
      });
      return out;
    },
  };
}

const PROXY_CODEC = secretCodec(['password', 'private_key'], ['password', 'private_key']);
const VAULT_CODEC = secretCodec(['password_enc', 'totp_secret_enc'], ['password', 'totp_secret']);
const GLOBAL_KEY_CODEC = secretCodec(['value_enc'], ['value']);

// ---------------------------------------------------------------------------
// Table specs
// ---------------------------------------------------------------------------

/**
 * `order` values are chosen so a row's foreign keys always exist before the row referencing it:
 * groups/proxies/tags/extensions land first, then profiles, then the join tables and credentials
 * that point at a profile. Writing them out of order produces a profile bound to a group id this
 * machine has never heard of, which the UI renders as an orphaned "Unknown" entry.
 *
 * `fingerprints` is deliberately absent. A fingerprint is one-per-profile and its id is minted at
 * creation, so shipping the row would make every pull invent a new local id, orphan the previous one
 * and grow the payload by one row per profile on every cycle. The portable identity is the SEED plus
 * the config, and both already travel inside the profile bundle.
 */
export const SYNC_TABLES: readonly EntityTable[] = [
  { table: 'groups', pk: ['id'], columns: ['id', 'name', 'bookmarks', 'created_at'], order: 10 },
  {
    table: 'proxies',
    pk: ['id'],
    columns: [
      'id', 'type', 'host', 'port', 'username', 'password', 'private_key',
      'country', 'country_code', 'city', 'timezone', 'latitude', 'longitude', 'created_at',
    ],
    codec: PROXY_CODEC,
    order: 10,
  },
  // `path` is the unpacked folder on THIS machine and is deliberately not carried.
  { table: 'extensions', pk: ['id'], columns: ['id', 'name', 'version', 'enabled', 'created_at'], order: 10 },
  { table: 'tags', pk: ['id'], columns: ['id', 'name', 'color', 'created_at'], order: 10 },
  {
    table: 'scripts',
    pk: ['id'],
    columns: ['id', 'name', 'code', 'created_at', 'updated_at', 'last_run_at', 'last_status'],
    order: 20,
  },
  // A trashed profile carries `deleted_at` across machines so the deletion itself propagates.
  { table: 'profiles', pk: ['id'], columns: ['id', 'deleted_at', 'updated_at', 'bundle'], order: 30 },
  { table: 'profile_tags', pk: ['profile_id', 'tag_id'], columns: ['profile_id', 'tag_id'], order: 40 },
  {
    table: 'profile_extensions',
    pk: ['profile_id', 'extension_id'],
    columns: ['profile_id', 'extension_id', 'launch_args'],
    order: 40,
  },
  {
    table: 'triggers',
    pk: ['id'],
    columns: ['id', 'name', 'script_id', 'type', 'schedule', 'event', 'enabled', 'created_at'],
    order: 40,
  },
  {
    table: 'account_credentials',
    pk: ['id'],
    columns: [
      'id', 'profile_id', 'label', 'login', 'password', 'totp_secret',
      'notes', 'created_at', 'updated_at',
    ],
    dbColumns: [
      'id', 'profile_id', 'label', 'login', 'password_enc', 'totp_secret_enc',
      'notes', 'created_at', 'updated_at',
    ],
    codec: VAULT_CODEC,
    order: 50,
  },
  {
    table: 'global_keys',
    pk: ['key'],
    columns: ['key', 'value', 'updated_at'],
    dbColumns: ['key', 'value_enc', 'updated_at'],
    codec: GLOBAL_KEY_CODEC,
    order: 50,
  },
];

/** Static lookup, not a `Map`: the keys are the literal table names above. */
export const SYNC_TABLES_BY_NAME: Record<string, EntityTable> = Object.fromEntries(
  SYNC_TABLES.map((t) => [t.table, t])
);

/** Specs in apply order. A merge writes in this sequence, never in declaration order. */
export const SYNC_TABLES_SORTED: readonly EntityTable[] = [...SYNC_TABLES].sort(
  (a, b) => a.order - b.order
);

// ---------------------------------------------------------------------------
// Identifier safety
// ---------------------------------------------------------------------------

/**
 * Table and column names cannot be bound as SQL parameters, so they have to be interpolated.
 *
 * They are interpolated ONLY from `SYNC_TABLES`, a module-level literal — never from a payload, a
 * manifest, or anything a remote machine controls. This guard makes that structural rather than a
 * convention: a spec that is not in the table above is refused before it can reach a query.
 */
function assertKnownTable(name: string): EntityTable {
  const spec = Object.prototype.hasOwnProperty.call(SYNC_TABLES_BY_NAME, name)
    ? SYNC_TABLES_BY_NAME[name]
    : undefined;
  if (!spec) {
    throw new Error(`refusing to build SQL for unknown sync table '${name}'`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Profiles: the one entity that is not a plain row copy
// ---------------------------------------------------------------------------

/**
 * Read every profile as a portable row.
 *
 * `exportProfileBundle` already assembles fingerprint, cookies, tags, group, proxy and device into
 * one envelope, and `importProfileBundle` already re-links the referenced records by id-or-name, so
 * both are reused rather than reimplemented here.
 *
 * Trashed rows are read too: their `deleted_at` is the tombstone that makes a deletion on one
 * machine delete on the other. Filtering them out is what caused deletions to resurrect.
 */
function dumpProfiles(): Record<string, unknown>[] {
  const rows = getDb()
    .prepare('SELECT id, deleted_at, updated_at FROM profiles')
    .all() as Array<{ id: string; deleted_at: number | null; updated_at: number }>;

  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    // A trashed profile is no longer "live", so `exportProfileBundle` returns null for it. The
    // tombstone still has to travel, hence the row is emitted without a bundle.
    const bundle = r.deleted_at === null ? exportProfileBundle(r.id) : null;
    if (bundle) {
      /*
       * `exported_at` is `Date.now()` at the moment of export, so keeping it would give the profile
       * a new hash on every single dump — the row would look permanently changed to the other
       * machine, the merge would never settle, and every sync would re-push every profile forever.
       * It records when an export happened, which is not part of the profile's identity.
       */
      bundle.exported_at = 0;
    }
    out.push({
      id: r.id,
      deleted_at: r.deleted_at ?? null,
      updated_at: r.updated_at,
      bundle: bundle ?? null,
    });
  }
  return out;
}

/**
 * Point every child row at a profile's real id.
 *
 * `importProfileBundle` mints a fresh id because it does not know the remote one. A profile that
 * came back under a different id would never converge — and its credentials and tag bindings would
 * point at an id that no profile owns.
 */
function reassignProfileId(from: string, to: string): void {
  if (from === to) return;
  const db = getDb();
  try {
    db.prepare('UPDATE profiles SET id = ? WHERE id = ?').run(to, from);
  } catch {
    return;
  }
  for (const child of ['account_credentials', 'profile_tags', 'profile_extensions']) {
    try {
      // Literal child-table names from the array above, not payload input; SQLite cannot bind an
      // identifier, and every value in a prepared statement below is still a bound parameter.
      db.prepare(`UPDATE ${child} SET profile_id = ? WHERE profile_id = ?`).run(to, from); // pi-lens-ignore: sql-injection
    } catch {
      /* child table absent in this build — nothing to repoint */
    }
  }
}

/**
 * Write a remote profile onto this machine.
 *
 * The middle case is the bug this replaces. The old pull updated an existing profile with five
 * fields — name, UA, timezone, start URLs, notes — and dropped the fingerprint, proxy, launch args,
 * WebRTC policy, blocked ports, headless flag, device preset and android config. A profile synced
 * onto a machine that already had it came back stripped. Every bundle field is applied here.
 */
/**
 * Narrow a bundle's browser type to what `updateProfile` accepts.
 *
 * A bundle is a file that outlives the build that wrote it, so an unknown or missing value has to
 * degrade to the default rather than reach the database layer as-is.
 */
function normalizeBrowserType(value: string | null | undefined): 'chromium' | 'firefox' | 'android' {
  if (value === 'firefox' || value === 'android') return value;
  return 'chromium';
}


function applyProfile(portable: Record<string, unknown>): void {
  const id = String(portable.id);
  const deletedAt = (portable.deleted_at as number | null) ?? null;
  const updatedAt = (portable.updated_at as number) ?? Date.now();
  const bundle = portable.bundle as ProfileBundle | null | undefined;
  const db = getDb();

  const row = db.prepare('SELECT deleted_at FROM profiles WHERE id = ?').get(id) as
    | { deleted_at: number | null }
    | undefined;

  if (deletedAt !== null) {
    // Trashed remotely. Restore the row only when it is missing or currently live, so a profile
    // already trashed here keeps its own (later) delete stamp.
    if (!row) {
      if (bundle) {
        reassignProfileId(importProfileBundle(bundle, { exactName: true }), id);
      }
      db.prepare('UPDATE profiles SET deleted_at = ? WHERE id = ?').run(deletedAt, id);
    } else if (row.deleted_at === null) {
      deleteProfile(id);
    }
    return;
  }

  // Not deleted remotely, but trashed here: a local delete is a local decision until the operator
  // restores it. Overwriting it would silently undo their own trash action from another machine.
  if (row?.deleted_at !== null && row?.deleted_at !== undefined) {
    return;
  }

  if (!row) {
    if (bundle) {
      reassignProfileId(importProfileBundle(bundle, { exactName: true }), id);
      // `importProfileBundle` stamps `updated_at` with the local clock. Leaving that in place makes
      // the row's hash differ from the remote on every single cycle, so the merge would report a
      // change forever and re-push the same profile on every sync. The remote stamp is the truth.
      db.prepare('UPDATE profiles SET updated_at = ? WHERE id = ?').run(updatedAt, id);
    }
    return;
  }

  if (!bundle) {
    // A row that exists remotely with no bundle is a profile created before bundles were carried,
    // or one whose bundle failed to export. There is nothing to restore beyond its own columns.
    db.prepare('UPDATE profiles SET updated_at = ? WHERE id = ?').run(updatedAt, id);
    return;
  }

  const src = bundle.profile;
  const fingerprintId = resolveFingerprintId(src);

  /*
   * `updateProfile` treats `undefined` as "leave alone" and `null` as "clear". Every reference below
   * is therefore passed ONLY when the bundle actually carries it: a device preset or proxy this
   * machine does not have resolves to nothing, and clearing the binding would write a bundle with the
   * reference stripped — which the next machine then applies, erasing the binding on the machine that
   * still had it. Group and tag create the missing row instead; device and proxy cannot be invented.
   */
  updateProfile(id, {
    name: src.name ?? undefined,
    browser_type: normalizeBrowserType(src.browser_type),
    group_id: bundle.profile?.group || bundle.group ? resolveGroupId(bundle) : undefined,
    proxy_id: src.proxy
      ? findProxyByEndpoint(src.proxy.host, src.proxy.port, src.proxy.type, src.proxy.username ?? null)
      : undefined,
    device_id: src.device ? (resolveDeviceId(src) ?? undefined) : undefined,
    user_agent: src.user_agent,
    timezone: src.timezone,
    start_urls: src.start_urls ?? null,
    mobile_model_id: src.mobile_model_id,
    launch_args: src.launch_args ?? null,
    color: src.color,
    notes: src.notes ?? bundle.notes ?? undefined,
    do_not_track: (src.do_not_track as 'off' | 'on' | 'auto' | null | undefined) ?? null,
    blocked_ports: src.blocked_ports ?? null,
    webrtc_policy:
      (src.webrtc_policy as 'default' | 'disable_non_proxied_udp' | 'proxy' | null | undefined) ??
      null,
    headless: src.headless === true,
  });

  // Columns `updateProfile` does not own.
  if (src.geolocation !== undefined) {
    db.prepare('UPDATE profiles SET geolocation = ? WHERE id = ?').run(src.geolocation, id);
  }
  if (src.fingerprint?.config && fingerprintId) {
    db.prepare('UPDATE fingerprints SET config_json = ? WHERE id = ?').run(
      JSON.stringify(src.fingerprint.config),
      fingerprintId
    );
  }
  if (Array.isArray(src.cookies) && src.cookies.length > 0) {
    db.prepare('UPDATE profiles SET cookies_json = ? WHERE id = ?').run(
      JSON.stringify(src.cookies),
      id
    );
  }
  // Tags are a join table synced in their own right, but the bundle carries them too: applying them
  // here means a profile restored before its tags merge still shows its tags.
  applyBundleTags(id, src.tags ?? bundle.tags);

  db.prepare('UPDATE profiles SET updated_at = ? WHERE id = ?').run(updatedAt, id);
}

function applyBundleTags(profileId: string, tags: unknown): void {
  if (!Array.isArray(tags)) return;
  const db = getDb();
  for (const raw of tags) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const name = raw.trim();
    let tagId = (db.prepare('SELECT id FROM tags WHERE lower(name) = lower(?)').get(name) as
      | { id: string }
      | undefined)?.id;
    if (!tagId) {
      // Derived from the name so two machines that create the same tag independently converge on
      // one row instead of racing two tags with the same text.
      tagId = `t_${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 16)}`;
      try {
        db.prepare('INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(
          tagId, name, null, Date.now()
        );
      } catch {
        continue;
      }
    }
    try {
      db.prepare('INSERT OR IGNORE INTO profile_tags (profile_id, tag_id) VALUES (?, ?)').run(
        profileId, tagId
      );
    } catch {
      /* binding already present */
    }
  }
}

/**
 * Devices are seeded per machine, so the id rarely matches; fall back to name.
 *
 * `null` means "leave the current binding": a preset this machine does not have is better than
 * binding the profile to nothing.
 */
function resolveDeviceId(src: ProfileBundle['profile']): string | null {
  if (!src.device?.device_id) return null;
  const db = getDb();
  const byId = db.prepare('SELECT id FROM devices WHERE id = ?').get(src.device.device_id) as
    | { id: string }
    | undefined;
  if (byId) return byId.id;
  if (!src.device.name) return null;
  return (
    db.prepare('SELECT id FROM devices WHERE lower(name) = lower(?)').get(src.device.name) as
      | { id: string }
      | undefined
  )?.id ?? null;
}

/** Groups travel in their own table, so the id normally resolves; name is the fallback. */
function resolveGroupId(bundle: ProfileBundle): string | null {
  const ref = bundle.profile?.group ?? bundle.group;
  if (!ref) return null;
  const db = getDb();
  if (ref.id) {
    const byId = db.prepare('SELECT id FROM groups WHERE id = ?').get(ref.id) as
      | { id: string }
      | undefined;
    if (byId) return byId.id;
  }
  if (!ref.name) return null;
  const byName = db.prepare('SELECT id FROM groups WHERE lower(name) = lower(?)').get(ref.name) as
    | { id: string }
    | undefined;
  if (byName) return byName.id;
  // Derived from the name so the same group created on two machines collapses to one row.
  const newId = `g_${createHash('sha1').update(ref.name.toLowerCase()).digest('hex').slice(0, 16)}`;
  try {
    db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
      newId,
      ref.name,
      Date.now()
    );
    return newId;
  } catch {
    return null;
  }
}

/**
 * A fingerprint is per-profile and its id is minted locally at creation, so the remote id will not
 * match. The seed is the identity that travels: two rows with the same seed describe the same
 * device, so the remote config is written into the local row bound to this profile.
 */
function resolveFingerprintId(src: ProfileBundle['profile']): string | null {
  if (!src.fingerprint?.seed) return null;
  const bySeed = getDb().prepare('SELECT id FROM fingerprints WHERE seed = ?').get(src.fingerprint.seed) as
    | { id: string }
    | undefined;
  return bySeed?.id ?? null;
}

// ---------------------------------------------------------------------------
// Generic dump / apply
// ---------------------------------------------------------------------------

/**
 * Read one table's portable rows.
 *
 * `profiles` is special-cased because it needs the bundle assembly described above; everything else
 * is a straight column projection, which is why the rest of the specs can stay declarative.
 */
export function dumpTable(spec: EntityTable): Array<Record<string, unknown>> {
  assertKnownTable(spec.table);
  if (spec.table === 'profiles') return dumpProfiles();

  const selectCols = spec.dbColumns ?? spec.columns;
  const cols = [...spec.pk, ...selectCols.filter((c) => !spec.pk.includes(c))];
  const rows = getDb().prepare(`SELECT ${cols.join(', ')} FROM ${spec.table}`).all() as Array<Record<string, unknown>>; // pi-lens-ignore: sql-injection
  // `decode` renames the protected columns to their portable names and reveals the secrets, so the
  // row leaving this function is already in the portable shape the merge hashes.
  return rows.map((r) => (spec.codec ? spec.codec.decode(r) : r));
}

/** Write one portable row. `INSERT OR REPLACE` is the whole upsert; there is no third state. */
export function applyRow(spec: EntityTable, portable: Record<string, unknown>): void {
  const known = assertKnownTable(spec.table);
  if (spec.table === 'profiles') {
    applyProfile(portable);
    return;
  }
  const values = spec.codec ? spec.codec.encode(portable) : portable;
  // `encode` puts the secrets back under their protected names, so the insert must be projected
  // onto the database's column list, not the portable one.
  const insertCols = known.dbColumns ?? known.columns;

  if (spec.codec) {
    /*
     * `INSERT OR REPLACE` rewrites the whole row, so any column left out of the insert becomes NULL.
     * A secret that the sending machine could not reveal arrives ABSENT from the portable row, and
     * omitting the column here would therefore blank a credential this machine can still open. The
     * local ciphertext is carried forward instead: the update is skipped, not destroyed.
     */
    const local = getDb().prepare(`SELECT * FROM ${known.table} WHERE ${known.pk.map((c) => `${c} = ?`).join(' AND ')}`).get(...known.pk.map((c) => (portable[c] ?? null) as never)) as Record<string, unknown> | undefined; // pi-lens-ignore: sql-injection
    if (local) {
      for (const col of insertCols) {
        if (values[col] === undefined && local[col] !== undefined) values[col] = local[col];
      }
    }
  }

  const cols = insertCols.filter((c) => c in values);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})` // pi-lens-ignore: sql-injection
    )
    .run(...cols.map((c) => (values[c] ?? null) as never));
}

/**
 * Remove a row that the remote no longer has.
 *
 * Only tables whose rows are owned solely by sync are hard-deleted. A profile goes to the operator's
 * trash instead of vanishing, because a hard delete here would destroy the Chromium directory and
 * every credential bound to it on a machine that simply had not synced in a while.
 */
export function deleteRow(spec: EntityTable, key: string): void {
  assertKnownTable(spec.table);
  const db = getDb();

  if (spec.table === 'profiles') {
    if (getLiveProfile(key)) deleteProfile(key);
    return;
  }
  // `profile_tags` / `profile_extensions` have a composite key and no `id` column.
  const where = spec.pk.map((c) => `${c} = ?`).join(' AND ');
  const values = key.split(KEY_SEP);
  try {
    db.prepare(`DELETE FROM ${spec.table} WHERE ${where}`).run(...values); // pi-lens-ignore: sql-injection
  } catch {
    /* row already gone, or the table is absent in this build */
  }
}

/** Base snapshot location. Machine state, never user data, so it lives outside settings.json. */
export const BASE_SNAPSHOT_PATH = `${DATA_DIR}/gdrive-sync-base.json`;