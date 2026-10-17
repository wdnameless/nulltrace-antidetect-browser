import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import * as net from 'net';
import { initDb, closeDb, getDb } from '../../src/main/db';
import { migrate } from '../../src/main/db/schema';
import emailRoutes from '../../src/main/api/routes/email';
import {
  createAccount,
  ensureEmailTables,
  setSecretCipher,
  resetSecretCiphers,
  setSocketFactory,
  type SocketFactory,
} from '../../src/main/email/manager';
import {
  setMailTransportFactory,
  type MailTransportFactory,
} from '../../src/main/email/smtp';

const TEST_CIPHER = {
  encrypt: (plain: string) => Buffer.from(`test-enc:${plain}`, 'utf8'),
  decrypt: (data: Buffer) => data.toString('utf8').replace(/^test-enc:/, ''),
};

interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

let app: Express;
let fakeImapServer: net.Server;
let fakeImapPort = 0;
const seenCommands: string[] = [];

async function call<T = unknown>(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body?: unknown
): Promise<{ status: number; body: ApiResponse<T> }> {
  const server = app.listen(0);
  try {
    const addr = server.address() as net.AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as ApiResponse<T>;
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

beforeAll(async () => {
  await initDb();
});

afterAll(() => {
  closeDb();
});

describe('REST /api/v1/email routes', () => {
  beforeEach(async () => {
    await initDb();
    const db = getDb();
    migrate(db);
    ensureEmailTables(db);
    setSecretCipher(TEST_CIPHER);

    // Setup fake IMAP server
    seenCommands.length = 0;
    await new Promise<void>((resolve) => {
      fakeImapServer = net.createServer((socket) => {
        let buffer = '';
        socket.on('error', () => {});
        const write = (data: string) => {
          if (!socket.destroyed && socket.writable) {
            socket.write(data);
          }
        };
        write('* OK IMAP4rev1 Service Ready\r\n');
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          while (buffer.includes('\r\n')) {
            const idx = buffer.indexOf('\r\n');
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            seenCommands.push(line);
            const parts = line.split(' ');
            const tag = parts[0];
            const cmd = (parts[1] || '').toUpperCase();

            if (cmd === 'LOGIN') {
              write(`${tag} OK LOGIN completed\r\n`);
            } else if (cmd === 'LIST') {
              write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
              write('* LIST (\\HasNoChildren) "/" "Sent"\r\n');
              write(`${tag} OK LIST completed\r\n`);
            } else if (cmd === 'STATUS') {
              write('* STATUS "INBOX" (UNSEEN 3)\r\n');
              write(`${tag} OK STATUS completed\r\n`);
            } else if (cmd === 'SELECT') {
              write('* 1 EXISTS\r\n');
              write(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
            } else if (parts[1] === 'UID' && parts[2] === 'SEARCH') {
              write('* SEARCH 101\r\n');
              write(`${tag} OK SEARCH completed\r\n`);
            } else if (parts[1] === 'UID' && parts[2] === 'STORE') {
              write('* 1 FETCH (FLAGS (\\Seen \\Flagged))\r\n');
              write(`${tag} OK STORE completed\r\n`);
            } else if (cmd === 'FETCH' || (parts[1] === 'UID' && parts[2] === 'FETCH')) {
              write('* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE ("Sat, 13 Sep 2026 10:00:00 +0000" "Hello" (("A" NIL "a" "x.io")) NIL NIL NIL NIL NIL NIL) BODY[] {15}\r\nHello Body Text\r\n)\r\n');
              write(`${tag} OK FETCH completed\r\n`);
            } else if (cmd === 'LOGOUT') {
              write('* BYE logging out\r\n');
              write(`${tag} OK LOGOUT completed\r\n`);
              socket.end();
            }
          }
        });
      });
      fakeImapServer.listen(0, '127.0.0.1', () => {
        fakeImapPort = (fakeImapServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    const testSocketFactory: SocketFactory = (opts) => net.connect({ host: opts.host, port: opts.port });
    setSocketFactory(testSocketFactory);

    app = express();
    app.use(express.json());
    app.use('/api/v1/email', emailRoutes);
  });

  afterEach(async () => {
    setSocketFactory(null);
    setMailTransportFactory(null);
    resetSecretCiphers();
    if (fakeImapServer) {
      await new Promise<void>((resolve) => fakeImapServer.close(() => resolve()));
    }
  });

  it('R01: extends POST/PUT/PATCH create/update with identity and SMTP fields', async () => {
    const db = getDb();
    db.prepare('INSERT INTO profiles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('prof-1', 'Profile 1', 1, 1);

    // POST create
    const createRes = await call<{ id: string; display_name: string; signature: string; smtp_host: string; smtp_port: number; smtp_secure: boolean; profile_id: string }>(
      'post',
      '/api/v1/email/accounts',
      {
        email: 'ops@x.io',
        host: '127.0.0.1',
        port: fakeImapPort,
        username: 'ops@x.io',
        password: 'secret-password',
        label: 'Ops Account',
        display_name: 'Ops Team',
        signature: '-- Regards, Ops',
        smtp_host: 'smtp.x.io',
        smtp_port: 587,
        smtp_secure: false,
        profile_id: 'prof-1',
      }
    );

    expect(createRes.status).toBe(200);
    expect(createRes.body.code).toBe(0);
    const acc = createRes.body.data;
    expect(acc.display_name).toBe('Ops Team');
    expect(acc.signature).toBe('-- Regards, Ops');
    expect(acc.smtp_host).toBe('smtp.x.io');
    expect(acc.smtp_port).toBe(587);
    expect(acc.smtp_secure).toBe(false);
    expect(acc.profile_id).toBe('prof-1');
    expect(acc).not.toHaveProperty('password');
    expect(acc).not.toHaveProperty('password_enc');

    // PUT update
    const putRes = await call<{ display_name: string; signature: string }>(
      'put',
      `/api/v1/email/accounts/${acc.id}`,
      {
        display_name: 'Ops Updated',
        signature: '-- Ops v2',
      }
    );
    expect(putRes.status).toBe(200);
    expect(putRes.body.code).toBe(0);
    expect(putRes.body.data.display_name).toBe('Ops Updated');
    expect(putRes.body.data.signature).toBe('-- Ops v2');

    // PATCH update
    const patchRes = await call<{ display_name: string }>(
      'patch',
      `/api/v1/email/accounts/${acc.id}`,
      {
        display_name: 'Ops Patched',
      }
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.code).toBe(0);
    expect(patchRes.body.data.display_name).toBe('Ops Patched');
  });

  it('R01: rejects create on unknown profile with 400 envelope', async () => {
    const res = await call(
      'post',
      '/api/v1/email/accounts',
      {
        email: 'bad@x.io',
        host: '127.0.0.1',
        username: 'bad@x.io',
        profile_id: 'unknown-prof-xyz',
      }
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(400);
    expect(res.body.msg).toContain('Unknown profile_id');
  });

  it('R05: bindProfile binds, unbinds, filters, and rejects unknown profile / invalid inputs', async () => {
    const db = getDb();
    db.prepare('INSERT INTO profiles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('prof-alpha', 'Alpha', 1, 1);
    const acc = await createAccount(db, {
      email: 'a@x.io',
      host: '127.0.0.1',
      username: 'a@x.io',
      password: 'pw',
    });

    // 1. Validation failure: profile_id is a number -> 400 envelope
    const invalidRes = await call(
      'post',
      `/api/v1/email/accounts/${acc.id}/bind-profile`,
      { profile_id: 12345 }
    );
    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.code).toBe(400);

    // 2. Unknown profile -> 400 envelope
    const unknownProfRes = await call(
      'post',
      `/api/v1/email/accounts/${acc.id}/bind-profile`,
      { profile_id: 'prof-ghost' }
    );
    expect(unknownProfRes.status).toBe(400);
    expect(unknownProfRes.body.code).toBe(400);
    expect(unknownProfRes.body.msg).toContain('Unknown profile_id');

    // 3. Unknown account -> 404 envelope
    const unknownAccRes = await call(
      'post',
      '/api/v1/email/accounts/ghost-acc/bind-profile',
      { profile_id: 'prof-alpha' }
    );
    expect(unknownAccRes.status).toBe(404);
    expect(unknownAccRes.body.code).toBe(404);

    // 4. Successful bind
    const bindRes = await call<{ profile_id: string }>(
      'post',
      `/api/v1/email/accounts/${acc.id}/bind-profile`,
      { profile_id: 'prof-alpha' }
    );
    expect(bindRes.status).toBe(200);
    expect(bindRes.body.code).toBe(0);
    expect(bindRes.body.data.profile_id).toBe('prof-alpha');

    // 5. GET /accounts?profile_id= filter
    const listBound = await call<Array<{ id: string }>>('get', '/api/v1/email/accounts?profile_id=prof-alpha');
    expect(listBound.status).toBe(200);
    expect(listBound.body.data.some((a) => a.id === acc.id)).toBe(true);

    const listOther = await call<Array<{ id: string }>>('get', '/api/v1/email/accounts?profile_id=other-id');
    expect(listOther.status).toBe(200);
    expect(listOther.body.data.some((a) => a.id === acc.id)).toBe(false);

    // 6. Unbind with null
    const unbindRes = await call<{ profile_id: string | null }>(
      'post',
      `/api/v1/email/accounts/${acc.id}/bind-profile`,
      { profile_id: null }
    );
    expect(unbindRes.status).toBe(200);
    expect(unbindRes.body.data.profile_id).toBeNull();
  });

  it('R03: folders and folder-aware message list and read', async () => {
    const db = getDb();
    const acc = await createAccount(db, {
      email: 'f@x.io',
      host: '127.0.0.1',
      port: fakeImapPort,
      username: 'f@x.io',
      password: 'pw',
    });

    // 1. Folders list
    const foldersRes = await call<Array<{ name: string; unread: number }>>(
      'get',
      `/api/v1/email/accounts/${acc.id}/folders`
    );
    expect(foldersRes.status).toBe(200);
    expect(foldersRes.body.code).toBe(0);
    expect(foldersRes.body.data.map((f) => f.name)).toContain('INBOX');

    // 2. Folder messages list (?q=, ?unread=1)
    const messagesRes = await call<{ messages: Array<{ uid: string; subject: string }> }>(
      'get',
      `/api/v1/email/accounts/${acc.id}/folders/INBOX/messages?q=Hello`
    );
    expect(messagesRes.status).toBe(200);
    expect(messagesRes.body.code).toBe(0);
    expect(messagesRes.body.data.messages.length).toBeGreaterThan(0);

    // 3. Folder-aware single message read
    const readRes = await call<{ uid: string; folder: string; body: string }>(
      'get',
      `/api/v1/email/accounts/${acc.id}/folders/INBOX/messages/101`
    );
    expect(readRes.status).toBe(200);
    expect(readRes.body.code).toBe(0);
    expect(readRes.body.data.uid).toBe('101');
    expect(readRes.body.data.folder).toBe('INBOX');

    // 4. Unknown account -> 404
    const notFoundRes = await call('get', '/api/v1/email/accounts/ghost-acc/folders');
    expect(notFoundRes.status).toBe(404);
  });

  it('R03: PATCH message flags with Zod validation and folder option', async () => {
    const db = getDb();
    const acc = await createAccount(db, {
      email: 'flags@x.io',
      host: '127.0.0.1',
      port: fakeImapPort,
      username: 'flags@x.io',
      password: 'pw',
    });

    // 1. Validation failure: non-boolean seen flag -> 400 envelope
    const badRes = await call(
      'patch',
      `/api/v1/email/accounts/${acc.id}/messages/101/flags`,
      { seen: 'invalid-string' }
    );
    expect(badRes.status).toBe(400);
    expect(badRes.body.code).toBe(400);

    // 2. Successful flag update
    const flagRes = await call(
      'patch',
      `/api/v1/email/accounts/${acc.id}/messages/101/flags?folder=INBOX`,
      { seen: true, flagged: true }
    );
    expect(flagRes.status).toBe(200);
    expect(flagRes.body.code).toBe(0);
    expect(seenCommands.join('\n')).toMatch(/UID STORE 101/i);

    // 3. Unknown account -> 404
    const unknownRes = await call(
      'patch',
      '/api/v1/email/accounts/ghost-acc/messages/101/flags',
      { seen: true }
    );
    expect(unknownRes.status).toBe(404);
  });

  it('R02: POST send with Zod validation, mock SMTP transport, and outbox recording', async () => {
    const db = getDb();
    const acc = await createAccount(db, {
      email: 'sender@x.io',
      host: '127.0.0.1',
      port: fakeImapPort,
      username: 'sender@x.io',
      password: 'pw',
      smtp_host: '127.0.0.1',
      display_name: 'Sender Test',
    });

    let sentOptions: Record<string, unknown> = {};
    const mockTransport: MailTransportFactory = (() => ({
      sendMail: async (opts: Record<string, unknown>) => {
        sentOptions = opts;
        return { messageId: '<msg-id-123@x.io>' };
      },
    })) as unknown as MailTransportFactory;
    setMailTransportFactory(mockTransport);

    // 1. Validation failure: missing to -> 400 envelope
    const noTo = await call(
      'post',
      `/api/v1/email/accounts/${acc.id}/send`,
      { subject: 'Hello' }
    );
    expect(noTo.status).toBe(400);
    expect(noTo.body.code).toBe(400);

    // 2. Validation failure: missing subject -> 400 envelope
    const noSubject = await call(
      'post',
      `/api/v1/email/accounts/${acc.id}/send`,
      { to: 'recipient@x.io' }
    );
    expect(noSubject.status).toBe(400);
    expect(noSubject.body.code).toBe(400);

    // 3. Successful send
    const sendRes = await call<{ messageId: string }>(
      'post',
      `/api/v1/email/accounts/${acc.id}/send`,
      {
        to: ['dest@x.io'],
        subject: 'Invoice 101',
        text: 'Please find attached invoice.',
      }
    );
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.code).toBe(0);
    expect(sendRes.body.data.messageId).toBe('<msg-id-123@x.io>');
    expect(sentOptions.subject).toBe('Invoice 101');
    // 4. GET outbox reflects the sent message
    const outboxRes = await call<Array<{ subject: string; status: string; provider_msg_id: string }>>(
      'get',
      `/api/v1/email/accounts/${acc.id}/outbox`
    );
    expect(outboxRes.status).toBe(200);
    expect(outboxRes.body.code).toBe(0);
    expect(outboxRes.body.data.length).toBeGreaterThan(0);
    expect(outboxRes.body.data[0].status).toBe('sent');
    expect(outboxRes.body.data[0].provider_msg_id).toBe('<msg-id-123@x.io>');

    // 5. Unknown account -> 404
    const unknownRes = await call(
      'post',
      '/api/v1/email/accounts/ghost-acc/send',
      { to: 'a@x.io', subject: 'test' }
    );
    expect(unknownRes.status).toBe(404);
  });

  it('R03: Drafts CRUD with Zod validation', async () => {
    const db = getDb();
    const acc = await createAccount(db, {
      email: 'drafts@x.io',
      host: '127.0.0.1',
      username: 'drafts@x.io',
      password: 'pw',
    });

    // 1. Validation failure: invalid to type -> 400 envelope
    const badDraft = await call(
      'post',
      `/api/v1/email/accounts/${acc.id}/drafts`,
      { to: 12345 }
    );
    expect(badDraft.status).toBe(400);
    expect(badDraft.body.code).toBe(400);

    // 2. Create draft
    const createDraft = await call<{ id: string; subject: string }>(
      'post',
      `/api/v1/email/accounts/${acc.id}/drafts`,
      {
        to: ['friend@x.io'],
        subject: 'Draft Subject',
        body_text: 'Draft Content',
      }
    );
    expect(createDraft.status).toBe(200);
    expect(createDraft.body.code).toBe(0);
    const draftId = createDraft.body.data.id;
    expect(createDraft.body.data.subject).toBe('Draft Subject');

    // 3. List drafts
    const listDrafts = await call<Array<{ id: string; subject: string }>>(
      'get',
      `/api/v1/email/accounts/${acc.id}/drafts`
    );
    expect(listDrafts.status).toBe(200);
    expect(listDrafts.body.code).toBe(0);
    expect(listDrafts.body.data.some((d) => d.id === draftId)).toBe(true);

    // 4. Delete draft
    const deleteDraft = await call<{ deleted: boolean }>(
      'delete',
      `/api/v1/email/accounts/${acc.id}/drafts/${draftId}`
    );
    expect(deleteDraft.status).toBe(200);
    expect(deleteDraft.body.code).toBe(0);
    expect(deleteDraft.body.data.deleted).toBe(true);

    // 5. Unknown account -> 404
    const unknownList = await call('get', '/api/v1/email/accounts/ghost-acc/drafts');
    expect(unknownList.status).toBe(404);
  });

  it('R07: preserves legacy endpoints byte-compatibility', async () => {
    const db = getDb();
    const acc = await createAccount(db, {
      email: 'legacy@x.io',
      host: '127.0.0.1',
      port: fakeImapPort,
      username: 'legacy@x.io',
      password: 'secret',
    });

    // 1. Legacy inbox list
    const inboxRes = await call(
      'get',
      `/api/v1/email/accounts/${acc.id}/inbox`
    );
    expect(inboxRes.status).toBe(200);
    expect(inboxRes.body.code).toBe(0);

    // 2. Reveal password
    const revealRes = await call<{ password: string }>(
      'post',
      `/api/v1/email/accounts/${acc.id}/reveal`
    );
    expect(revealRes.status).toBe(200);
    expect(revealRes.body.code).toBe(0);
    expect(revealRes.body.data.password).toBe('secret');

    // 3. Code extraction
    const extractRes = await call<{ codes: string[] }>(
      'post',
      '/api/v1/email/extract-codes',
      { text: 'Your verification code is 492018' }
    );
    expect(extractRes.status).toBe(200);
    expect(extractRes.body.code).toBe(0);
    expect(extractRes.body.data.codes).toContain('492018');
  });
});
