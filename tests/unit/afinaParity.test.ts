import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDb, closeDb } from '../../src/main/db';
import { clearProfileCache, createProfile, deleteProfile } from '../../src/main/profiles/profileManager';
import { PROFILES_DIR } from '../../src/main/config';
import { buildCookiesForToken } from '../../src/main/profiles/tokenLogin';
import {
  createUserTable,
  listUserTables,
  executeUserSql,
  dropUserTable,
  exportTableToXlsx,
  importXlsxIntoTable,
} from '../../src/main/db/userDatabases';
import { readXlsx, writeXlsx } from '../../src/main/io/xlsx';
import { getAiConfig, updateAiConfig } from '../../src/main/ai/chatManager';

describe('Afina Parity Expansion: Clear Cache, Proxy XLSX, Token Login, User DBs, AI Chat', () => {
  beforeAll(async () => {
    await initDb();
  });

  afterAll(() => {
    try {
      closeDb();
    } catch {
      // ignore
    }
  });

  describe('1. Token Login Builder', () => {
    it('builds Twitter cookies and target URL', () => {
      const res = buildCookiesForToken('twitter', 'my_twitter_auth_token_123');
      expect(res.startUrl).toBe('https://x.com/home');
      expect(res.cookies.length).toBe(2);
      expect(res.cookies[0].name).toBe('auth_token');
      expect(res.cookies[0].value).toBe('my_twitter_auth_token_123');
      expect(res.cookies[0].domain).toBe('.twitter.com');
      expect(res.cookies[1].domain).toBe('.x.com');
    });

    it('builds Discord token cookie and app URL', () => {
      const res = buildCookiesForToken('discord', 'mfa.discord_token_sample');
      expect(res.startUrl).toBe('https://discord.com/app');
      expect(res.cookies.length).toBe(1);
      expect(res.cookies[0].name).toBe('token');
      expect(res.cookies[0].value).toBe('mfa.discord_token_sample');
    });

    it('builds Facebook cookies from c_user:xs string', () => {
      const res = buildCookiesForToken('facebook', '10008899:xs_secret_token');
      expect(res.startUrl).toBe('https://www.facebook.com/');
      expect(res.cookies.length).toBe(2);
      expect(res.cookies.find((c) => c.name === 'c_user')?.value).toBe('10008899');
      expect(res.cookies.find((c) => c.name === 'xs')?.value).toBe('xs_secret_token');
    });

    it('builds Custom Cookie correctly', () => {
      const res = buildCookiesForToken('custom_cookie', 'session_val_xyz', 'mycustomsite.org', 'custom_sid');
      expect(res.startUrl).toBe('https://mycustomsite.org');
      expect(res.cookies.length).toBe(1);
      expect(res.cookies[0].name).toBe('custom_sid');
      expect(res.cookies[0].value).toBe('session_val_xyz');
      expect(res.cookies[0].domain).toBe('.mycustomsite.org');
    });
  });
  describe('1.1 Clear Profile Cache', () => {
    it('clears cache directories while leaving non-cache files intact', () => {
      const pId = createProfile({ name: 'Cache Test Profile' });
      const pDir = path.join(PROFILES_DIR, pId);
      const cacheDir = path.join(pDir, 'Default', 'Cache');
      const codeCacheDir = path.join(pDir, 'Default', 'Code Cache');
      const cookieFile = path.join(pDir, 'Default', 'Cookies');

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.mkdirSync(codeCacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, 'data_0'), 'cached data');
      fs.writeFileSync(cookieFile, 'cookies database content');

      const result = clearProfileCache(pId);
      expect(result.ok).toBe(true);
      expect(result.cleared_dirs.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(cacheDir, 'data_0'))).toBe(false);
      expect(fs.existsSync(cookieFile)).toBe(true);

      deleteProfile(pId);
    });
  });


  describe('2. Proxy XLSX Export / Import roundtrip', () => {
    it('writes and reads proxy XLSX rows cleanly', () => {
      const headers = ['Type', 'Host', 'Port', 'Username', 'Password', 'Status', 'Country', 'Country Code', 'City'];
      const row1 = ['socks5', '192.168.1.100', '1080', 'user1', 'pass1', 'active', 'Germany', 'DE', 'Berlin'];
      const row2 = ['http', '10.0.0.5', '8080', '', '', 'unknown', 'United States', 'US', 'New York'];

      const buf = writeXlsx([headers, row1, row2]);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBeGreaterThan(100);

      const parsed = readXlsx(buf);
      expect(parsed.length).toBe(3);
      expect(parsed[0]).toEqual(headers);
      expect(parsed[1]).toEqual(row1);
      expect(parsed[2]).toEqual(row2);
    });
  });

  describe('3. User Databases & SQL Terminal', () => {
    const testTableName = 'test_leads_' + Date.now();

    afterEach(async () => {
      try {
        await dropUserTable(testTableName);
      } catch {
        // ignore
      }
    });

    it('creates a custom user table and lists it', async () => {
      await createUserTable(testTableName, [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'lead_name', type: 'TEXT', notNull: true },
        { name: 'balance', type: 'REAL' },
      ]);

      const tables = await listUserTables();
      const created = tables.find((t) => t.name === testTableName);
      expect(created).toBeDefined();
      expect(created?.columns.length).toBe(3);
      expect(created?.columns[0].name).toBe('id');
      expect(created?.columns[0].primaryKey).toBe(true);
    });

    it('executes INSERT and SELECT queries via SQL Terminal engine', async () => {
      await createUserTable(testTableName, [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'email', type: 'TEXT' },
      ]);

      // INSERT mutation
      const insertRes = await executeUserSql(
        `INSERT INTO "${testTableName}" (email) VALUES ('lead@test.com'), ('admin@test.com');`
      );
      expect(insertRes.isQuery).toBe(false);
      expect(insertRes.changes).toBe(2);

      // SELECT query
      const selectRes = await executeUserSql(`SELECT * FROM "${testTableName}" ORDER BY id ASC;`);
      expect(selectRes.isQuery).toBe(true);
      expect(selectRes.rows.length).toBe(2);
      expect(selectRes.rows[0].email).toBe('lead@test.com');
      expect(selectRes.rows[1].email).toBe('admin@test.com');
      expect(selectRes.columns).toContain('email');
      expect(selectRes.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('exports and imports user table XLSX data', async () => {
      await createUserTable(testTableName, [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: 'item', type: 'TEXT' },
      ]);

      await executeUserSql(`INSERT INTO "${testTableName}" (id, item) VALUES (1, 'apple'), (2, 'banana');`);

      const xlsxBuf = await exportTableToXlsx(testTableName);
      expect(xlsxBuf.length).toBeGreaterThan(100);

      const parsed = readXlsx(xlsxBuf);
      expect(parsed.length).toBe(3);
      expect(parsed[1][1]).toBe('apple');
      expect(parsed[2][1]).toBe('banana');

      // Import into table
      const newImportData = writeXlsx([
        ['id', 'item'],
        ['3', 'cherry'],
        ['4', 'date'],
      ]);
      const importRes = await importXlsxIntoTable(testTableName, newImportData.toString('base64'));
      expect(importRes.inserted).toBe(2);

      const countCheck = await executeUserSql(`SELECT COUNT(*) as c FROM "${testTableName}";`);
      expect(countCheck.rows[0].c).toBe(4);
    });
  });

  describe('4. AI Chat Configuration', () => {
    it('manages AI config and updates masked API key', () => {
      const updated = updateAiConfig({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test-secret-key-12345678',
        systemPrompt: 'Custom prompt for test',
      });

      expect(updated.provider).toBe('openai');
      expect(updated.model).toBe('gpt-4o');
      expect(updated.apiKey).toBe('sk-test-secret-key-12345678');

      const saved = getAiConfig();
      expect(saved.model).toBe('gpt-4o');
      expect(saved.apiKey).toBe('sk-test-secret-key-12345678');
      expect(saved.systemPrompt).toBe('Custom prompt for test');
    });
  });
});
