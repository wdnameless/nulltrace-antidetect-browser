import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import { initDb, closeDb, getDb } from '../../src/main/db';
import { migrate } from '../../src/main/db/schema';
import type { CreateEmailAccountInput } from '../../src/main/email/manager';
import {
  createAccount,
  listAccounts,
  updateAccount,
  ensureEmailTables,
  setSecretCipher,
  resetSecretCiphers,
  listFolders,
  listMessages,
  readMessage,
  setMessageFlags,
  appendMessage,
  saveDraft,
  listDrafts,
  deleteDraft,
  listOutbox,
  bindProfile,
  extractMimeParts,
  type SocketFactory,
} from '../../src/main/email/manager';
import { sendMail, setMailTransportFactory, type MailTransportFactory } from '../../src/main/email/smtp';

beforeAll(async () => {
  await initDb();
});

afterAll(() => {
  closeDb();
});

const TEST_CIPHER = {
  encrypt: (plain: string) => Buffer.from(`test-enc:${plain}`, 'utf8'),
  decrypt: (data: Buffer) => data.toString('utf8').replace(/^test-enc:/, ''),
};

async function makeAccount(extra: Partial<CreateEmailAccountInput> = {}) {
  const db = getDb();
  return createAccount(db, {
    label: 'T1',
    email: 't1@example.com',
    host: '127.0.0.1',
    port: 1,
    username: 't1@example.com',
    password: 'pw',
    smtp_host: '127.0.0.1',
    smtp_port: 2525,
    smtp_secure: false,
    ...extra,
  });
}

describe('T1 mail core: schema, drafts, outbox, binding', () => {
  beforeEach(async () => {
    await initDb();
    const db = getDb();
    migrate(db);
    ensureEmailTables(db);
    setSecretCipher(TEST_CIPHER);
  });

  afterEach(() => {
    resetSecretCiphers();
    closeDb();
  });

  it('createAccount persists identity + SMTP fields masked', async () => {
    const db = getDb();
    const acc = await makeAccount({ display_name: 'Ops', signature: '-- Ops', profile_id: null });
    expect(acc.display_name).toBe('Ops');
    expect(acc.signature).toBe('-- Ops');
    expect(acc.smtp_host).toBe('127.0.0.1');
    expect(acc.smtp_port).toBe(2525);
    expect(acc.smtp_secure).toBe(false);
    expect(acc).not.toHaveProperty('password');
    expect(acc).not.toHaveProperty('password_enc');
    expect(JSON.stringify(acc)).not.toContain('pw');
    expect(db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(acc.id)).toBeTruthy();
  });

  it('rejects unknown profile_id on create, update, bind', async () => {
    const db = getDb();
    await expect(makeAccount({ profile_id: 'nope' })).rejects.toThrow('Unknown profile_id');
    const acc = await makeAccount();
    await expect(updateAccount(db, acc.id, { profile_id: 'nope' })).rejects.toThrow('Unknown profile_id');
    await expect(bindProfile(db, acc.id, 'nope')).rejects.toThrow('Unknown profile_id');
  });

  it('bindProfile binds, filters, and unbinds', async () => {
    const db = getDb();
    db.prepare('INSERT INTO profiles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p1', 'P1', 1, 1);
    const acc = await makeAccount();
    const bound = await bindProfile(db, acc.id, 'p1');
    expect(bound.profile_id).toBe('p1');
    const filtered = await listAccounts(db, { profile_id: 'p1' });
    expect(filtered.map((a) => a.id)).toContain(acc.id);
    const unbound = await bindProfile(db, acc.id, null);
    expect(unbound.profile_id).toBeNull();
    const filteredAfter = await listAccounts(db, { profile_id: 'p1' });
    expect(filteredAfter.map((a) => a.id)).not.toContain(acc.id);
  });

  it('drafts save/list/delete round-trip', async () => {
    const db = getDb();
    const acc = await makeAccount();
    const d = await saveDraft(db, acc.id, { to: ['a@x.io', 'b@x.io'], subject: 'Hi', bodyText: 'body', bodyHtml: '<b>body</b>' });
    expect(d.id).toBeTruthy();
    expect(d.to).toEqual(['a@x.io', 'b@x.io']);
    const list = await listDrafts(db, acc.id);
    expect(list.length).toBe(1);
    expect(list[0].subject).toBe('Hi');
    expect(await deleteDraft(db, acc.id, d.id)).toBe(true);
    expect(await listDrafts(db, acc.id)).toEqual([]);
  });

  it('saveDraft refuses id owned by another account', async () => {
    const db = getDb();
    const a1 = await makeAccount({ email: 'a1@x.io', username: 'a1@x.io' });
    const a2 = await makeAccount({ email: 'a2@x.io', username: 'a2@x.io' });
    const d = await saveDraft(db, a1.id, { to: ['x@y.io'], subject: 'A1' });
    await expect(saveDraft(db, a2.id, { id: d.id, to: ['z@y.io'], subject: 'hijack' })).rejects.toThrow(/not found in this account/i);
    // A1's draft untouched.
    const list = await listDrafts(db, a1.id);
    expect(list.length).toBe(1);
    expect(list[0].subject).toBe('A1');
  });

  it('outbox starts empty', async () => {
    const db = getDb();
    const acc = await makeAccount();
    expect(await listOutbox(db, acc.id)).toEqual([]);
  });

  it('extractMimeParts decodes multipart + base64', () => {
    const raw = [
      'From: a@x.io',
      'Content-Type: multipart/alternative; boundary="B1"',
      '',
      '--B1',
      'Content-Type: text/plain',
      '',
      'plain body',
      '--B1',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>html body</p>').toString('base64'),
      '--B1--',
      '',
    ].join('\r\n');
    const parts = extractMimeParts(raw);
    expect(parts.text).toContain('plain body');
    expect(parts.html).toContain('html body');
  });

  it('extractMimeParts decodes quoted-printable Cyrillic as UTF-8', () => {
    const raw = [
      'From: a@x.io',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82',
      '',
    ].join('\r\n');
    expect(extractMimeParts(raw).text).toContain('Привет');
  });
});

