import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import express from 'express';
import {
  readCookieDb,
  mergeCookiesToDb,
  encryptCookieValueV10,
  decryptCookieValue,
  unwrapOsKeyFromLocalState,
  setDpapiUnprotectSeam,
  resetDpapiUnprotectSeam,
  CookieRow,
} from '../../src/main/io/cookieSqlite';
import cookiesRouter from '../../src/main/api/routes/cookies';
import { initDb, getDb, closeDb } from '../../src/main/db';
import * as launcher from '../../src/main/launcher/chromium';

describe('Cookie SQLite IO and Routes', () => {
  const dummyAesKey = crypto.randomBytes(32);

  beforeEach(() => {
    // Provide seam for DPAPI unprotect
    setDpapiUnprotectSeam((_encKey: Buffer) => {
      // Return a simulated fixed 32-byte AES key
      return dummyAesKey;
    });
  });

  afterEach(() => {
    resetDpapiUnprotectSeam();
  });

  describe('v10 encryption / decryption roundtrip', () => {
    it('encrypts and decrypts a cookie with fixed AES-256-GCM key', () => {
      const plaintext = 'test_session_token_123456789';
      const encrypted = encryptCookieValueV10(plaintext, dummyAesKey);

      expect(encrypted.subarray(0, 3).toString('utf8')).toBe('v10');
      expect(encrypted.length).toBeGreaterThan(3 + 12 + 16);

      const decrypted = decryptCookieValue(encrypted, dummyAesKey);
      expect(decrypted).toBe(plaintext);
    });

    it('unwraps OS key from simulated Local State via DPAPI seam', () => {
      // Chromium Local State format: "os_crypt": { "encrypted_key": base64("DPAPI" + encryptedBlob) }
      const fakeBlob = Buffer.concat([Buffer.from('DPAPI', 'latin1'), Buffer.from('encrypted_payload')]);
      const localStateJson = JSON.stringify({
        os_crypt: {
          encrypted_key: fakeBlob.toString('base64'),
        },
      });

      const key = unwrapOsKeyFromLocalState(localStateJson);
      expect(key).toEqual(dummyAesKey);
    });
  });

  describe('Chromium Cookies SQLite read and merge semantics', () => {
    it('creates a new SQLite DB with cookies, then reads it back', async () => {
      const cookiesToSave: CookieRow[] = [
        {
          name: 'session_id',
          value: 'xyz987',
          domain: '.example.com',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'tracker',
          value: 'trk_111',
          domain: '.tracker.org',
          path: '/track',
          httpOnly: false,
          secure: false,
          sameSite: 'None',
        },
      ];

      const dbBytes = await mergeCookiesToDb(null, cookiesToSave, dummyAesKey);
      expect(dbBytes).toBeInstanceOf(Buffer);
      expect(dbBytes.length).toBeGreaterThan(0);

      const readBack = await readCookieDb(dbBytes, dummyAesKey);
      expect(readBack).toHaveLength(2);

      const sessionCookie = readBack.find((c) => c.name === 'session_id');
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie?.value).toBe('xyz987');
      expect(sessionCookie?.domain).toBe('.example.com');
      expect(sessionCookie?.path).toBe('/');
      expect(sessionCookie?.httpOnly).toBe(true);
      expect(sessionCookie?.secure).toBe(true);
      expect(sessionCookie?.sameSite).toBe('Lax');

      const trackerCookie = readBack.find((c) => c.name === 'tracker');
      expect(trackerCookie).toBeDefined();
      expect(trackerCookie?.value).toBe('trk_111');
      expect(trackerCookie?.sameSite).toBe('None');
    });

    it('merge preserves untouched rows and updates overlapping rows (INSERT OR REPLACE)', async () => {
      // Step 1: initial db with cookie A and cookie B
      const initial: CookieRow[] = [
        {
          name: 'cookieA',
          value: 'initial_value_A',
          domain: 'site.com',
          path: '/',
          secure: false,
        },
        {
          name: 'cookieB',
          value: 'initial_value_B',
          domain: 'site.com',
          path: '/pathB',
          secure: true,
        },
      ];
      const initialDb = await mergeCookiesToDb(null, initial, dummyAesKey);

      // Step 2: merge with updated cookieA and new cookieC
      const updateList: CookieRow[] = [
        {
          name: 'cookieA',
          value: 'updated_value_A',
          domain: 'site.com',
          path: '/',
          secure: true,
        },
        {
          name: 'cookieC',
          value: 'value_C',
          domain: 'other.com',
          path: '/',
        },
      ];
      const mergedDb = await mergeCookiesToDb(initialDb, updateList, dummyAesKey);

      const result = await readCookieDb(mergedDb, dummyAesKey);
      expect(result).toHaveLength(3);

      const cookieA = result.find((c) => c.name === 'cookieA');
      expect(cookieA?.value).toBe('updated_value_A');
      expect(cookieA?.secure).toBe(true);

      // cookieB remains untouched!
      const cookieB = result.find((c) => c.name === 'cookieB');
      expect(cookieB?.value).toBe('initial_value_B');
      expect(cookieB?.path).toBe('/pathB');

      const cookieC = result.find((c) => c.name === 'cookieC');
      expect(cookieC?.value).toBe('value_C');
    });
  });

  describe('Cookies API route integration', () => {
    let app: express.Express;
    let server: http.Server;
    let baseUrl: string;
    let tempDir: string;
    const testProfileId = 'p_test_sqlite_profile';

    beforeEach(async () => {
      await initDb(':memory:');
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-test-'));

      // Ensure profile exists in app DB
      const db = getDb();
      try {
        db.prepare('DELETE FROM profiles WHERE id = ?').run(testProfileId);
      } catch {
        // The row may not exist on the first pass; the insert below is what the test needs.
      }
      db.prepare(`
        INSERT INTO profiles (id, name, created_at, updated_at, cookies_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(testProfileId, 'Test Sqlite Profile', Date.now(), Date.now(), '[]');

      app = express();
      app.use(express.json({ limit: '50mb' }));
      app.use(cookiesRouter);

      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as http.AddressInfo;
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      closeDb();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Teardown is best effort: a Windows file lock must not fail the test that ran.
      }
    });

    it('refuses import when the target profile is running', async () => {
      const isRunningSpy = vi.spyOn(launcher, 'isRunning').mockImplementation((id: string) => id === testProfileId);

      const resp = await fetch(`${baseUrl}/api/v1/browser-profile/cookies/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: testProfileId,
          format: 'sqlite',
          text: 'dummy_sqlite',
        }),
      });

      const body = (await resp.json()) as { code: number; msg: string };
      expect(body.code).toBe(-1);
      expect(body.msg).toContain('profile is currently running');

      isRunningSpy.mockRestore();
    });

    it('refuses export when the target profile is running for sqlite format', async () => {
      const isRunningSpy = vi.spyOn(launcher, 'isRunning').mockImplementation((id: string) => id === testProfileId);

      const resp = await fetch(`${baseUrl}/api/v1/browser-profile/cookies/export?user_id=${testProfileId}&format=sqlite`);

      const body = (await resp.json()) as { code: number; msg: string };
      expect(body.code).toBe(-1);
      expect(body.msg).toContain('profile is currently running');

      isRunningSpy.mockRestore();
    });

    it('imports SQLite cookies base64 and exports SQLite bytes', async () => {
      // Create a test sqlite file
      const cookies: CookieRow[] = [
        {
          name: 'auth_token',
          value: 'secret_token_123',
          domain: '.auth.domain',
          path: '/',
          secure: true,
          httpOnly: true,
        },
      ];
      const sqliteBytes = await mergeCookiesToDb(null, cookies, dummyAesKey);

      // Import via /api/v1/browser-profile/cookies/import
      const importResp = await fetch(`${baseUrl}/api/v1/browser-profile/cookies/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: testProfileId,
          format: 'sqlite',
          sqlite_base64: sqliteBytes.toString('base64'),

        }),
      });

      const importBody = (await importResp.json()) as { code: number; data: { count: number } };
      expect(importBody.code).toBe(0);
      expect(importBody.data.count).toBe(1);

      // Export via /api/v1/browser-profile/cookies/export?format=sqlite
      const exportResp = await fetch(`${baseUrl}/api/v1/browser-profile/cookies/export?user_id=${testProfileId}&format=sqlite`);

      expect(exportResp.status).toBe(200);
      expect(exportResp.headers.get('content-type')).toBe('application/x-sqlite3');
      const arrayBuf = await exportResp.arrayBuffer();
      const exportedBuf = Buffer.from(arrayBuf);
      expect(exportedBuf.length).toBeGreaterThan(0);

      // Verify readCookieDb on exported bytes
      const exportedCookies = await readCookieDb(exportedBuf, dummyAesKey);
      expect(exportedCookies).toHaveLength(1);
      expect(exportedCookies[0].name).toBe('auth_token');
      expect(exportedCookies[0].value).toBe('secret_token_123');
    });
  });
});
