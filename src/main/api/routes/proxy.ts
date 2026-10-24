import { Router } from 'express';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as xm from '../../proxy/proxyManager';
import * as pm from '../../profiles/profileManager';
import { listBackups, restoreBackup } from '../../util/backupManager';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { DATA_DIR, getDataDir } from '../../config';
import { getDb, flushDb } from '../../db';

const router = Router();

const proxySchema = z.object({
  type: z.enum(['http', 'https', 'socks5', 'ssh']),
  host: z.string(),
  port: z.union([z.number(), z.string()]),
  username: z.string().optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  /** Geo is normally written by the checker; the operator may override it (and tests need it). */
  country: z.string().nullable().optional(),
  country_code: z.string().length(2).nullable().optional(),
  timezone: z.string().nullable().optional(),
});

function toInput(data: z.infer<typeof proxySchema>): xm.ProxyInput {
  return {
    type: data.type,
    host: data.host,
    port: Number(data.port),
    username: data.username,
    password: data.password,
    privateKey: data.privateKey,
    country: data.country ?? null,
    countryCode: data.country_code ?? null,
    timezone: data.timezone ?? null,
  };
}

router.post('/api/v1/proxy/create', (req, res) => {
  const parsed = proxySchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const id = xm.createProxy(toInput(parsed.data));
    res.json({ code: 0, msg: 'success', data: { proxy_id: id } });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.get('/api/v1/proxy/list', (_req, res) => {
  const list = xm.listProxies().map((p) => ({
    proxy_id: p.id,
    type: p.type,
    host: p.host,
    port: p.port,
    username: p.username,
    country: p.country,
    country_code: p.country_code,
    city: p.city,
    timezone: p.timezone,
    latitude: p.latitude,
    longitude: p.longitude,
    status: p.status,
  }));
  res.json({ code: 0, msg: 'success', data: { list, total: list.length } });
});

const updateSchema = proxySchema.partial().extend({ proxy_id: z.string() });
router.post('/api/v1/proxy/update', (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const { proxy_id, ...rest } = parsed.data;
  const ok = xm.updateProxy(proxy_id, toInput(rest as z.infer<typeof proxySchema>));
  res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'proxy not found', data: {} });
});

