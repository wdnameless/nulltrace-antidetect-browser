// Tests for the secret store: AES-256-GCM file-cipher fallback (used when
// Electron safeStorage is unavailable, e.g. standalone/server mode).
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { protectSecret, revealSecret, resetSecretCiphers } from '../../src/main/util/secretStore';
import { DATA_DIR } from '../../src/main/config';

beforeEach(() => {
  resetSecretCiphers(); // drop DPAPI + cached file cipher; key file is lazy
  try {
    fs.rmSync(path.join(DATA_DIR, 'secret.key'), { force: true });
  } catch {
    // ignore
  }
});

describe('secretStore AES fallback', () => {
  it('encrypts with aes: prefix and decrypts back', () => {
    const stored = protectSecret('proxy-password-123');
    expect(stored).toMatch(/^aes:/);
    expect(stored).not.toContain('proxy-password-123');
    expect(revealSecret(stored)).toBe('proxy-password-123');
  });

  it('creates a key file on first use and reuses it', () => {
    const keyFile = path.join(DATA_DIR, 'secret.key');
    expect(fs.existsSync(keyFile)).toBe(false);
    const a = protectSecret('s1');
    const b = protectSecret('s2');
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(revealSecret(a)).toBe('s1');
    expect(revealSecret(b)).toBe('s2');
  });

  it('returns undefined for unreadable values', () => {
    expect(revealSecret('aes:garbage')).toBeUndefined();
    expect(revealSecret(undefined)).toBeUndefined();
    expect(revealSecret('')).toBeUndefined();
  });

  it('still reads legacy plaintext markers', () => {
    expect(revealSecret('plain:old-pass')).toBe('old-pass');
    expect(revealSecret('no-prefix-value')).toBe('no-prefix-value');
  });

  describe('a corrupt key file never causes a cleartext write', () => {
    /*
     * Reproduced before the fix: with a zero-byte `secret.key` — an interrupted first write, or a
     * truncated file after an abrupt shutdown — `Buffer.from(hex,'hex')` produced an EMPTY key,
     * `createCipheriv` threw, the throw was swallowed, and `protectSecret` fell back to
     * `'plain:' + plain`. A proxy password was therefore persisted in cleartext and the call
     * reported success: nothing in the UI or the logs said a secret had been stored unprotected.
     *
     * `plain:` remains READABLE for values older builds wrote; it must never be WRITTEN again.
     */
    it('refuses to store a secret when the key file is unusable', () => {
      const keyFile = path.join(DATA_DIR, 'secret.key');
      fs.writeFileSync(keyFile, '');
      resetSecretCiphers();

      let stored: string | null = null;
      expect(() => {
        stored = protectSecret('must-not-be-plain');
      }).not.toThrow();

      expect(stored, 'a secret must not be stored in cleartext').toBeNull();
      // And the key file is left alone rather than silently regenerated, which would orphan every
      // secret already encrypted with the previous key.
      expect(fs.statSync(keyFile).size).toBe(0);
    });

    it('still reads a legacy plain: value', () => {
      // The read path is deliberately unchanged: older builds wrote these and they are on disk.
      expect(revealSecret('plain:old-pass')).toBe('old-pass');
    });
  });

});
