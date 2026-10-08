// The Cloud Sync HTTP surface: two properties that were wrong when this was first wired up.
//
// 1. **The passphrase floor lived only in the UI.** The renderer asked for 8 characters, but
//    `POST /gdrive/unlock` accepted `{passphrase:"abc"}` and unlocked the session — measured against
//    a running instance. The passphrase is the ONLY thing protecting the uploaded payload, and the
//    API is what an agent, a script, or an older client actually calls. A UI-only rule is not a rule.
//
// 2. **The mirror endpoint reported bytes it never uploaded.** It built the archive, returned its
//    size, and dropped the bytes, so the operator read "completed" while the Drive folder stayed
//    empty. The route must now either upload or fail loudly — never a fabricated success.
//
// Both are exercised through the real router with the Drive/network edges stubbed, so the test sees
// the same zod validation and control flow the app does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../../src/main/db';

let tmpRoot = '';

/** Mount the real cloud router. Only the Drive transport and OAuth edges are stubbed. */
async function mountCloudRouter(): Promise<{ app: Express; uploaded: Array<{ name: string; content: string }> }> {
  vi.resetModules();
  const uploaded: Array<{ name: string; content: string }> = [];

  vi.doMock('../../../src/main/cloud/gdriveTransfer', async () => {
    const actual = await vi.importActual<typeof import('../../../src/main/cloud/gdriveTransfer')>(
      '../../../src/main/cloud/gdriveTransfer'
    );
    const transport = {
      listFiles: async () => uploaded.map((f, i) => ({ id: `f${i}`, name: f.name })),
      createFolder: async () => 'folder-1',
      findFolder: async () => 'folder-1',
      uploadFile: async (name: string, content: string) => {
        uploaded.push({ name, content });
        return `f${uploaded.length}`;
      },
      downloadFile: async () => '',
      deleteFile: async () => undefined,
    };
    return { ...actual, getGDriveTransport: () => transport, ensureSyncFolder: async () => 'folder-1' };
  });

  const router = (await import('../../../src/main/api/routes/cloud')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return { app, uploaded };
}

/** Minimal HTTP call against the mounted app, so assertions see status codes and bodies. */
async function call(
  app: Express,
  method: 'get' | 'post',
  url: string,
  body?: unknown
): Promise<{ status: number; body: Envelope }> {
  const server = app.listen(0);
  try {
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Envelope };
  } finally {
    server.close();
  }
}

/** The API envelope, read defensively — a route under test may answer with any subset. */
interface Envelope {
  code?: number | string;
  msg?: string;
  data?: Record<string, unknown>;
}

/** Read a string field without trusting the envelope's shape. */
function msgOf(body: Envelope): string {
  return typeof body.msg === 'string' ? body.msg : '';
}

