import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * The vault half of cloud sync must survive a change of machine.
 *
 * Reported defect: `pushToGDrive` uploaded `account_credentials.password_enc` VERBATIM, with a
 * comment telling future readers not to call `revealSecret` for transport. Those values are bound to
 * the machine that wrote them — the shipped build never calls `setSecretCipher`, so every credential
 * is `aes:` under `DATA_DIR/secret.key` — so a synced vault arrived on the peer machine looking
 * correct in the UI while `revealSecret` returned `undefined` for every entry. The failure is
 * invisible on the machine that pushed, which is what makes it worth a test.
 *
 * `DATA_DIR` is resolved once at module import, so the test cannot repoint the real secret store
 * between "machines" in one process. It therefore models the storage boundary directly, using the
 * same cipher and envelope layout the store uses (`iv(12) || tag(16) || ciphertext`, AES-256-GCM
 * under a per-machine key file). What is being pinned is the property, not the transport plumbing:
 * a payload that carries the peer's CIPHERTEXT cannot be opened, and one that carries the secret
 * itself, re-protected on arrival, can.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The store's own layout, reproduced so the test can hold two machine keys at once. */
function protectWith(key: Buffer, plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `aes:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

function revealWith(key: Buffer, stored: string): string | undefined {
  if (!stored.startsWith('aes:')) return undefined;
  try {
    const raw = Buffer.from(stored.slice(4), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

describe('synced vault credentials survive a different machine', () => {
  let keyA: Buffer;
  let keyB: Buffer;

  beforeEach(() => {
    // Two machines, two genuinely different key files.
    keyA = randomBytes(KEY_BYTES);
    keyB = randomBytes(KEY_BYTES);
  });

  afterEach(() => {
    keyA.fill(0);
    keyB.fill(0);
  });

  it('cannot open a peer ciphertext, which is why verbatim transport was the defect', () => {
    // Machine A protects a credential under its own key, as `protectSecret` does.
    const ciphertextFromA = protectWith(keyA, 'hunter2');
    expect(ciphertextFromA).toMatch(/^aes:/);
    expect(revealWith(keyA, ciphertextFromA), 'readable on the machine that wrote it').toBe('hunter2');

    // The OLD push shipped that string as-is. The peer cannot open it — and the vault UI still
    // listed the credential, so nothing looked wrong on either machine.
    expect(
      revealWith(keyB, ciphertextFromA),
      'verbatim transport leaves the peer with an unusable credential',
    ).toBeUndefined();
  });

  it('reads back a credential re-protected on arrival', () => {
    // The NEW shape: the payload carries the secret inside a passphrase-sealed file, and each
    // machine protects it under its own key when it lands.
    const ciphertextFromA = protectWith(keyA, 'hunter2');
    const portable = revealWith(keyA, ciphertextFromA);
    expect(portable, 'the push must be able to reveal it to carry it').toBe('hunter2');

    const reProtectedOnB = protectWith(keyB, portable as string);
    expect(reProtectedOnB).toMatch(/^aes:/);
    expect(reProtectedOnB).not.toBe(ciphertextFromA);
    expect(revealWith(keyB, reProtectedOnB), 'usable on the peer machine').toBe('hunter2');
  });

  it('a value protected on one machine is not silently readable on the other', () => {
    // Guards the premise: if the two keys happened to produce interchangeable ciphertext, the
    // tests above would pass without proving anything.
    const fromA = protectWith(keyA, 'secret-value');
    expect(revealWith(keyB, fromA)).toBeUndefined();
  });
});