const deleteSchema = z.object({ proxy_id: z.string() });
router.post('/api/v1/proxy/delete', (req, res) => {
  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  try {
    const ok = xm.deleteProxy(parsed.data.proxy_id);
    res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'proxy not found', data: {} });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

const checkSchema = z.object({ proxy_id: z.string() });
router.post('/api/v1/proxy/check', async (req, res) => {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  const proxy = xm.getProxy(parsed.data.proxy_id);
  if (!proxy) {
    res.json({ code: -1, msg: 'proxy not found', data: {} });
    return;
  }
  try {
    const result = await xm.checkProxy(proxy);
    // Through `recordCheckResult`, not `setProxyResult` directly: the manual Test writes the same
    // columns, and it is the one place an operator stares at the row while it happens, so it must
    // also push the `proxy-geo` event that refreshes the table. Writing the columns without the
    // notification left the row showing its old state until the next slow poll.
    xm.recordCheckResult(proxy.id, result);
    res.json({ code: 0, msg: 'success', data: result });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.post('/api/v1/proxy/geo-fill/start', (req, res) => {
  const force = Boolean(req.body?.force);
  const status = xm.startGeoFill({ force });
  res.json({ code: 0, msg: 'success', data: status });
});

router.get('/api/v1/proxy/geo-fill/status', (_req, res) => {
  const status = xm.getGeoFillStatus();
  res.json({ code: 0, msg: 'success', data: status });
});

router.post('/api/v1/proxy/geo-fill/stop', (_req, res) => {
  const status = xm.stopGeoFill();
  res.json({ code: 0, msg: 'success', data: status });
});

// NOTE: profile binding (proxy/device/geolocation) is handled by the single
// /api/v1/browser-profile/update route in routes/browser.ts.

const fingerprintSchema = z.object({
  user_id: z.string(),
  config: z.record(z.unknown()),
});
router.post('/api/v1/browser-profile/fingerprint', (req, res) => {
  const parsed = fingerprintSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  const ok = pm.updateProfileFingerprint(parsed.data.user_id, parsed.data.config);
  res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'profile not found', data: {} });
});

// ---------------------------------------------------------------------------
// Bulk import from a text list (v0.2.26): Webshare-style lines and friends.
// Supported per line:
//   protocol://user:pass@host:port     protocol from prefix
//   protocol://host:port
//   user:pass@host:port                default protocol
//   host:port:user:pass                default protocol (Webshare format)
//   host:port                          default protocol
// ---------------------------------------------------------------------------

interface ParsedProxyLine {
  type: xm.ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyLine(
  raw: string,
  defaultProtocol: 'http' | 'https' | 'socks5'
): ParsedProxyLine | null {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;

  let rest = line;
  let protocol: xm.ProxyType = defaultProtocol;
  const protoMatch = rest.match(/^(https?|socks5|ssh):\/\//i);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase() as xm.ProxyType;
    rest = rest.slice(protoMatch[0].length);
  }

  let username: string | undefined;
  let password: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    const creds = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const sep = creds.indexOf(':');
    if (sep > 0) {
      username = creds.slice(0, sep);
      password = creds.slice(sep + 1);
    } else {
      username = creds;
    }
  }

  // host:port[:user:pass]
  const parts = rest.split(':').map((p) => p.trim());
  if (parts.length < 2) return null;
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  if (parts.length >= 4 && !username) {
    username = parts[2];
    password = parts[3];
  } else if (parts.length >= 4 && username !== undefined && password === undefined) {
    // user:pass came from @ but host part had extra cols — ignore
  }

  return { type: protocol, host, port, username, password };
}

export function parseProxyList(
  text: string,
  defaultProtocol: 'http' | 'https' | 'socks5'
): { parsed: ParsedProxyLine[]; invalid: number } {
  const parsed: ParsedProxyLine[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/)) {
    const p = parseProxyLine(line, defaultProtocol);
    if (p) parsed.push(p);
    else if (line.trim() && !line.trim().startsWith('#')) invalid++;
  }
  return { parsed, invalid };
}

const importListSchema = z.object({
  text: z.string().min(1),
  defaultProtocol: z.enum(['http', 'https', 'socks5']).default('socks5'),
});

router.post('/api/v1/proxy/import-list', (req, res) => {
  const parsed = importListSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const { parsed: proxies, invalid } = parseProxyList(parsed.data.text, parsed.data.defaultProtocol);

  // Dedupe within the list and against existing proxies (host+port+username).
  const existing = new Set(
    xm.listProxies().map((p) => `${p.host}:${p.port}:${p.username ?? ''}`)
  );
  const created: string[] = [];
  let duplicates = 0;
  const seen = new Set<string>();
  for (const p of proxies) {
    const key = `${p.host}:${p.port}:${p.username ?? ''}`;
    if (seen.has(key) || existing.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    created.push(xm.createProxy(p));
  }
  res.json({
    code: 0,
    msg: 'success',
    data: { created: created.length, duplicates, invalid, proxy_ids: created },
  });
});

// ---------------------------------------------------------------------------
// Backup restore (v0.2.26): recover the database from a daily backup.
// ---------------------------------------------------------------------------

router.get('/api/v1/backups/list', (_req, res) => {
  res.json({ code: 0, msg: 'success', data: { list: listBackups() } });
});

// ---------------------------------------------------------------------------
// Data recovery scan (v0.2.27): find antidetect.db files in known locations
// (e.g. after a Windows-user change or a moved data folder) and report how
// many profiles each contains, so the user can re-point the data folder.
// ---------------------------------------------------------------------------

router.get('/api/v1/data/scan', async (_req, res) => {
  const os = await import('os');
  const candidates = [
    path.join(os.homedir(), '.antidetect', 'data'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'antidetect-browser', 'data'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antidetect Browser', 'data'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'antidetect-browser', 'data'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Antidetect Browser', 'data'),
  ];
  const current = DATA_DIR;
  const found: Array<{ dir: string; isCurrent: boolean; dbSize: number; modified: number; profiles: number }> = [];
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();

  for (const dir of new Set(candidates)) {
    const dbPath = path.join(dir, 'antidetect.db');
    try {
      if (!fs.existsSync(dbPath)) continue;
      const st = fs.statSync(dbPath);
      if (st.size < 4096) continue; // empty/placeholder
      let profiles = -1;
      try {
        const inst = new SQL.Database(fs.readFileSync(dbPath));
        const r = inst.exec('SELECT COUNT(*) FROM profiles');
        profiles = Number(r[0]?.values?.[0]?.[0] ?? -1);
        inst.close();
      } catch {
        profiles = -1; // unreadable/corrupt
      }
      found.push({ dir, isCurrent: path.resolve(dir) === path.resolve(current), dbSize: st.size, modified: st.mtimeMs, profiles });
    } catch {
      // skip unreadable candidates
    }
  }
  found.sort((a, b) => b.modified - a.modified);
  res.json({ code: 0, msg: 'success', data: { current, found } });
});
const transferSchema = z.object({
  from: z.string().min(1),
});

/**
 * POST /api/v1/data/transfer
 *
 * Imports profiles and their direct dependencies (groups, proxies, fingerprints,
 * devices) from an un-used data folder into the active antidetect database.
 * Source is opened read-only with sql.js; destination writes use INSERT OR IGNORE
 * keyed on the primary key so existing records are preserved unchanged.
 */
router.post('/api/v1/data/transfer', async (req, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({
      code: -1,
      msg: 'invalid body: from is required',
      data: {
        ok: false,
        from: '',
        created: 0,
        updated: 0,
        skipped: 0,
        dependencies: 0,
        dependents: 0,
        workspaces: 0,
        workspaces_verified: 0,
        workspace_failures: [],
        error: 'invalid body: from is required',
      },
    });
    return;
  }

  const fromDir = parsed.data.from;
  const resolvedFrom = path.resolve(fromDir);
  const currentDataDir = path.resolve(getDataDir() || DATA_DIR);

  if (resolvedFrom.toLowerCase() === currentDataDir.toLowerCase()) {
    res.json({
      code: -1,
      msg: 'source is the data folder in use',
      data: {
        ok: false,
        from: fromDir,
        created: 0,
        updated: 0,
        skipped: 0,
        dependencies: 0,
        dependents: 0,
        workspaces: 0,
        workspaces_verified: 0,
        workspace_failures: [],
        error: 'source is the data folder in use',
      },
    });
    return;
  }

  const dbPath = path.join(resolvedFrom, 'antidetect.db');
  if (!fs.existsSync(dbPath)) {
    res.json({
      code: -1,
      msg: 'source database missing',
      data: {
        ok: false,
        from: fromDir,
        created: 0,
        updated: 0,
        skipped: 0,
        dependencies: 0,
        dependents: 0,
        workspaces: 0,
        workspaces_verified: 0,
        workspace_failures: [],
        error: 'source database missing',
      },
    });
    return;
  }

  let sourceDb: SqlJsDatabase;
  try {
    const SQL = await initSqlJs();
    const bytes = fs.readFileSync(dbPath);
    sourceDb = new SQL.Database(bytes);
    // Validate it is actually a readable sqlite db
    sourceDb.exec('SELECT 1');
  } catch (err) {
    res.json({
      code: -1,
      msg: 'source database unreadable or corrupt',
      data: {
        ok: false,
        from: fromDir,
        created: 0,
        updated: 0,
        skipped: 0,
        dependencies: 0,
        dependents: 0,
        workspaces: 0,
        workspaces_verified: 0,
        workspace_failures: [],
        error: `source database unreadable or corrupt: ${(err as Error).message}`,
      },
    });
    return;
  }

  try {
    const dstDb = getDb();

    interface ColumnInfo {
      name: string;
      type: string;
      notNull: boolean;
      hasDefault: boolean;
    }

    // Destination schema for a table, including what SQLite will NOT let us omit. The source
    // may be an older build with fewer columns, so the insert has to satisfy every NOT NULL
    // column the destination declares without looking it up by hand per table.
    const destColumnInfo = (table: string): ColumnInfo[] => {
      try {
        const rows = dstDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }>;
        return rows.map((r) => ({
          name: r.name,
          type: String(r.type || ''),
          notNull: Number(r.notnull) === 1,
          hasDefault: r.dflt_value !== null && r.dflt_value !== undefined,
        }));
      } catch {
        return [];
      }
    };

    const sourceColumns = (table: string): string[] => {
      try {
        const q = sourceDb.exec(`PRAGMA table_info(${table})`);
        if (!q.length) return [];
        return q[0].values.map((v: unknown[]) => String(v[1]));
      } catch {
        return [];
      }
    };

    /**
     * A value for a NOT NULL destination column the source does not carry.
     *
     * `INSERT OR IGNORE` does NOT fail on this: SQLite skips the row and reports zero changes,
     * which is indistinguishable from "the row was already there". Without this the import
     * would silently drop profiles and then report them as already present — a transfer that
     * says it worked and moved nothing. A timestamp column gets "now" so the row looks like
     * what it is (imported today); everything else gets a benign zero value of its affinity.
     */
    const fillerValue = (column: ColumnInfo): string | number => {
      const type = column.type.toUpperCase();
      if (column.name.endsWith('_at') || type.includes('INT')) return Date.now();
      if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 0;
      return '';
    };

    const dependencyTables = ['groups', 'proxies', 'fingerprints', 'devices', 'extensions'];
    const profileKeyedTables = ['profile_extensions', 'profile_tags'];
    const tablesInFkOrder = [...dependencyTables, 'profiles', ...profileKeyedTables];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let dependencies = 0;
    let dependents = 0;
    dstDb.exec('BEGIN TRANSACTION');
    try {
      for (const table of tablesInFkOrder) {
        const srcCols = sourceColumns(table);
        if (srcCols.length === 0) continue;
        const dstInfo = destColumnInfo(table);
        if (dstInfo.length === 0) continue;

        const dstNames = dstInfo.map((c) => c.name);
        const commonCols = srcCols.filter((col) => dstNames.includes(col));
        if (commonCols.length === 0) continue;

        // Columns the source cannot supply but the destination requires. `id` is the key we
        // already have; a column with a DEFAULT does not need one.
        const fillers = dstInfo.filter(
          (c) => c.notNull && !c.hasDefault && !commonCols.includes(c.name) && c.name !== 'id',
        );

        const insertCols = [...commonCols, ...fillers.map((c) => c.name)];
        const quotedCols = insertCols.map((c) => `"${c}"`).join(', ');
        const placeholders = insertCols.map(() => '?').join(', ');
        const insertStmt = dstDb.prepare(`INSERT OR IGNORE INTO ${table} (${quotedCols}) VALUES (${placeholders})`);

        const queryRes = sourceDb.exec(`SELECT ${commonCols.map((c) => `"${c}"`).join(', ')} FROM ${table}`); // pi-lens-ignore: sql-injection
        if (!queryRes.length || !queryRes[0].values) continue;

        for (const rowValues of queryRes[0].values) {
          const params = [...rowValues, ...fillers.map(fillerValue)];
          const resRun = insertStmt.run(...params);
          const inserted = resRun.changes > 0;

          if (table !== 'profiles') {
            if (inserted) {
              if (profileKeyedTables.includes(table)) {
                dependents += 1;
              } else {
                dependencies += 1;
              }
            }
            continue;
          }

          if (inserted) {
            created += 1;
            continue;
          }

          // Zero changes has two very different causes: the id is already here, or the row
          // violated a constraint and was skipped. Reporting the second as "already present"
          // is how a transfer can claim success and move nothing, so the id is looked up
          // rather than inferred.
          const idIndex = commonCols.indexOf('id');
          const rowId = idIndex >= 0 ? rowValues[idIndex] : undefined;
          const existingRow =
            rowId === undefined
              ? undefined
              : (dstDb.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rowId) as Record<string, unknown> | undefined); // pi-lens-ignore: sql-injection

          if (existingRow) {
            // Source-wins upsert for profiles: update differing non-key columns from the source row.
            //
            // Some columns describe the RUNNING installation rather than the profile, and the
            // source folder is a snapshot of a different machine at a different time. Copying
            // them would report this installation's state from someone else's row: `status`
            // would mark a profile that is open right here as `closed`, `updated_at` would
            // claim it was last touched then, and `created_at` would rewrite its history. The
            // repository already treats a running profile as untouchable for maintenance
            // (`rotateFingerprints` skips it with error 'running'); a transfer is not an
            // exception to that, so the live columns are left exactly as the destination holds
            // them and everything the operator actually moves — name, proxy, fingerprint,
            // device, launch args, colour — comes from the source.
            const LIVE_COLUMNS = new Set(['status', 'created_at', 'updated_at']);
            const differingCols: string[] = [];
            const updateParams: unknown[] = [];

            for (let i = 0; i < commonCols.length; i++) {
              const colName = commonCols[i];
              if (colName === 'id' || (table === 'profiles' && LIVE_COLUMNS.has(colName))) continue;
              const srcVal = rowValues[i];
              const dstVal = existingRow[colName];
              let valuesDiffer = false;
              if (srcVal === null || srcVal === undefined) {
                valuesDiffer = dstVal !== null && dstVal !== undefined;
              } else if (dstVal === null || dstVal === undefined) {
                valuesDiffer = true;
              } else {
                valuesDiffer = String(srcVal) !== String(dstVal);
              }
              if (valuesDiffer) {
                differingCols.push(colName);
                updateParams.push(srcVal);
              }
            }

            if (differingCols.length > 0) {
              const setClauses = differingCols.map((col) => `"${col}" = ?`).join(', ');
              dstDb.prepare(`UPDATE ${table} SET ${setClauses} WHERE id = ?`).run(...updateParams, rowId); // pi-lens-ignore: sql-injection
              updated += 1;
            } else {
              skipped += 1;
            }
          } else {
            throw new Error(
              `${table} row ${String(rowId)} could not be imported and is not already present — ` +
                'the insert was refused by the destination schema',
            );
          }
        }
      }
      dstDb.exec('COMMIT');
    } catch (err) {
      try {
        dstDb.exec('ROLLBACK');
      } catch {
        // rollback is best-effort; the original error is the one worth reporting
      }
      throw err;
    }

    flushDb();

    /**
     * Bring the profiles' browser state across, not just their rows.
     *
     * The rows above are metadata; the sessions are on disk. A profile's logins and cookies
     * live in `profiles/<id>/Default/{Cookies,Login Data,Local Storage}`, and `cookies_json`
     * is typically NULL — measured on this machine, three source profiles carried none, while
     * one workspace held 8.5 MB of real browser state. Copying rows alone produces a profile
     * that still lists and still launches, but as a brand-new browser with every login gone,
     * which is silent data loss rather than a transfer.
     *
     * Merge, never overwrite: `force: false, errorOnExist: false` fills in what the
     * destination lacks and leaves whatever it already holds. The folder in use is the
     * authoritative copy for a profile it already has.
     *
     * A workspace that cannot be copied is reported, not fatal: the rows are already
     * committed, and refusing the whole transfer would leave the operator with neither a
     * clear result nor a usable one. The count is what tells them whether to look.
     */
    let workspaces = 0;
    let workspacesVerified = 0;
    const workspaceFailures: Array<{ id: string; error: string }> = [];
    const srcProfilesDir = path.join(resolvedFrom, 'profiles');
    const dstProfilesDir = path.join(currentDataDir, 'profiles');
    if (fs.existsSync(srcProfilesDir)) {
      for (const entry of fs.readdirSync(srcProfilesDir)) {
        const src = path.join(srcProfilesDir, entry);
        try {
          if (!fs.statSync(src).isDirectory()) continue;
          const dst = path.join(dstProfilesDir, entry);
          fs.cpSync(src, dst, {
            recursive: true,
            force: false,
            errorOnExist: false,
          });
          workspaces += 1;

          // Workspace verification: check if source had session files (Cookies, Login Data)
          // and verify destination has non-empty file
          const checkCandidates = [
            path.join('Default', 'Network', 'Cookies'),
            path.join('Default', 'Cookies'),
            path.join('Default', 'Login Data'),
          ];
          let srcHadSession = false;
          let dstHasSession = false;

          for (const relPath of checkCandidates) {
            const srcFile = path.join(src, relPath);
            if (fs.existsSync(srcFile)) {
              const stat = fs.statSync(srcFile);
              if (stat.isFile() && stat.size > 0) {
                srcHadSession = true;
                const dstFile = path.join(dst, relPath);
                if (fs.existsSync(dstFile) && fs.statSync(dstFile).isFile() && fs.statSync(dstFile).size > 0) {
                  dstHasSession = true;
                  break;
                }
              }
            }
          }

          if (srcHadSession && dstHasSession) {
            workspacesVerified += 1;
          }
        } catch (err) {
          workspaceFailures.push({ id: entry, error: (err as Error).message });
        }
      }
    }

    res.json({
      code: 0,
      msg: 'success',
      data: {
        ok: true,
        from: fromDir,
        created,
        updated,
        skipped,
        dependencies,
        dependents,
        workspaces,
        workspaces_verified: workspacesVerified,
        workspace_failures: workspaceFailures,
      },
    });
  } catch (err) {
    res.json({
      code: -1,
      msg: (err as Error).message,
      data: {
        ok: false,
        from: fromDir,
        created: 0,
        updated: 0,
        skipped: 0,
        dependencies: 0,
        dependents: 0,
        workspaces: 0,
        workspaces_verified: 0,
        workspace_failures: [],
        error: (err as Error).message,
      },
    });
  } finally {
    try {
      sourceDb.close();
    } catch {
      // ignore close failure
    }
  }
});