describe('T1 mail core: IMAP verbs over fake server', () => {
  let fakeServer: net.Server;
  let serverPort: number;
  const seenCommands: string[] = [];

  beforeEach(async () => {
    await initDb();
    const db = getDb();
    migrate(db);
    ensureEmailTables(db);
    setSecretCipher(TEST_CIPHER);
    seenCommands.length = 0;

    await new Promise<void>((resolve) => {
      fakeServer = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.write('* OK IMAP4rev1 Service Ready\r\n');
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          while (buffer.includes('\r\n')) {
            const idx = buffer.indexOf('\r\n');
            const line = buffer.substring(0, idx);
            buffer = buffer.substring(idx + 2);
            const parts = line.split(' ');
            const tag = parts[0];
            const cmd = (parts[1] || '').toUpperCase();
            seenCommands.push(line);
            if (cmd === 'LOGIN') {
              socket.write(`${tag} OK LOGIN completed\r\n`);
            } else if (cmd === 'LIST') {
              socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
              socket.write('* LIST (\\HasNoChildren) "/" "Sent"\r\n');
              socket.write(`${tag} OK LIST completed\r\n`);
            } else if (cmd === 'STATUS') {
              const m = line.match(/STATUS "([^"]+)"/i);
              const unseen = m && m[1] === 'INBOX' ? 3 : 0;
              socket.write(`* STATUS "${m ? m[1] : 'INBOX'}" (MESSAGES 5 UNSEEN ${unseen})\r\n`);
              socket.write(`${tag} OK STATUS completed\r\n`);
            } else if (cmd === 'SELECT') {
              socket.write('* 2 EXISTS\r\n');
              socket.write(`${tag} OK SELECT completed\r\n`);
            } else if (parts[1] === 'UID' && parts[2] === 'SEARCH') {
              socket.write('* SEARCH 101\r\n');
              socket.write(`${tag} OK SEARCH completed\r\n`);
            } else if (parts[1] === 'UID' && parts[2] === 'STORE') {
              socket.write(`* 1 FETCH (UID 101 FLAGS (\\Seen))\r\n`);
              socket.write(`${tag} OK STORE completed\r\n`);
            } else if (cmd === 'APPEND') {
              socket.write('+ Ready for literal\r\n');
              // Client then sends raw bytes + CRLF on the same connection; consume next chunk blindly.
              socket.once('data', () => {
                if (!socket.destroyed) socket.write(`${tag} OK APPEND completed\r\n`);
              });
            } else if (cmd === 'FETCH' || (parts[1] === 'UID' && parts[2] === 'FETCH')) {
              socket.write('* 1 FETCH (UID 101 FLAGS (\\Seen) ENVELOPE ("Sat, 13 Sep 2026 10:00:00 +0000" "Hello" (("A" NIL "a" "x.io")) NIL NIL NIL NIL NIL NIL))\r\n');
              socket.write(`${tag} OK FETCH completed\r\n`);
            } else if (cmd === 'LOGOUT') {
              socket.write('* BYE logging out\r\n');
              if (!socket.destroyed) socket.write(`${tag} OK LOGOUT completed\r\n`);
              socket.end();
            }
          }
        });
      });
      fakeServer.listen(0, '127.0.0.1', () => {
        serverPort = (fakeServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  const factory = (): SocketFactory => (opts) => net.connect({ host: opts.host, port: opts.port });

  async function accountOnFake(extra: Partial<CreateEmailAccountInput> = {}) {
    const db = getDb();
    return createAccount(db, {
      label: 'Fake', email: 'f@x.io', host: '127.0.0.1', port: serverPort,
      username: 'f@x.io', password: 'pw', ...extra,
    });
  }

  it('listFolders returns folders with unread counts', async () => {
    const db = getDb();
    const acc = await accountOnFake();
    const folders = await listFolders(db, acc.id, factory());
    expect(folders).toEqual(expect.arrayContaining([
      { name: 'INBOX', unread: 3 },
      { name: 'Sent', unread: 0 },
    ]));
  });

  it('listMessages lists folder and issues SEARCH for query', async () => {
    const db = getDb();
    const acc = await accountOnFake();
    const all = await listMessages(db, acc.id, 'INBOX', undefined, factory());
    expect(all.cached).toBe(false);
    expect(all.messages.length).toBe(1);
    expect(all.messages[0].seen).toBe(true);
    seenCommands.length = 0;
    const searched = await listMessages(db, acc.id, 'INBOX', 'hello', factory());
    expect(searched.messages.length).toBe(1);
    expect(seenCommands.join('\n')).toMatch(/UID SEARCH/i);
    // No fake UIDs from the tagged tail: the FETCH id-set must be numeric only.
    const fetchMatch = seenCommands.join('\n').match(/UID FETCH ([\d,]+) \(/i);
    expect(fetchMatch).toBeTruthy();
    expect(fetchMatch?.[1]).toMatch(/^[\d,]+$/);
  });

  it('listMessages exposes Message-ID from ENVELOPE', async () => {
    const db = getDb();
    const acc = await accountOnFake();
    const res = await listMessages(db, acc.id, 'INBOX', undefined, factory());
    // Fake server envelope ends with NIL message-id → undefined; shape must exist.
    expect(res.messages[0]).toHaveProperty('messageId');
    expect(res.messages[0].messageId).toBeUndefined();
  });

  it('setMessageFlags issues STORE and updates cache', async () => {
    const db = getDb();
    const acc = await accountOnFake();
    await listMessages(db, acc.id, 'INBOX', undefined, factory());
    seenCommands.length = 0;
    await setMessageFlags(db, acc.id, 'INBOX', '101', { flagged: true }, factory());
    expect(seenCommands.join('\n')).toMatch(/UID STORE 101 \+FLAGS \(\\Flagged\)/i);
    const row = db.prepare('SELECT flags FROM email_messages_cache WHERE account_id = ? AND uid = ?').get(acc.id, '101') as { flags: string };
    expect(JSON.parse(row.flags)).toEqual(expect.arrayContaining(['\\Flagged']));
  });

  it('P1: readMessage selects the requested folder, not INBOX', async () => {
    const db = getDb();
    const acc = await accountOnFake();
    seenCommands.length = 0;
    await readMessage(db, acc.id, '101', 'Sent', factory());
    expect(seenCommands.join('\n')).toMatch(/SELECT "Sent"/i);
    expect(seenCommands.join('\n')).not.toMatch(/SELECT "INBOX"/i);
  });

  it('P1: cache keeps same UID in different folders apart', async () => {
    const db = getDb();
    const acc = await accountOnFake();
    await listMessages(db, acc.id, 'INBOX', undefined, factory());
    await listMessages(db, acc.id, 'Sent', undefined, factory());
    const rows = db.prepare('SELECT folder FROM email_messages_cache WHERE account_id = ? AND uid = ?').all(acc.id, '101') as Array<{ folder: string }>;
    expect(rows.map((r) => r.folder).sort()).toEqual(['INBOX', 'Sent']);
  });

  it('appendMessage issues APPEND', async () => {
    const db = getDb();
    const acc = await accountOnFake();
    await appendMessage(db, acc.id, 'Sent', 'From: f@x.io\r\n\r\nhello', factory());
    expect(seenCommands.join('\n')).toMatch(/APPEND "Sent"/i);
  });

  it('P2: APPEND rejected by server fails before writing MIME bytes', async () => {
    // Separate fake server that rejects the APPEND header with NO.
    const rejectServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.write('* OK IMAP4rev1 Service Ready\r\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        while (buffer.includes('\r\n')) {
          const idx = buffer.indexOf('\r\n');
          const line = buffer.substring(0, idx);
          buffer = buffer.substring(idx + 2);
          const parts = line.split(' ');
          const tag = parts[0];
          const cmd = (parts[1] || '').toUpperCase();
          if (cmd === 'LOGIN') socket.write(`${tag} OK LOGIN completed\r\n`);
          else if (cmd === 'APPEND') socket.write(`${tag} NO Mailbox does not exist\r\n`);
          else if (cmd === 'LOGOUT') socket.end();
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      rejectServer.listen(0, '127.0.0.1', () => resolve((rejectServer.address() as net.AddressInfo).port));
    });
    try {
      const db = getDb();
      const acc = await createAccount(db, {
        label: 'Reject', email: 'r@x.io', host: '127.0.0.1', port,
        username: 'r@x.io', password: 'pw',
      });
      await expect(appendMessage(db, acc.id, 'Nope', 'From: r@x.io\r\n\r\nx', factory())).rejects.toThrow(/APPEND rejected/i);
    } finally {
      await new Promise<void>((resolve) => rejectServer.close(() => resolve()));
    }
  });

  it('P3: empty folder returns empty list without FETCH error', async () => {
    const emptyServer = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.write('* OK IMAP4rev1 Service Ready\r\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        while (buffer.includes('\r\n')) {
          const idx = buffer.indexOf('\r\n');
          const line = buffer.substring(0, idx);
          buffer = buffer.substring(idx + 2);
          const parts = line.split(' ');
          const tag = parts[0];
          const cmd = (parts[1] || '').toUpperCase();
          if (cmd === 'LOGIN') socket.write(`${tag} OK LOGIN completed\r\n`);
          else if (cmd === 'SELECT') socket.write(`* 0 EXISTS\r\n${tag} OK SELECT completed\r\n`);
          else if (cmd === 'FETCH' || parts[2] === 'FETCH') socket.write(`${tag} NO Invalid sequence\r\n`);
          else if (cmd === 'LOGOUT') socket.end();
        }
      });
    });
    const port = await new Promise<number>((resolve) => {
      emptyServer.listen(0, '127.0.0.1', () => resolve((emptyServer.address() as net.AddressInfo).port));
    });
    try {
      const db = getDb();
      const acc = await createAccount(db, {
        label: 'Empty', email: 'e@x.io', host: '127.0.0.1', port,
        username: 'e@x.io', password: 'pw',
      });
      const res = await listMessages(db, acc.id, 'INBOX', undefined, factory());
      expect(res.cached).toBe(false);
      expect(res.messages).toEqual([]);
      expect(res.error).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => emptyServer.close(() => resolve()));
    }
  });
});

