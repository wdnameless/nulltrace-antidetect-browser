import type { Database } from './index';
import { migrateProxyHealth } from './migrations/proxyHealth';
import { migratePreservedBrowserData } from './migrations/preserved-browser-data';
import { migrateTaskGroups } from './migrations/taskGroups';

/**
 * Column/table names and DDL fragments that this module is allowed to migrate.
 *
 * SQLite cannot bind an identifier as a parameter, so `ALTER TABLE … ADD COLUMN` necessarily
 * interpolates. Rather than trust every call site to keep passing literals, the values are
 * checked against these tables at run time: a name that is not here never reaches the SQL
 * string, whatever a future caller passes.
 */
const MIGRATABLE_COLUMNS: Readonly<Record<string, true>> = {
  private_key: true, timezone: true, latitude: true, longitude: true, city: true, browser_type: true,
  country_code: true,
  mobile_model_id: true, deleted_at: true, path: true, bookmarks: true, launch_args: true,
  color: true, do_not_track: true, blocked_ports: true, webrtc_policy: true, notes: true,
  headless: true, android_config: true,
};
const MIGRATABLE_TABLES: Readonly<Record<string, true>> = { proxies: true, profiles: true, groups: true };
const MIGRATABLE_DDL = /^[A-Z][A-Z0-9]*(?:\([0-9]+\))?(?: (?:NOT NULL|DEFAULT [A-Za-z0-9_.'() -]+))*$/;

/** Add a column to an existing table if it is missing (CREATE TABLE IF NOT EXISTS does not migrate). */
function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const safeTable = MIGRATABLE_TABLES[table] ? table : null;
  const safeColumn = MIGRATABLE_COLUMNS[column] ? column : null;
  if (!safeTable) {
    throw new Error(`ensureColumn: refusing unknown table '${table}'`);
  }
  if (!safeColumn) {
    throw new Error(`ensureColumn: refusing unknown column '${column}' (add it to MIGRATABLE_COLUMNS)`);
  }
  if (!MIGRATABLE_DDL.test(ddl)) {
    throw new Error(`ensureColumn: refusing unsupported column definition '${ddl}'`);
  }
  const cols = db.prepare(`PRAGMA table_info(${safeTable})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === safeColumn)) {
    // Both identifiers above are allowlisted by MIGRATABLE_TABLES / MIGRATABLE_COLUMNS and the
    // DDL is shape-checked, so nothing caller-supplied reaches this string. SQLite cannot bind
    // an identifier as a parameter, which is why interpolation is the only option here.
    db.exec(`ALTER TABLE ${safeTable} ADD COLUMN ${safeColumn} ${ddl}`); // pi-lens-ignore: sql-injection
  }
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      bookmarks   TEXT
    );

    CREATE TABLE IF NOT EXISTS proxies (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL CHECK (type IN ('http','https','socks5','ssh')),
      host        TEXT NOT NULL,
      port        INTEGER NOT NULL,
      username    TEXT,
      password    TEXT,
      private_key TEXT,
      country     TEXT,
      country_code TEXT,
      city        TEXT,
      timezone    TEXT,
      status      TEXT DEFAULT 'unknown',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fingerprints (
      id          TEXT PRIMARY KEY,
      label       TEXT,
      seed        INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      platform    TEXT NOT NULL,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id             TEXT PRIMARY KEY,
      name           TEXT,
      group_id       TEXT REFERENCES groups(id),
      proxy_id       TEXT REFERENCES proxies(id),
      fingerprint_id TEXT REFERENCES fingerprints(id),
      device_id      TEXT REFERENCES devices(id),
      browser_type   TEXT DEFAULT 'chromium',
      user_agent     TEXT,
      timezone       TEXT,
      geolocation    TEXT,
      cookies_json   TEXT,
      start_urls     TEXT,
      status         TEXT DEFAULT 'closed',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(group_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);

    CREATE TABLE IF NOT EXISTS extensions (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      version     TEXT,
      enabled     INTEGER DEFAULT 1,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_extensions (
      profile_id   TEXT NOT NULL,
      extension_id TEXT NOT NULL,
      launch_args    TEXT,
      PRIMARY KEY (profile_id, extension_id)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      owner_device_id TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id     TEXT NOT NULL,
      member_id   TEXT NOT NULL,
      email       TEXT,
      role        TEXT NOT NULL CHECK (role IN ('owner','member')),
      permissions TEXT, -- JSON: {can_run_profiles,can_add_profiles,can_remove_profiles,can_invite}
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active')),
      invite_code_hash TEXT,
      key_blob    TEXT,
      joined_at   INTEGER,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (team_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS team_bundles_meta (
      team_id    TEXT NOT NULL,
      bundle_id  TEXT NOT NULL,
      device_id  TEXT,
      version    INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, bundle_id)
    );

    CREATE TABLE IF NOT EXISTS team_profiles (
      team_id   TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      added_by  TEXT,
      added_at  INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS account_credentials (
      id              TEXT PRIMARY KEY,
      profile_id      TEXT NOT NULL REFERENCES profiles(id),
      label           TEXT,
      login           TEXT,
      password_enc    TEXT,
      totp_secret_enc TEXT,
      notes           TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_account_credentials_profile ON account_credentials(profile_id);

    CREATE TABLE IF NOT EXISTS tags (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_tags (
      profile_id TEXT NOT NULL,
      tag_id     TEXT NOT NULL,
      PRIMARY KEY (profile_id, tag_id)
    );

    CREATE INDEX IF NOT EXISTS idx_profile_tags_tag ON profile_tags(tag_id);

    CREATE TABLE IF NOT EXISTS sync_sessions (
      id                TEXT PRIMARY KEY,
      master_profile_id TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'active',
      members           TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS scripts (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      code        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      last_run_at INTEGER,
      last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS script_runs (
      id          TEXT PRIMARY KEY,
      script_id   TEXT NOT NULL,
      profile_ids TEXT NOT NULL DEFAULT '[]',
      status      TEXT NOT NULL DEFAULT 'running',
      log         TEXT NOT NULL DEFAULT '',
      started_at  INTEGER NOT NULL,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_script_runs_script ON script_runs(script_id);

    CREATE TABLE IF NOT EXISTS global_keys (
      key       TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      script_id TEXT NOT NULL,
      type      TEXT NOT NULL,
      schedule  TEXT,
      event     TEXT,
      enabled   INTEGER NOT NULL DEFAULT 1,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      direction    TEXT    NOT NULL,
      outcome      TEXT    NOT NULL,
      rows_pushed  INTEGER NOT NULL DEFAULT 0,
      rows_pulled  INTEGER NOT NULL DEFAULT 0,
      conflicts    INTEGER NOT NULL DEFAULT 0,
      error        TEXT
    );
  `);

  // Migrations for databases created before these columns existed.
  ensureColumn(db, 'proxies', 'private_key', 'TEXT');
  ensureColumn(db, 'proxies', 'timezone', 'TEXT');
  ensureColumn(db, 'proxies', 'latitude', 'REAL');
  ensureColumn(db, 'proxies', 'longitude', 'REAL');
  ensureColumn(db, 'proxies', 'city', 'TEXT');
  // ISO 3166-1 alpha-2 as returned by the same geo lookup ("DE"). The flag and the two-letter
  // label derive from a CODE, and `country` holds the provider's display NAME ("Germany") — a
  // name cannot be turned into a flag without a lookup table we already receive the answer to.
  // A row written before this column keeps its name and gains the code on its next check, because
  // `startGeoFill` treats "name but no code" as still unresolved.
  ensureColumn(db, 'proxies', 'country_code', 'TEXT');
  ensureColumn(db, 'profiles', 'browser_type', 'TEXT DEFAULT \'chromium\'');
  ensureColumn(db, 'profiles', 'mobile_model_id', 'TEXT');
  // Trash (soft delete): NULL = live profile, timestamp = moved to trash.
  ensureColumn(db, 'profiles', 'deleted_at', 'INTEGER');
  // Movable data root: absolute workspace path rewritten on relocation.
  ensureColumn(db, 'profiles', 'path', 'TEXT');
  // Per-group managed bookmarks, stored as a JSON array.
  //
  // This migration was added with the bookmarks feature and then silently REPLACED thirteen
  // minutes later by the `launch_args` line below, which overwrote it instead of following it.
  // `groups` had no entry for the column afterwards, and `CREATE TABLE IF NOT EXISTS` does not
  // touch a table that already exists, so every database in use kept a `groups` table without
  // `bookmarks` — while `listGroups` selects it and `updateGroup` writes it. The read failed
  // with `no such column: g.bookmarks`, and because the group list is what the Profile Groups
  // modal renders, creating a group appeared to do nothing: the row was written, then the
  // refresh that would have shown it failed.
  ensureColumn(db, 'groups', 'bookmarks', 'TEXT');
  // Extra per-profile Chromium launch args (parity program: extra-launch-args).
  ensureColumn(db, 'profiles', 'launch_args', 'TEXT');
  // Profile window badge color (parity program: profile-window-badge).
  ensureColumn(db, 'profiles', 'color', 'TEXT');
  // Per-profile privacy/fingerprint knobs exposed by the create form.
  // `off`/`on` for doNotTrack (canonical strings, not booleans: the UI shows a third
  // "Auto" state, which a boolean cannot represent).
  ensureColumn(db, 'profiles', 'do_not_track', 'TEXT');
  // JSON array of port numbers to block (e.g. [3389,5900]). Stored as TEXT because
  // SQLite has no array type and the set is small and read whole.
  ensureColumn(db, 'profiles', 'blocked_ports', 'TEXT');
  // WebRTC IP handling policy: 'default' | 'disable_non_proxied_udp' | 'proxy'.
  ensureColumn(db, 'profiles', 'webrtc_policy', 'TEXT');
  // Free-form per-profile operator note. The Edit modal historically exposed a NOTES
  // textarea that was never persisted; this column backs the per-profile Note surface.
  ensureColumn(db, 'profiles', 'notes', 'TEXT');
  migrateProxyHealth(db);
  migratePreservedBrowserData(db);
  migrateTaskGroups(db);
  // Android profile settings JSON (e.g. {"apiLevel":34,"screen":"phone","coldBoot":false}).
  // browser_type is the runtime selector ('android'); desktop launch paths remain untouched.
  ensureColumn(db, 'profiles', 'android_config', 'TEXT');
  // Headless launch (`--headless=new`) for agent/automation profiles. Stored as '1'/'0'
  // so an existing database migrates without a tri-state; NULL and '0' both mean headed,
  // which is what every profile created before this column was.
  ensureColumn(db, 'profiles', 'headless', 'INTEGER');
}
