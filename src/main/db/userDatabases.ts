import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../config';
import { writeXlsx, readXlsx } from '../io/xlsx';

export interface UserColumnDef {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
  primaryKey?: boolean;
  notNull?: boolean;
}

export interface UserTableSummary {
  name: string;
  columns: UserColumnDef[];
  rowCount: number;
  createdAt?: number;
}

export interface SqlExecutionResult {
  isQuery: boolean;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  changes?: number;
  lastInsertRowid?: number;
  executionTimeMs: number;
  error?: string;
}

const USER_DB_PATH = path.join(DATA_DIR, 'user_databases.db');
let sqlJsModule: SqlJsStatic | null = null;
let userDbInstance: SqlJsDatabase | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!sqlJsModule) {
    sqlJsModule = await initSqlJs();
  }
  return sqlJsModule;
}

function rawRun(database: SqlJsDatabase, query: string, params?: unknown[]): void {
  if (params && params.length > 0) {
    database.run(query, params as any);
  } else {
    database.run(query);
  }
}

function rawPrepare(database: SqlJsDatabase, query: string) {
  return database.prepare(query);
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushUserDb();
  }, 100);
}

export function flushUserDb(): void {
  if (!userDbInstance) return;
  try {
    const data = userDbInstance.export();
    const buf = Buffer.from(data);
    const tmp = `${USER_DB_PATH}.tmp`;
    fs.mkdirSync(path.dirname(USER_DB_PATH), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, USER_DB_PATH);
  } catch (err) {
    console.error('Failed to flush user database:', err);
  }
}

