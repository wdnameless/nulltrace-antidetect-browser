// Every column the code selects must exist in the schema.
//
// This is the class of defect that made groups appear impossible to create. `listGroups` selects
// `g.bookmarks` and `updateGroup` writes it, but the migration that added the column was
// overwritten thirteen minutes after it landed by an unrelated `ensureColumn` line — the new
// line replaced it instead of following it. `CREATE TABLE IF NOT EXISTS` does not migrate an
// existing table, so every database already in use kept a `groups` table without `bookmarks`.
//
// The failure was invisible in the worst way: the group row WAS written, and then the refresh
// that would have displayed it threw `no such column: g.bookmarks`. The operator pressed
// "+ Add Group", saw "No custom groups created yet", and concluded groups do not work.
//
// A test for `bookmarks` alone would have the same blind spot as the original code. So this
// checks the general rule instead: read the columns each core query names, and require the
// migrated schema to carry every one of them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb, closeDb } from '../../src/main/db';
import { migrate } from '../../src/main/db/schema';

/** Columns referenced as `alias.column` in a SQL string. */
function referencedColumns(sql: string): Set<string> {
  const found = new Set<string>();
  // Match `x.column` where x is a single-letter table alias, which is how this codebase writes
  // its joins. Deliberately not a SQL parser: it only needs to be right about the queries below.
  for (const m of sql.matchAll(/\b[a-z]\.([a-z_][a-z0-9_]*)\b/gi)) {
    found.add(m[1]);
  }
  return found;
}

describe('schema completeness: every referenced column exists', () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(() => {
    closeDb();
  });

  const tableColumns = (table: string): Set<string> =>
    new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

  it('groups carries every column the group queries name', () => {
    // The two queries that broke. Kept as literal SQL here so the test states the contract
    // rather than importing the implementation it is meant to police.
    const listQuery = `SELECT g.id, g.name, g.created_at, g.bookmarks, COUNT(p.id) AS profile_count
       FROM groups g
       LEFT JOIN profiles p ON p.group_id = g.id AND p.deleted_at IS NULL
       GROUP BY g.id
       ORDER BY g.created_at DESC`;
    const updateQuery = `UPDATE groups SET name = ?, bookmarks = ? WHERE id = ?`;

    const groups = tableColumns('groups');
    const profiles = tableColumns('profiles');
    const named = referencedColumns(listQuery + ' ' + updateQuery);

    // `p.deleted_at` belongs to profiles; everything else qualified with `g.` belongs to groups.
    const missing: string[] = [];
    for (const col of named) {
      if (col === 'deleted_at') {
        if (!profiles.has(col)) missing.push(`profiles.${col}`);
        continue;
      }
      if (!groups.has(col) && !profiles.has(col)) missing.push(`groups.${col}`);
    }

    expect(
      missing,
      `the migrated schema is missing columns these queries name: ${missing.join(', ')}. ` +
        'A SELECT over a missing column fails the whole query, so the UI shows an empty list ' +
        'even though the write succeeded.',
    ).toEqual([]);
  });

  it('the group list query actually runs against the migrated schema', () => {
    // The behavioural half: not just "the column is present", but "the query works". This is
    // what the operator needed and did not get.
    const db = getDb();
    const id = `g_test_${Date.now()}`;
    db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, 'Migration Check', Date.now());

    expect(() =>
      db
        .prepare(
          `SELECT g.id, g.name, g.created_at, g.bookmarks, COUNT(p.id) AS profile_count
           FROM groups g
           LEFT JOIN profiles p ON p.group_id = g.id AND p.deleted_at IS NULL
           GROUP BY g.id
           ORDER BY g.created_at DESC`,
        )
        .all(),
    ).not.toThrow();

    // And the row comes back, which is what makes it visible in the modal.
    const rows = db
      .prepare('SELECT id, name FROM groups WHERE id = ?')
      .all(id) as Array<{ id: string; name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Migration Check');

    // Updating bookmarks must also work: that is the write half of the same feature.
    expect(() =>
      db.prepare('UPDATE groups SET bookmarks = ? WHERE id = ?').run(JSON.stringify([]), id),
    ).not.toThrow();

    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  });

  it('a database created before the column existed gains it on migrate', async () => {
    // Reproduce the operator's database: a `groups` table WITHOUT `bookmarks`, exactly as
    // `CREATE TABLE IF NOT EXISTS` left it in every database created before the feature shipped.
    // Then run the real migrate() over it and require the column to appear — this is the step
    // that was silently deleted, and the reason groups could be written but never listed.
    const db = getDb();
    db.exec('DROP TABLE IF EXISTS groups');
    db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)');

    const before = (db.prepare('PRAGMA table_info(groups)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(before, 'the fixture must start without the column, or it proves nothing').not.toContain('bookmarks');

    // Re-run the production migration path against this legacy table.
    closeDb();
    await initDb();

    const after = (getDb().prepare('PRAGMA table_info(groups)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(after).toContain('bookmarks');

    // And the query the modal depends on now works on that migrated table.
    expect(() =>
      getDb()
        .prepare(
          `SELECT g.id, g.name, g.created_at, g.bookmarks, COUNT(p.id) AS profile_count
           FROM groups g LEFT JOIN profiles p ON p.group_id = g.id AND p.deleted_at IS NULL
           GROUP BY g.id`,
        )
        .all(),
    ).not.toThrow();
  });

  it('a database whose profile_extensions lacks launch_args gains it on migrate and sync read succeeds', () => {
    // Reproduce an old-schema DB created before profile_extensions gained launch_args.
    const db = getDb();
    db.exec('DROP TABLE IF EXISTS profile_extensions');
    db.exec(
      'CREATE TABLE profile_extensions (profile_id TEXT NOT NULL, extension_id TEXT NOT NULL, PRIMARY KEY (profile_id, extension_id))',
    );

    const before = (db.prepare('PRAGMA table_info(profile_extensions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(before, 'the fixture must start without launch_args').not.toContain('launch_args');

    migrate(db);

    const after = (db.prepare('PRAGMA table_info(profile_extensions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(after).toContain('launch_args');

    // Sync read succeeds without throwing "no such column: launch_args" (R01).
    expect(() =>
      db
        .prepare('SELECT profile_id, extension_id, launch_args FROM profile_extensions')
        .all(),
    ).not.toThrow();
  });
});
