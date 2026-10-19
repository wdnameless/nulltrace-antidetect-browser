import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isRunning } from '../launcher/chromium';
import { PROFILES_DIR } from '../config';

export interface CookieRow {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // epoch seconds or ms
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | 'no_restriction' | 'unspecified';
}

let sqlJsModule: SqlJsStatic | null = null;

export async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsModule) {
    sqlJsModule = await initSqlJs();
  }
  return sqlJsModule;
}

// Seam for DPAPI unprotect to allow tests to mock without invoking Windows DPAPI
export type DpapiUnprotectFn = (encryptedKey: Buffer) => Buffer;

function defaultDpapiUnprotect(encryptedKey: Buffer): Buffer {
  if (process.platform !== 'win32') {
    return encryptedKey;
  }
  try {
    const base64In = encryptedKey.toString('base64');
    const script = `Add-Type -AssemblyName System.Security; [System.Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([System.Convert]::FromBase64String('${base64In}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const out = child_process.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return Buffer.from(out, 'base64');
  } catch (err) {
    throw new Error(`DPAPI unprotect failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let dpapiUnprotect: DpapiUnprotectFn = defaultDpapiUnprotect;

export function setDpapiUnprotectSeam(fn: DpapiUnprotectFn): void {
  dpapiUnprotect = fn;
}

export function resetDpapiUnprotectSeam(): void {
  dpapiUnprotect = defaultDpapiUnprotect;
}

/**
 * Unwrap OS Crypt key from a Chromium 'Local State' JSON content.
 * Local State has: os_crypt.encrypted_key (Base64 encoded string starting with 'DPAPI').
 */
export function unwrapOsKeyFromLocalState(localStateJson: string): Buffer {
  let state: Record<string, Record<string, string>> | null = null;
  try {
    state = JSON.parse(localStateJson);
  } catch (err) {
    throw new Error(`Failed to parse Local State JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const encKeyB64 = state?.os_crypt?.encrypted_key;
  if (!encKeyB64) {
    throw new Error('Local State missing os_crypt.encrypted_key');
  }
  const rawKeyWithPrefix = Buffer.from(encKeyB64, 'base64');
  // In Windows Chromium, 'DPAPI' (5 bytes: 0x44, 0x50, 0x41, 0x50, 0x49) prefixes the DPAPI-encrypted blob
  if (rawKeyWithPrefix.subarray(0, 5).toString('latin1') === 'DPAPI') {
    const dpapiBlob = rawKeyWithPrefix.subarray(5);
    return dpapiUnprotect(dpapiBlob);
  }
  // If not DPAPI-prefixed or non-Windows, return as unwrapped or pass through
  return dpapiUnprotect(rawKeyWithPrefix);
}

/**
 * Encrypt a plaintext cookie value using AES-256-GCM under Chromium v10 format:
 * 'v10' (3 bytes) + 12-byte nonce + ciphertext + 16-byte authTag
 */
export function encryptCookieValueV10(value: string, key: Buffer, nonce?: Buffer): Buffer {
  const iv = nonce || crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('v10', 'utf8'), iv, ciphertext, tag]);
}

/**
 * Decrypt a Chromium cookie value.
 * Supports:
 * - v10 prefix (AES-256-GCM): 'v10' + 12-byte nonce + ciphertext + 16-byte tag
 * - raw plaintext fallback if value is unencrypted or starts with non-v10
 */
export function decryptCookieValue(encryptedValue: Buffer, key?: Buffer): string {
  if (!encryptedValue || encryptedValue.length === 0) {
    return '';
  }

  // Check for 'v10' or 'v11' prefix (Chromium AES-256-GCM)
  const prefix = encryptedValue.subarray(0, 3).toString('utf8');
  if (prefix === 'v10' || prefix === 'v11') {
    if (!key) {
      // Cannot decrypt without key; return empty or fallback
      return '';
    }
    if (encryptedValue.length < 3 + 12 + 16) {
      throw new Error('Invalid v10 cookie ciphertext length');
    }
    const nonce = encryptedValue.subarray(3, 15);
    const tag = encryptedValue.subarray(encryptedValue.length - 16);
    const ciphertext = encryptedValue.subarray(15, encryptedValue.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  // Plaintext (non-v10) value passes through unchanged
  return encryptedValue.toString('utf8');
}

/**
 * Chromium SQLite epoch is microseconds since 1601-01-01 00:00:00 UTC.
 * Unix epoch is 1970-01-01 00:00:00 UTC.
 * Difference is 11644473600 seconds = 11644473600000000 microseconds.
 */
const WINDOWS_EPOCH_DIFF_USEC = 11644473600000000n;

export function chromeTimeToUnixSeconds(chromeTime: bigint | number): number {
  const cTime = BigInt(chromeTime);
  if (cTime <= 0n) return 0;
  const usec = cTime - WINDOWS_EPOCH_DIFF_USEC;
  if (usec <= 0n) return 0;
  return Number(usec / 1000000n);
}

export function unixSecondsToChromeTime(unixSeconds: number): bigint {
  if (!unixSeconds || unixSeconds <= 0) return 0n;
  return BigInt(Math.floor(unixSeconds)) * 1000000n + WINDOWS_EPOCH_DIFF_USEC;
}

export function mapSameSite(s: number): 'Strict' | 'Lax' | 'None' | 'unspecified' {
  // Chromium samesite enum: -1: unspecified, 0: no_restriction (None), 1: Lax, 2: Strict
  if (s === 2) return 'Strict';
  if (s === 1) return 'Lax';
  if (s === 0) return 'None';
  return 'unspecified';
}

export function mapSameSiteToChromium(s?: string): number {
  if (!s) return -1;
  const lower = s.toLowerCase();
  if (lower === 'strict') return 2;
  if (lower === 'lax') return 1;
  if (lower === 'none' || lower === 'no_restriction') return 0;
  return -1;
}

/**
 * Reads a Chromium Cookies SQLite database buffer and normalises to CookieRow[]
 */
export async function readCookieDb(bytes: Buffer, osKey?: Buffer): Promise<CookieRow[]> {
  const SQL = await getSqlJs();
  const db: SqlJsDatabase = new SQL.Database(bytes);

  try {
    // Check if table exists
    const checkStmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'");
    const exists = checkStmt.step();
    checkStmt.free();
    if (!exists) {
      return [];
    }

    const stmt = db.prepare('SELECT name, value, encrypted_value, host_key, path, expires_utc, is_httponly, is_secure, samesite FROM cookies');
    const results: CookieRow[] = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        name: string;
        value: string;
        encrypted_value: Uint8Array | null;
        host_key: string;
        path: string;
        expires_utc: number;
        is_httponly: number;
        is_secure: number;
        samesite: number;
      };

      let val = row.value || '';
      if (row.encrypted_value && row.encrypted_value.length > 0) {
        try {
          const dec = decryptCookieValue(Buffer.from(row.encrypted_value), osKey);
          if (dec) val = dec;
        } catch {
          // If decryption fails, keep unencrypted val if available
        }
      }

      // Never emit an empty string for an encrypted cookie whose decryption failed:
      // doing so poisons cookies_json and overwrites real sessions on launch.
      if (!val && row.encrypted_value && row.encrypted_value.length > 0) {
        continue;
      }
      const expires = chromeTimeToUnixSeconds(row.expires_utc);

      results.push({
        name: row.name,
        value: val,
        domain: row.host_key,
        path: row.path,
        expires: expires > 0 ? expires : undefined,
        httpOnly: Boolean(row.is_httponly),
        secure: Boolean(row.is_secure),
        sameSite: mapSameSite(row.samesite),
      });
    }

    stmt.free();
    return results;
  } finally {
    db.close();
  }
}

/**
 * Creates or updates an existing Chromium Cookies SQLite DB with the given cookies using INSERT OR REPLACE.
 * Preserves untouched rows.
 */
export async function mergeCookiesToDb(existingDbBytes: Buffer | null, cookiesToMerge: CookieRow[], osKey?: Buffer): Promise<Buffer> {
  const SQL = await getSqlJs();
  const db: SqlJsDatabase = existingDbBytes && existingDbBytes.length > 0 ? new SQL.Database(existingDbBytes) : new SQL.Database();

  try {
    // Ensure cookies table schema matching Chromium standard
    db.run(`
      CREATE TABLE IF NOT EXISTS cookies (
        creation_utc INTEGER NOT NULL DEFAULT 0,
        host_key TEXT NOT NULL,
        top_frame_site_key TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        encrypted_value BLOB NOT NULL DEFAULT (X''),
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL DEFAULT 0,
        is_secure INTEGER NOT NULL DEFAULT 0,
        is_httponly INTEGER NOT NULL DEFAULT 0,
        last_access_utc INTEGER NOT NULL DEFAULT 0,
        has_expires INTEGER NOT NULL DEFAULT 1,
        is_persistent INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 1,
        samesite INTEGER NOT NULL DEFAULT -1,
        source_scheme INTEGER NOT NULL DEFAULT 0,
        source_port INTEGER NOT NULL DEFAULT -1,
        last_update_utc INTEGER NOT NULL DEFAULT 0,
        source_type INTEGER NOT NULL DEFAULT 0,
        has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (name, host_key, path)
      );
    `);

    // Prepare insert or replace
    const nowChrome = unixSecondsToChromeTime(Math.floor(Date.now() / 1000));

    for (const c of cookiesToMerge) {
      const expChrome = c.expires ? unixSecondsToChromeTime(c.expires) : 0n;
      const samesite = mapSameSiteToChromium(c.sameSite);
      let val = c.value || '';
      let encVal: Buffer = Buffer.alloc(0);

      if (osKey) {
        encVal = encryptCookieValueV10(val, osKey);
      }

      // Check existing row to preserve creation_utc or untouched fields if any
      const existingStmt = db.prepare('SELECT creation_utc, top_frame_site_key, priority, source_scheme, source_port, source_type, has_cross_site_ancestor FROM cookies WHERE name = ? AND host_key = ? AND path = ?');
      existingStmt.bind([c.name, c.domain, c.path]);
      let creation = nowChrome;
      let topFrameSiteKey = '';
      let priority = 1;
      let sourceScheme = c.secure ? 2 : 1;
      let sourcePort = c.secure ? 443 : 80;
      let sourceType = 0;
      let hasCrossSiteAncestor = 0;

      if (existingStmt.step()) {
        const obj = existingStmt.getAsObject() as {
          creation_utc: number;
          top_frame_site_key: string;
          priority: number;
          source_scheme: number;
          source_port: number;
          source_type: number;
          has_cross_site_ancestor: number;
        };
        if (obj.creation_utc) creation = BigInt(obj.creation_utc);
        if (obj.top_frame_site_key !== undefined) topFrameSiteKey = obj.top_frame_site_key;
        if (obj.priority !== undefined) priority = obj.priority;
        if (obj.source_scheme !== undefined) sourceScheme = obj.source_scheme;
        if (obj.source_port !== undefined) sourcePort = obj.source_port;
        if (obj.source_type !== undefined) sourceType = obj.source_type;
        if (obj.has_cross_site_ancestor !== undefined) hasCrossSiteAncestor = obj.has_cross_site_ancestor;
      }
      existingStmt.free();

      // INSERT OR REPLACE
      db.run(
        `INSERT OR REPLACE INTO cookies (
          creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
          path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires,
          is_persistent, priority, samesite, source_scheme, source_port, last_update_utc,
          source_type, has_cross_site_ancestor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(creation),
          c.domain,
          topFrameSiteKey,
          c.name,
          val,
          encVal.length > 0 ? new Uint8Array(encVal) : new Uint8Array(0),
          c.path,
          Number(expChrome),
          c.secure ? 1 : 0,
          c.httpOnly ? 1 : 0,
          Number(nowChrome),
          c.expires ? 1 : 0,
          c.expires ? 1 : 0,
          priority,
          samesite,
          sourceScheme,
          sourcePort,
          Number(nowChrome),
          sourceType,
          hasCrossSiteAncestor,
        ]
      );
    }

    const exportedBytes = db.export();
    return Buffer.from(exportedBytes);
  } finally {
    db.close();
  }
}

/**
 * Locate the Cookies SQLite database file in a profile's userDataDir.
 * In modern Chromium, it is usually at <userDataDir>/Default/Network/Cookies
 * or <userDataDir>/Default/Cookies
 */
export function getProfileCookiesPath(profileDir: string): string {
  const networkCookies = path.join(profileDir, 'Default', 'Network', 'Cookies');
  if (fs.existsSync(networkCookies)) {
    return networkCookies;
  }
  const defaultCookies = path.join(profileDir, 'Default', 'Cookies');
  if (fs.existsSync(defaultCookies)) {
    return defaultCookies;
  }
  // Default to networkCookies for new creation
  return networkCookies;
}

/**
 * Locate and unwrap the OS Crypt key for a profile if Local State exists.
 */
export function getProfileOsKey(profileDir: string): Buffer | undefined {
  try {
    const localStatePath = path.join(profileDir, 'Local State');
    if (fs.existsSync(localStatePath)) {
      const content = fs.readFileSync(localStatePath, 'utf8');
      return unwrapOsKeyFromLocalState(content);
    }
  } catch {
    // If not found or fails, return undefined
  }
  return undefined;
}

/**
 * Resolves profile directory on disk given profileId and userDataDir
 */
export function resolveProfileDir(profileId: string, userDataDir?: string): string {
  if (userDataDir) {
    return userDataDir;
  }
  return path.join(PROFILES_DIR, profileId);
}

/**
 * Refuse write if profile is running
 */
export function assertProfileNotRunning(profileId: string): void {
  if (isRunning(profileId)) {
    throw new Error(`Profile ${profileId} is currently running. Close it before modifying cookies.`);
  }
}