const deleteDataFolderSchema = z.object({ dir: z.string().min(1) });

/**
 * POST /api/v1/data/delete
 *
 * Removes an old data folder the operator has already transferred out of — the second half of
 * "transfer, then get rid of the leftovers". The guards live here rather than in the button
 * that calls it: a UI check is a convenience, this one is the rule.
 *
 *   1. Never the folder in use.
 *   2. Must exist and look like a data folder (has `antidetect.db` or `profiles/`), so a typo
 *      cannot target an unrelated directory.
 *   3. Every profile id in that folder's database must already exist in the current one. This
 *      is the operator's own condition — "после того как перенёс в основную" — and the only
 *      safe form of it: comparing counts would pass two folders that hold different profiles.
 *
 * Deletion goes to the Recycle Bin on Windows. Permanent, unrecoverable removal of someone's
 * browser profile data should not be one click away; the Recycle Bin keeps the mistake
 * reversible, which is what makes the control safe to put in a row.
 */
router.post('/api/v1/data/delete', async (req, res) => {
  const parsed = deleteDataFolderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body: dir is required', data: { ok: false, dir: '', reason: 'invalid' } });
    return;
  }

  const target = path.resolve(parsed.data.dir);
  const currentDataDir = path.resolve(getDataDir() || DATA_DIR);

  if (target.toLowerCase() === currentDataDir.toLowerCase()) {
    res.json({
      code: -1,
      msg: 'refusing to delete the data folder in use',
      data: { ok: false, dir: parsed.data.dir, reason: 'current' },
    });
    return;
  }

  if (!fs.existsSync(target)) {
    res.json({
      code: -1,
      msg: 'folder does not exist',
      data: { ok: false, dir: parsed.data.dir, reason: 'missing' },
    });
    return;
  }

  // A data folder, not merely a path that happens to exist. `profiles/` alone counts because a
  // folder whose database was already moved away still holds workspaces worth recovering.
  const dbPath = path.join(target, 'antidetect.db');
  const hasDb = fs.existsSync(dbPath);
  const hasProfilesDir = fs.existsSync(path.join(target, 'profiles'));
  if (!hasDb && !hasProfilesDir) {
    res.json({
      code: -1,
      msg: 'not a data folder: no antidetect.db and no profiles directory',
      data: { ok: false, dir: parsed.data.dir, reason: 'not-a-data-folder' },
    });
    return;
  }

  /**
   * Guard 3: everything in there must already be here. Read with sql.js, matching the transfer
   * route, so a database the destination can read is a database this can read.
   */
  if (hasDb) {
    try {
      const SQL = await initSqlJs();
      const srcDb = new SQL.Database(fs.readFileSync(dbPath));
      let sourceIds: string[] = [];
      try {
        const q = srcDb.exec('SELECT id FROM profiles');
        sourceIds = q.length ? q[0].values.map((v) => String(v[0])) : [];
      } finally {
        srcDb.close();
      }

      const dstDb = getDb();
      const missing: string[] = [];
      for (const id of sourceIds) {
        const present = dstDb.prepare('SELECT 1 AS present FROM profiles WHERE id = ?').get(id) as
          | { present?: number }
          | undefined;
        if (present?.present !== 1) missing.push(id);
      }

      if (missing.length > 0) {
        res.json({
          code: -1,
          msg: `${missing.length} profile(s) in this folder are not in the folder in use`,
          data: { ok: false, dir: parsed.data.dir, reason: 'not-transferred', missing: missing.length },
        });
        return;
      }
    } catch (err) {
      res.json({
        code: -1,
        msg: `could not read the folder's database: ${(err as Error).message}`,
        data: { ok: false, dir: parsed.data.dir, reason: 'unreadable' },
      });
      return;
    }
  }

  if (process.platform !== 'win32') {
    res.json({
      code: -1,
      msg: 'deleting a data folder is only supported on Windows, where it can go to the Recycle Bin',
      data: { ok: false, dir: parsed.data.dir, reason: 'unsupported-platform' },
    });
    return;
  }

  try {
    // A path embedded in a PowerShell single-quoted string needs its own quotes doubled.
    const psPath = target.replace(/'/g, "''");
    childProcess.execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${psPath}','OnlyErrorDialogs','SendToRecycleBin')`,
      ],
      { timeout: 120_000, windowsHide: true },
    );
  } catch (err) {
    res.json({
      code: -1,
      msg: `could not move the folder to the Recycle Bin: ${(err as Error).message}`,
      data: { ok: false, dir: parsed.data.dir, reason: 'recycle-failed' },
    });
    return;
  }

  // Say what actually happened rather than assuming the call did what it was asked. A silent
  // no-op here would leave the row on screen with nothing explaining why it stayed.
  if (fs.existsSync(target)) {
    res.json({
      code: -1,
      msg: 'the folder is still on disk after the Recycle Bin operation',
      data: { ok: false, dir: parsed.data.dir, reason: 'still-present' },
    });
    return;
  }

  res.json({ code: 0, msg: 'success', data: { ok: true, dir: parsed.data.dir, reason: 'deleted', recycled: true } });
});

const restoreSchema = z.object({ name: z.string().regex(/^antidetect-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.db$|^antidetect-[\w.-]+\.db$/) });

router.post('/api/v1/backups/restore', async (req, res) => {
  const parsed = restoreSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid backup name', data: {} });
    return;
  }
  try {
    // The database is reloaded inside restoreBackup, so the restored data is live as soon as
    // this resolves. `restart_required` stays false for that reason — the operator no longer
    // has to restart, and telling them to would imply the restore is not yet in effect.
    await restoreBackup(parsed.data.name);
    res.json({ code: 0, msg: 'success', data: { restart_required: false } });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

export default router;