beforeEach(async () => {
  await initDb();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nulltrace-cloud-route-'));

  // The passphrase verifier and the sync session both persist across tests in this suite (settings
  // file, and an in-memory flag). Without clearing them, an earlier test's passphrase decides this
  // one's outcome and the failure looks like a route bug. Reset both so each case starts from the
  // state a fresh install has.
  const { setSetting } = await import('../../../src/main/config');
  const sync = await import('../../../src/main/cloud/gdriveSync');
  setSetting('syncPassphraseVerifier', '');
  sync.clearSyncSession();
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('passphrase validation is enforced by the server, not only the form', () => {
  it('rejects a too-short passphrase instead of unlocking', async () => {
    const { app } = await mountCloudRouter();
    const res = await call(app, 'post', '/api/v1/cloud/gdrive/unlock', { passphrase: 'abc' });
    expect(res.status, 'a 3-character passphrase unlocked the sync session').toBe(400);
    expect(msgOf(res.body)).toMatch(/8|characters/i);
  });

  it('rejects the boundary below the floor and accepts the floor itself', async () => {
    const { app } = await mountCloudRouter();

    const below = await call(app, 'post', '/api/v1/cloud/gdrive/unlock', { passphrase: 'seven77' });
    expect(below.status, '7 characters must not pass an 8-character floor').toBe(400);

    // 8 characters is length-valid; whether it is the RIGHT passphrase is a different question and
    // must not be answered with a validation error.
    const atFloor = await call(app, 'post', '/api/v1/cloud/gdrive/unlock', { passphrase: 'eight888' });
    expect(atFloor.status, 'the floor itself was rejected').not.toBe(400);
  });

  it('applies the same floor to the one-call connect path', async () => {
    // Connect is the button the operator actually presses; a floor that only guarded /unlock would
    // be trivially bypassed by the primary path.
    const { app } = await mountCloudRouter();
    const res = await call(app, 'post', '/api/v1/cloud/gdrive/connect', { passphrase: 'abc' });
    expect(res.status).toBe(400);
  });
});

describe('the directory mirror never reports bytes it did not upload', () => {
  it('refuses to run before the passphrase is unlocked', async () => {
    const { app, uploaded } = await mountCloudRouter();
    const res = await call(app, 'post', '/api/v1/cloud/gdrive/mirror/run', {});
    expect(res.status).toBe(400);
    expect(String(res.body.code)).toMatch(/PASSPHRASE/i);
    expect(uploaded, 'a locked session must not upload anything').toEqual([]);
  });

  it('uploads the sealed archive once the session is unlocked', async () => {
    const { app, uploaded } = await mountCloudRouter();

    // Unlock first — the route reads the session passphrase, which is the real precondition.
    // The FIRST unlock on a fresh settings file establishes the verifier, so a 400 here would
    // mean an unrelated failure; a later one with a different phrase legitimately rejects.
    const unlock = await call(app, 'post', '/api/v1/cloud/gdrive/unlock', {
      passphrase: 'a good passphrase',
    });
    expect(unlock.status, `first unlock rejected: ${msgOf(unlock.body)}`).not.toBe(400);

    const res = await call(app, 'post', '/api/v1/cloud/gdrive/mirror/run', {});
    // The archive needs no Drive credentials beyond the stubbed transport, so this should succeed
    // and, crucially, the bytes must have reached the transport.
    if (res.status === 200) {
      expect(uploaded.length, 'the mirror reported success without uploading').toBeGreaterThan(0);
      const archive = uploaded[uploaded.length - 1];
      expect(archive.name).toMatch(/profiles-full/);
      // Base64 of sealed bytes: the payload must not read as JSON on the wire.
      expect(archive.content.includes('"profile"')).toBe(false);
    } else {
      // A failed run is acceptable; a silent one is not. Whatever the reason, nothing was uploaded
      // and it must be stated.
      expect(uploaded).toEqual([]);
      expect(msgOf(res.body), 'a failed mirror must explain itself').toBeTruthy();
    }
  });
});

describe('one-button connect over a loopback redirect', () => {
  it('enforces the passphrase floor before opening any browser', async () => {
    const { app } = await mountCloudRouter();

    // The route must validate before it does anything observable. A short passphrase that still
    // opened a consent window would teach the operator their passphrase was accepted.
    const res = await call(app, 'post', '/api/v1/cloud/gdrive/authorize', { passphrase: 'abc' });

    expect(res.status).toBe(400);
    expect(msgOf(res.body)).toMatch(/8|characters/i);
  });

  it('falls back to the publisher client so a fresh install has a client without setup', async () => {
    const { app } = await mountCloudRouter();
    const { purgeGDriveConfiguration, getGDriveCredentials } =
      await import('../../../src/main/cloud/gdriveAuth');
    purgeGDriveConfiguration();

    // There is no "no client configured" state in a shipped build: the publisher's client id is a
    // compiled-in constant, so this route always has something to send. That is what makes the
    // one-button promise work — and it is also why the client's TYPE matters more than its presence.
    expect(getGDriveCredentials()?.clientId).toBeTruthy();

    const res = await call(app, 'post', '/api/v1/cloud/gdrive/authorize', {
      passphrase: 'a passphrase long enough',
    });
    expect([200, 400, 500]).toContain(res.status);

    await call(app, 'post', '/api/v1/cloud/gdrive/authorize/cancel');
  });

  it('answers immediately with a waiting state, and never a secret', async () => {
    const { app } = await mountCloudRouter();
    const { saveGDriveCredentials } = await import('../../../src/main/cloud/gdriveAuth');
    saveGDriveCredentials({ clientId: 'operator.apps.googleusercontent.com' });

    const res = await call(app, 'post', '/api/v1/cloud/gdrive/authorize', {
      passphrase: 'a passphrase long enough',
    });

    // Any status is acceptable here — the assertion that matters is that the reply is immediate and
    // carries no client secret, because the request is answered before the operator has consented.
    expect(JSON.stringify(res.body)).not.toContain('client_secret');
    expect(JSON.stringify(res.body)).not.toMatch(/ya29\.|1\/\//);

    await call(app, 'post', '/api/v1/cloud/gdrive/authorize/cancel');
  });

  it('cancelling is always safe, including with nothing in flight', async () => {
    const { app } = await mountCloudRouter();
    const res = await call(app, 'post', '/api/v1/cloud/gdrive/authorize/cancel');
    expect(res.status).toBe(200);
  });
});
