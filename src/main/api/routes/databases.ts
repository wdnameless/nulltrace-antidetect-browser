import { Router } from 'express';
import { z } from 'zod';
import {
  listUserTables,
  createUserTable,
  dropUserTable,
  executeUserSql,
  exportTableToXlsx,
  importXlsxIntoTable,
  UserColumnDef,
} from '../../db/userDatabases';

const router = Router();

const columnSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['TEXT', 'INTEGER', 'REAL', 'BLOB']),
  primaryKey: z.boolean().optional(),
  notNull: z.boolean().optional(),
});

const createTableSchema = z.object({
  name: z.string().min(1),
  columns: z.array(columnSchema).min(1),
});

const querySchema = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
});

const importXlsxSchema = z.object({
  table: z.string().min(1),
  base64: z.string().min(1),
});

router.get('/api/v1/databases/tables', async (_req, res) => {
  try {
    const tables = await listUserTables();
    res.json({ code: 0, msg: 'success', data: { tables } });
  } catch (err) {
    res.status(500).json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.post('/api/v1/databases/tables', async (req, res) => {
  const parsed = createTableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    await createUserTable(parsed.data.name, parsed.data.columns as UserColumnDef[]);
    res.json({ code: 0, msg: 'success', data: { name: parsed.data.name } });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.delete('/api/v1/databases/tables/:name', async (req, res) => {
  try {
    await dropUserTable(req.params.name);
    res.json({ code: 0, msg: 'success', data: {} });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.post('/api/v1/databases/query', async (req, res) => {
  const parsed = querySchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const result = await executeUserSql(parsed.data.sql, parsed.data.params);
    res.json({ code: 0, msg: 'success', data: result });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.get('/api/v1/databases/export-xlsx', async (req, res) => {
  const tableName = String(req.query.table || '');
  if (!tableName) {
    res.status(400).json({ code: -1, msg: 'table query parameter is required', data: {} });
    return;
  }
  try {
    const buf = await exportTableToXlsx(tableName);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${tableName}.xlsx"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.post('/api/v1/databases/import-xlsx', async (req, res) => {
  const parsed = importXlsxSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const result = await importXlsxIntoTable(parsed.data.table, parsed.data.base64);
    res.json({ code: 0, msg: 'success', data: result });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

export default router;
