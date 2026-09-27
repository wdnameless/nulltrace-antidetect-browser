// Secret protection for proxy credentials stored in the DB (v0.2.20).
//
// Stored format (priority order):
//   "enc:<base64>" — DPAPI / platform keyring via Tauri shell's Rust command
//                    (src-tauri/src/secrets.rs), injected into the backend via setSecretCipher
//   "aes:<base64>" — AES-256-GCM with a machine-local key file
//                    (DATA_DIR/secret.key, generated once, mode 0600) — used
//                    when running standalone (`npm run service`) or in server
//                    mode, where the shell's cipher is unavailable
//   "plain:<text>" — LEGACY ONLY: still read, never written. A write with no usable cipher now
//                    refuses (returns null) instead of persisting a credential in cleartext
//
// Values without a prefix are legacy plaintext from older versions — read
// transparently, re-encrypted on the next write.
//
// The shell injects the cipher via setSecretCipher; the on-disk format and
// enc:/aes:/plain: prefix semantics remain unchanged.

import * as fs from 'fs';
import * as path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { DATA_DIR } from '../config';

export interface SecretCipher {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

let cipher: SecretCipher | null = null;
let fileCipher: SecretCipher | null = null;

export function setSecretCipher(c: SecretCipher): void {
  cipher = c;
}

export function hasSecretCipher(): boolean {
  return cipher !== null;
}

/** Reset both ciphers (used by tests; also forces key-file re-read). */
export function resetSecretCiphers(): void {
  cipher = null;
  fileCipher = null;
}

/** AES-256-GCM cipher backed by DATA_DIR/secret.key (created on first use). */
function getFileCipher(): SecretCipher | null {
  if (fileCipher) return fileCipher;
  try {
    const keyFile = path.join(DATA_DIR, 'secret.key');

    /*
     * The stored key is validated, not merely read.
     *
     * `Buffer.from(hex, 'hex')` never throws: a zero-byte file — an interrupted first write, or a
     * truncated file after an abrupt shutdown — yields an EMPTY buffer, and `createCipheriv` then
     * throws `ERR_CRYPTO_INVALID_KEYLEN`. That throw is swallowed by the catch at the bottom of this
     * function, so the whole secret store degrades to `null` and every subsequent proxy password and
     * vault credential is written in a form nothing can read back. The failure is silent: the values
     * still appear to save.
     *
     * A malformed key is therefore treated the same as a missing one ONLY when no secrets can have
     * been written yet (no file at all). When a file exists but is unusable, regenerating it would
     * orphan every secret already encrypted with the old key, so the failure is logged loudly and
     * the store refuses to operate rather than quietly re-keying the operator's data.
     */
    const readKey = (): Buffer | null => {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
      return Buffer.from(hex, 'hex');
    };

    let key: Buffer;
    if (fs.existsSync(keyFile)) {
      const existing = readKey();
      if (!existing) {
        const size = (() => {
          try {
            return fs.statSync(keyFile).size;
          } catch {
            return -1;
          }
        })();
        console.error(
          `[secretStore] ${keyFile} exists but is not a 32-byte hex key (${size} bytes). ` +
            'Refusing to re-key: every secret already encrypted with the previous key would become ' +
            'unreadable. Restore the file from a backup, or delete it deliberately to start with an ' +
            'empty secret store.',
        );
        return null;
      }
      key = existing;
    } else {
      const generated = randomBytes(32).toString('hex');
      // Write to a temp name and rename, so an interrupted write cannot leave a partial key file
      // behind — the exact state that caused the silent failure above.
      const tempFile = `${keyFile}.tmp`;
      fs.writeFileSync(tempFile, generated, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempFile, keyFile);
      key = Buffer.from(generated, 'hex');
    }

    fileCipher = {
      encrypt(plain: string): Buffer {
        const iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), enc]);
      },
      decrypt(data: Buffer): string {
        const iv = data.subarray(0, 12);
        const tag = data.subarray(12, 28);
        const enc = data.subarray(28);
        const d = createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
      },
    };
    return fileCipher;
  } catch {
    return null;
  }
}

/** Encrypt a secret for storage. Returns null for empty input. */
export function protectSecret(plain?: string | null): string | null {
  if (plain === undefined || plain === null || plain === '') return null;
  if (cipher) {
    try {
      return 'enc:' + cipher.encrypt(plain).toString('base64');
    } catch {
      // fall through to the file cipher
    }
  }
  const fc = getFileCipher();
  if (fc) {
    try {
      return 'aes:' + fc.encrypt(plain).toString('base64');
    } catch {
      // fall through to the refusal below
    }
  }
  /*
   * No usable cipher: REFUSE rather than fall back to `plain:`.
   *
   * The `plain:` prefix remains READABLE (see `revealSecret`) because older builds wrote it and the
   * values are already on disk. Writing it is a different matter: it stores a proxy password or a
   * vault credential in cleartext in a database the operator may sync, back up, or hand to support.
   * A probe against a corrupt key file demonstrated the old behaviour — `protectSecret` returned
   * `plain:hunter2` and reported success, so the operator's password was silently persisted in the
   * clear with no error anywhere.
   *
   * Returning null makes the write visibly fail. `getFileCipher` has already logged why, with the
   * remedy, so the operator sees a cause rather than a mystery empty field.
   */
  console.error('[secrets] refusing to store a secret in plaintext: no usable cipher is available');
  return null;
}

/** Decrypt a stored secret. Returns undefined when unreadable. */
export function revealSecret(stored?: string | null): string | undefined {
  if (stored === undefined || stored === null || stored === '') return undefined;
  if (stored.startsWith('enc:')) {
    if (!cipher) {
      console.error('[secrets] encrypted value found but no cipher available (run inside Electron)');
      return undefined;
    }
    try {
      return cipher.decrypt(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      console.error('[secrets] failed to decrypt a stored secret');
      return undefined;
    }
  }
  if (stored.startsWith('aes:')) {
    const fc = getFileCipher();
    if (!fc) {
      console.error('[secrets] aes value found but no key file available');
      return undefined;
    }
    try {
      return fc.decrypt(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      console.error('[secrets] failed to decrypt an aes secret');
      return undefined;
    }
  }
  // legacy plaintext or explicit "plain:" marker
  return stored.replace(/^plain:/, '');
}
