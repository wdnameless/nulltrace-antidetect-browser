import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateLicenseKey,
  activateLicense,
  deactivateLicense,
  getLicenseState,
  isPro,
  hasFeature,
  signLicensePayload,
  getPinnedKeyFingerprint,
} from '../../src/main/licensing/licenseManager';
import { LICENSE_PUBLIC_KEY_PEM } from '../../src/main/licensing/publicKey';

// Old leaked public key SPKI base64 literal (from commit before rotation)
const OLD_LEAKED_PUB_B64 = 'MCowBQYDK2VwAyEAVxFPPO9Q0RRZZUYacTrT5OnBwit7GcyTpYR/ijc+tsA=';
const OLD_LEAKED_PUB_PEM = `-----BEGIN PUBLIC KEY-----\n${OLD_LEAKED_PUB_B64}\n-----END PUBLIC KEY-----\n`;

describe('licenseManager: Ed25519 offline validation', () => {
  let runtimeKeyPair: { publicKey: string; privateKey: string };
  let originalEnvPackaged: string | undefined;
  let originalSettingsDir: string | undefined;
  let testSettingsDir: string;

  beforeEach(() => {
    // Generate fresh ephemeral keypair per test
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    runtimeKeyPair = {
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };

    originalEnvPackaged = process.env.ANTIDETECT_PACKAGED;
    originalSettingsDir = process.env.ANTIDETECT_SETTINGS_DIR;
    testSettingsDir = path.join(os.tmpdir(), `test-settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(testSettingsDir, { recursive: true });
    process.env.ANTIDETECT_SETTINGS_DIR = testSettingsDir;
    delete process.env.ANTIDETECT_PACKAGED;
    process.env.ENABLE_LICENSING = '1';
  });

  afterEach(() => {
    deactivateLicense();
    if (originalEnvPackaged !== undefined) {
      process.env.ANTIDETECT_PACKAGED = originalEnvPackaged;
    } else {
      delete process.env.ANTIDETECT_PACKAGED;
    }
    if (originalSettingsDir !== undefined) {
      process.env.ANTIDETECT_SETTINGS_DIR = originalSettingsDir;
    } else {
      delete process.env.ANTIDETECT_SETTINGS_DIR;
    }
    delete process.env.ENABLE_LICENSING;
    if (fs.existsSync(testSettingsDir)) {
      try {
        fs.rmSync(testSettingsDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });
  it('when ENABLE_LICENSING is not set, all features are unlocked for everyone by default', () => {
    delete process.env.ENABLE_LICENSING;
    expect(getLicenseState().plan).toBe('pro');
    expect(isPro()).toBe(true);
    expect(hasFeature('teams')).toBe(true);
    expect(hasFeature('sync')).toBe(true);
  });


  it('accepts a validly-signed Pro key with runtime public key', () => {
    const key = signLicensePayload({ plan: 'pro', email: 'dev@example.com' }, runtimeKeyPair.privateKey);
    const res = validateLicenseKey(key, runtimeKeyPair.publicKey);
    expect(res.ok).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const key = signLicensePayload({ plan: 'pro', email: 'a@example.com' }, runtimeKeyPair.privateKey);
    const dot = key.lastIndexOf('.');
    const payloadPart = key.slice(0, dot);
    const sigPart = key.slice(dot + 1);
    const norm = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(Buffer.from(norm, 'base64').toString('utf8')) as { email?: string };
    obj.email = 'evil@example.com';
    const tamperedPayload = Buffer.from(JSON.stringify(obj), 'utf8');
    const tamperedB64 = tamperedPayload.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = validateLicenseKey(`${tamperedB64}.${sigPart}`, runtimeKeyPair.publicKey);
    expect(res.ok).toBe(false);
  });

  it('rejects a signature from a foreign key', () => {
    const foreign = generateKeyPairSync('ed25519');
    const foreignPriv = foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const key = signLicensePayload({ plan: 'pro' }, foreignPriv);
    const res = validateLicenseKey(key, runtimeKeyPair.publicKey);
    expect(res.ok).toBe(false);
  });

  it('regression: license signed with old leaked key is rejected by pinned key', () => {
    const foreign = generateKeyPairSync('ed25519');
    const foreignPriv = foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const key = signLicensePayload({ plan: 'pro', email: 'leaked@example.com' }, foreignPriv);

    // If validated against OLD_LEAKED_PUB_PEM with non-matching sig, fails
    expect(validateLicenseKey(key, OLD_LEAKED_PUB_PEM).ok).toBe(false);

    // Validated against the pinned key without providing old key fails
    expect(validateLicenseKey(key).ok).toBe(false);

    // Old leaked key fingerprint differs from current pinned key fingerprint
    const oldFp = createHash('sha256').update(OLD_LEAKED_PUB_PEM, 'utf8').digest('hex').slice(0, 16);
    expect(getPinnedKeyFingerprint()).not.toBe(oldFp);
    expect(getPinnedKeyFingerprint()).toBe('43036aa6496ca675');
  });

  it('drift check: the pinned constant carries the same key as resources/license-public-key.pem', () => {
    // Compared by KEY MATERIAL, not by file bytes. Byte equality was the original assertion, and
    // it is exactly what hid the defect: with `core.autocrlf=true` the file on disk is CRLF while
    // the constant generated from it was LF, so the two sides hashed different bytes and every
    // valid licence was refused. The base64 body is what must match, line endings are noise.
    const stripPemArmour = (pem: string) =>
      pem
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('-----'))
        .map((line) => line.trim())
        .join('');

    const resourcePem = fs.readFileSync(path.resolve(__dirname, '../../resources/license-public-key.pem'), 'utf8');
    expect(stripPemArmour(LICENSE_PUBLIC_KEY_PEM)).toBe(stripPemArmour(resourcePem));
    expect(stripPemArmour(LICENSE_PUBLIC_KEY_PEM).length).toBeGreaterThan(0);

    // A fingerprint that changes with the checkout's line endings would break every packaged
    // build on a Windows machine, so assert the exact value both languages must agree on.
    expect(getPinnedKeyFingerprint()).toBe('43036aa6496ca675');
  });

  it('rejects malformed keys', () => {
    expect(validateLicenseKey('').ok).toBe(false);
    expect(validateLicenseKey('nodot').ok).toBe(false);
    expect(validateLicenseKey('aaa.bbb').ok).toBe(false);
    expect(validateLicenseKey('only.').ok).toBe(false);
  });

  it('rejects a non-pro plan payload', () => {
    const key = signLicensePayload({ plan: 'free' as unknown as 'pro' }, runtimeKeyPair.privateKey);
    expect(validateLicenseKey(key, runtimeKeyPair.publicKey).ok).toBe(false);
  });

  it('rejects an expired key with LICENSE_EXPIRED', () => {
    const key = signLicensePayload({ plan: 'pro', exp: Math.floor(Date.now() / 1000) - 3600 }, runtimeKeyPair.privateKey);
    const res = validateLicenseKey(key, runtimeKeyPair.publicKey);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('LICENSE_EXPIRED');
  });

  it('activate/getLicenseState roundtrip through the settings store in non-packaged dev mode', () => {
    expect(activateLicense('garbage.key').ok).toBe(false);
    expect(getLicenseState().plan).toBe('free');

    deactivateLicense();
    expect(getLicenseState().plan).toBe('free');
    expect(isPro()).toBe(false);
    expect(hasFeature('teams')).toBe(false);
    expect(hasFeature('sync')).toBe(false);
  });

  describe('packaged build cross-check (ANTIDETECT_PACKAGED=1)', () => {
    it('missing verdict file forbids Pro, returns Free without throwing', () => {
      process.env.ANTIDETECT_PACKAGED = '1';
      const state = getLicenseState();
      expect(state.plan).toBe('free');
      expect(isPro()).toBe(false);
    });

    it('corrupted verdict file forbids Pro, returns Free without throwing', () => {
      process.env.ANTIDETECT_PACKAGED = '1';
      fs.writeFileSync(path.join(testSettingsDir, 'license-verdict.json'), 'not-valid-json{');
      const state = getLicenseState();
      expect(state.plan).toBe('free');
      expect(isPro()).toBe(false);
    });

    it('verdict file with schema != 1 or valid != true forbids Pro', () => {
      process.env.ANTIDETECT_PACKAGED = '1';
      const verdictPath = path.join(testSettingsDir, 'license-verdict.json');
      fs.writeFileSync(verdictPath, JSON.stringify({ schema: 2, valid: true, key_fp: getPinnedKeyFingerprint(), token_fp: '1234567812345678' }));
      expect(getLicenseState().plan).toBe('free');

      fs.writeFileSync(verdictPath, JSON.stringify({ schema: 1, valid: false, key_fp: getPinnedKeyFingerprint(), token_fp: '1234567812345678' }));
      expect(getLicenseState().plan).toBe('free');
    });

    it('verdict file with foreign key_fp forbids Pro', () => {
      process.env.ANTIDETECT_PACKAGED = '1';
      const verdictPath = path.join(testSettingsDir, 'license-verdict.json');
      fs.writeFileSync(verdictPath, JSON.stringify({ schema: 1, valid: true, key_fp: '0000000000000000', token_fp: '1234567812345678' }));
      expect(getLicenseState().plan).toBe('free');
    });

    it('verdict file issued for a DIFFERENT token forbids Pro', () => {
      // The token fingerprint is the clause that stops a verdict issued for licence A from
      // authorising licence B. Without this test, every other case here still passes if the
      // token_fp comparison is deleted — they all fail earlier, on a missing file.
      process.env.ANTIDETECT_PACKAGED = '1';
      const verdictPath = path.join(testSettingsDir, 'license-verdict.json');
      fs.writeFileSync(verdictPath, JSON.stringify({ schema: 1, valid: true, key_fp: getPinnedKeyFingerprint(), token_fp: 'deadbeefdeadbeef' }));
      expect(getLicenseState().plan).toBe('free');
    });

    it('a matching verdict file grants Pro — the success path is reachable', (ctx) => {
      // Every check above is deny-only, so all of them stay green if the Pro branch is deleted
      // outright — they fail earlier, on a missing or invalid file. This is the one test that
      // fails when the gate stops granting.
      //
      // It needs the vendor private key, which is deliberately absent from the repository, so it
      // is SKIPPED rather than silently passing wherever that key is unavailable (CI, any other
      // clone). Point NULLTRACE_LICENSE_PRIVATE_KEY_FILE at the key to run it:
      //   NULLTRACE_LICENSE_PRIVATE_KEY_FILE=D:/nulltrace-keys/license-private.pem npx vitest run tests/unit/licenseManager.test.ts
      const keyFile = process.env.NULLTRACE_LICENSE_PRIVATE_KEY_FILE;
      if (!keyFile || !fs.existsSync(keyFile)) {
        ctx.skip();
        return;
      }

      process.env.ANTIDETECT_PACKAGED = '1';
      const key = signLicensePayload({ plan: 'pro', email: 'pro@example.com' }, fs.readFileSync(keyFile, 'utf8'));
      expect(activateLicense(key).ok).toBe(true);

      const verdictPath = path.join(testSettingsDir, 'license-verdict.json');
      fs.writeFileSync(
        verdictPath,
        JSON.stringify({
          schema: 1,
          valid: true,
          key_fp: getPinnedKeyFingerprint(),
          token_fp: createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16),
        })
      );

      const state = getLicenseState();
      expect(state.plan).toBe('pro');
      expect(state.email).toBe('pro@example.com');
      expect(hasFeature('teams')).toBe(true);
    });
  });

  it('pinned public key is a valid PEM matching fingerprint 43036aa6496ca675', () => {
    expect(LICENSE_PUBLIC_KEY_PEM).toContain('BEGIN PUBLIC KEY');
    expect(getPinnedKeyFingerprint()).toBe('43036aa6496ca675');
  });

  it('scripts/make-license.mjs CLI with --key, --plan pro, --days generates valid token', async () => {
    const { execFileSync } = await import('node:child_process');
    const tmpKeyPath = path.join(testSettingsDir, 'temp-key.pem');
    fs.writeFileSync(tmpKeyPath, runtimeKeyPair.privateKey);

    const stdout = execFileSync(
      process.execPath,
      ['scripts/make-license.mjs', '--key', tmpKeyPath, '--plan', 'pro', '--days', '30', '--email', 'buyer@example.com'],
      { encoding: 'utf8', cwd: path.resolve(__dirname, '../..') }
    ).trim();

    const verified = validateLicenseKey(stdout, runtimeKeyPair.publicKey);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.plan).toBe('pro');
      expect(verified.payload.email).toBe('buyer@example.com');
      expect(typeof verified.payload.exp).toBe('number');
    }
  });
});