export async function getUserDb(): Promise<SqlJsDatabase> {
  if (userDbInstance) return userDbInstance;
  const SQL = await getSql();
  if (fs.existsSync(USER_DB_PATH)) {
    try {
      const fileBytes = fs.readFileSync(USER_DB_PATH);
      userDbInstance = new SQL.Database(fileBytes);
    } catch {
      userDbInstance = new SQL.Database();
    }
  } else {
    userDbInstance = new SQL.Database();
  }

  // Schema metadata table to store table creation info
  userDbInstance.run(`
    CREATE TABLE IF NOT EXISTS _nulltrace_metadata (
      table_name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);

  return userDbInstance;
}

function sanitizeIdentifier(name: string): string {
  const clean = name.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(clean)) {
    throw new Error(`Invalid table or column name: "${name}". Use only letters, digits, and underscores.`);
  }
  return clean;
}

export async function listUserTables(): Promise<UserTableSummary[]> {
  const db = await getUserDb();
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_nulltrace_metadata' ORDER BY name ASC"
  );
  const tables: string[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (typeof row.name === 'string') {
      tables.push(row.name);
    }
  }
  stmt.free();

  const summaries: UserTableSummary[] = [];
  for (const name of tables) {
    const colSql = 'PRAGMA table_info("' + sanitizeIdentifier(name) + '")';
    const colStmt = rawPrepare(db, colSql);
    const cols: UserColumnDef[] = [];
    while (colStmt.step()) {
      const col = colStmt.getAsObject();
      cols.push({
        name: String(col.name),
        type: (String(col.type).toUpperCase() as UserColumnDef['type']) || 'TEXT',
        primaryKey: Boolean(col.pk),
        notNull: Boolean(col.notnull),
      });
    }
    colStmt.free();

    let count = 0;
    try {
      const countSql = 'SELECT COUNT(*) as c FROM "' + sanitizeIdentifier(name) + '"';
      const countStmt = rawPrepare(db, countSql);
      if (countStmt.step()) {
        count = Number(countStmt.getAsObject().c || 0);
      }
      countStmt.free();
    } catch {
      // ignore
    }

    let createdAt: number | undefined;
    try {
      const metaStmt = db.prepare('SELECT created_at FROM _nulltrace_metadata WHERE table_name = ?');
      metaStmt.bind([name]);
      if (metaStmt.step()) {
        createdAt = Number(metaStmt.getAsObject().created_at);
      }
      metaStmt.free();
    } catch {
      // ignore
    }

    summaries.push({
      name,
      columns: cols,
      rowCount: count,
      createdAt,
    });
  }

  return summaries;
}

export async function createUserTable(name: string, columns: UserColumnDef[]): Promise<void> {
  const tableName = sanitizeIdentifier(name);
  if (!columns || columns.length === 0) {
    throw new Error('Table must contain at least one column');
  }

  const db = await getUserDb();
  const colDefs: string[] = [];
  for (const col of columns) {
    const colName = sanitizeIdentifier(col.name);
    const colType = ['TEXT', 'INTEGER', 'REAL', 'BLOB'].includes(col.type) ? col.type : 'TEXT';
    let def = `"${colName}" ${colType}`;
    if (col.primaryKey) def += ' PRIMARY KEY';
    if (col.notNull && !col.primaryKey) def += ' NOT NULL';
    colDefs.push(def);
  }

  const sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(', ')});`;
  db.run(sql);
  db.run('INSERT OR REPLACE INTO _nulltrace_metadata (table_name, created_at) VALUES (?, ?)', [tableName, Date.now()]);
  schedulePersist();
}

export async function dropUserTable(name: string): Promise<void> {
  const tableName = sanitizeIdentifier(name);
  const db = await getUserDb();
  const dropSql = 'DROP TABLE IF EXISTS "' + tableName + '";';
  rawRun(db, dropSql);
  db.run('DELETE FROM _nulltrace_metadata WHERE table_name = ?', [tableName]);
  schedulePersist();
}

export async function executeUserSql(sql: string, params: unknown[] = []): Promise<SqlExecutionResult> {
  const start = performance.now();
  const db = await getUserDb();
  const trimmed = sql.trim();
  const isQuery = /^(SELECT|PRAGMA|EXPLAIN)/i.test(trimmed);

  try {
    if (isQuery) {
      const stmt = db.prepare(sql);
      if (params.length > 0) stmt.bind(params as any);
      const rows: Array<Record<string, unknown>> = [];
      const columns = stmt.getColumnNames();
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return {
        isQuery: true,
        columns,
        rows,
        executionTimeMs: Math.round((performance.now() - start) * 100) / 100,
      };
    } else {
      // Non-query mutation
      db.run(sql, params as any);
      const changes = db.getRowsModified();
      schedulePersist();
      return {
        isQuery: false,
        columns: [],
        rows: [],
        changes,
        executionTimeMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }
  } catch (err) {
    return {
      isQuery,
      columns: [],
      rows: [],
      executionTimeMs: Math.round((performance.now() - start) * 100) / 100,
      error: (err as Error).message,
    };
  }
}

export async function exportTableToXlsx(tableName: string): Promise<Buffer> {
  const db = await getUserDb();
  const safeName = sanitizeIdentifier(tableName);
  const selectSql = 'SELECT * FROM "' + safeName + '"';
  const stmt = rawPrepare(db, selectSql);
  const columns = stmt.getColumnNames();
  const rows: string[][] = [columns];
  while (stmt.step()) {
    const obj = stmt.getAsObject();
    rows.push(columns.map((col) => (obj[col] === null || obj[col] === undefined ? '' : String(obj[col]))));
  }
  stmt.free();
  return writeXlsx(rows);
}

export async function importXlsxIntoTable(tableName: string, xlsxBase64: string): Promise<{ inserted: number; errors: string[] }> {
  const safeName = sanitizeIdentifier(tableName);
  const db = await getUserDb();
  const buf = Buffer.from(xlsxBase64, 'base64');
  const tableData = readXlsx(buf);
  if (tableData.length < 2) {
    return { inserted: 0, errors: ['File is empty or has no header'] };
  }

  const headers = tableData[0].map((h) => sanitizeIdentifier(h));
  const placeholders = headers.map(() => '?').join(', ');
  const colNames = headers.map((h) => `"${h}"`).join(', ');
  const insertSql = `INSERT INTO "${safeName}" (${colNames}) VALUES (${placeholders});`;

  let inserted = 0;
  const errors: string[] = [];
  for (let i = 1; i < tableData.length; i++) {
    const row = tableData[i];
    try {
      rawRun(db, insertSql, row as any);
      inserted++;
    } catch (err) {
      errors.push(`Row ${i + 1}: ${(err as Error).message}`);
    }
  }

  if (inserted > 0) schedulePersist();
  return { inserted, errors };
}