describe('T1 mail core: SMTP send', () => {
  beforeEach(async () => {
    await initDb();
    const db = getDb();
    migrate(db);
    ensureEmailTables(db);
    setSecretCipher(TEST_CIPHER);
  });

  afterEach(() => {
    setMailTransportFactory(null);
    resetSecretCiphers();
    closeDb();
  });

  it('sendMail success records sent outbox row', async () => {
    const db = getDb();
    const acc = await makeAccount({ display_name: 'Ops', signature: '-- Ops' });
    let captured: Record<string, unknown> = {};
    const stubFactory = (() => ({
      sendMail: async (opts: Record<string, unknown>) => {
        captured = opts;
        return { messageId: '<abc@x.io>' };
      },
    })) as unknown as MailTransportFactory;
    setMailTransportFactory(stubFactory);
    // appendMessage to Sent will fail (no IMAP server) — best-effort, must not fail delivery.
    const res = await sendMail(db, acc.id, { to: ['to@x.io'], subject: 'S', text: 'hi' });
    expect(res.messageId).toBe('<abc@x.io>');
    expect(String(captured.from)).toContain('Ops');
    expect(String(captured.text)).toContain('-- Ops');
    const rows = await listOutbox(db, acc.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('sent');
    expect(rows[0].provider_msg_id).toBe('<abc@x.io>');
  });

  it('sendMail failure records failed outbox row with provider text', async () => {
    const db = getDb();
    const acc = await makeAccount();
    const failFactory = (() => ({
      sendMail: async () => {
        throw new Error('535 Authentication failed');
      },
    })) as unknown as MailTransportFactory;
    setMailTransportFactory(failFactory);
    await expect(sendMail(db, acc.id, { to: ['to@x.io'], subject: 'S', text: 'hi' })).rejects.toThrow('535 Authentication failed');
    const rows = await listOutbox(db, acc.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].error).toContain('535 Authentication failed');
  });
});
