import net from 'net';
import tls from 'tls';
import { randomUUID } from 'crypto';
import { getDb } from '../db';
import type { Database } from '../db';
import { protectSecret, revealSecret, setSecretCipher, resetSecretCiphers } from '../util/secretStore';
import { getProfile } from '../profiles/profileManager';

export { setSecretCipher, resetSecretCiphers };

export interface EmailAccount {
  id: string;
  label: string | null;
  email: string;
  host: string;
  port: number;
  username: string;
  password_enc: string | null;
  created_at: number;
  updated_at: number;
  display_name?: string | null;
  signature?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: boolean | number | null;
  profile_id?: string | null;
}

export interface EmailAccountMasked {
  id: string;
  label: string | null;
  email: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  created_at: number;
  updated_at: number;
  display_name: string | null;
  signature: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  profile_id: string | null;
}

export interface CreateEmailAccountInput {
  label?: string;
  email: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  display_name?: string | null;
  signature?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: boolean | number | null;
  profile_id?: string | null;
}

export interface UpdateEmailAccountInput {
  label?: string;
  email?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  display_name?: string | null;
  signature?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: boolean | number | null;
  profile_id?: string | null;
}

export interface EmailMessageSummary {
  uid: string;
  subject: string;
  from: string;
  date: string;
  flags?: string[];
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
}

export interface EmailMessageDetail extends EmailMessageSummary {
  id: string;
  accountId: string;
  body: string;
  text?: string;
  html?: string;
  cached?: boolean;
  /** Why the live fetch failed, when the body came from the cache instead. */
  error?: string;
}

export interface InboxResult {
  messages: EmailMessageSummary[];
  cached: boolean;
  /**
   * Why the live read failed, when it did. The cache fallback is useful, but it used to be SILENT:
   * a rejected login or an unreachable host returned `cached: true` with an empty list, and the
   * operator saw "Cached" over an empty inbox with no reason — indistinguishable from a mailbox
   * that is genuinely empty. The provider's own words ("AUTHENTICATIONFAILED") were discarded one
   * line above being shown.
   */
  error?: string;
}

export interface DraftInput {
  id?: string;
  to?: string[] | string;
  to_addrs?: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  subject?: string;
  bodyText?: string;
  body_text?: string;
  bodyHtml?: string;
  body_html?: string;
  inReplyTo?: string;
  in_reply_to?: string;
}

// Draft/OutboxRow carry both camelCase and snake_case on purpose: MCP/SDK/UI
// consumers (tools.ts, sdk types.ts, Email.tsx) already read both spellings.
// Collapsing to one case would break those call sites for -85 lines.
export interface Draft {
  id: string;
  accountId: string;
  account_id: string;
  to: string[];
  to_addrs: string;
  cc: string | null;
  bcc: string | null;
  subject: string;
  bodyText: string | null;
  body_text: string | null;
  bodyHtml: string | null;
  body_html: string | null;
  inReplyTo: string | null;
  in_reply_to: string | null;
  updatedAt: number;
  updated_at: number;
}

export interface OutboxRow {
  id: string;
  accountId: string;
  account_id: string;
  to: string[];
  to_addrs: string;
  subject: string;
  status: string;
  providerMsgId: string | null;
  provider_msg_id: string | null;
  error: string | null;
  createdAt: number;
  created_at: number;
}

export type SocketFactory = (options: { host: string; port: number; tls?: boolean }) => net.Socket;

let customSocketFactory: SocketFactory | null = null;

export function setSocketFactory(factory: SocketFactory | null): void {
  customSocketFactory = factory;
}


export function ensureEmailTables(db?: Database): void {
  const d = db ?? getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id           TEXT PRIMARY KEY,
      label        TEXT,
      email        TEXT NOT NULL,
      host         TEXT NOT NULL,
      port         INTEGER NOT NULL,
      username     TEXT NOT NULL,
      password_enc TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      display_name TEXT,
      signature    TEXT,
      smtp_host    TEXT,
      smtp_port    INTEGER,
      smtp_secure  INTEGER,
      profile_id   TEXT
    );

    CREATE TABLE IF NOT EXISTS email_messages_cache (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      uid        TEXT NOT NULL,
      subject    TEXT,
      from_addr  TEXT,
      date       TEXT,
      body       TEXT,
      created_at INTEGER NOT NULL,
      folder     TEXT DEFAULT 'INBOX',
      flags      TEXT,
      UNIQUE(account_id, folder, uid)
    );

    CREATE INDEX IF NOT EXISTS idx_email_cache_account ON email_messages_cache(account_id);

    CREATE TABLE IF NOT EXISTS email_outbox (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      to_addrs        TEXT NOT NULL,
      subject         TEXT,
      status          TEXT NOT NULL,
      provider_msg_id TEXT,
      error           TEXT,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_email_outbox_account ON email_outbox(account_id);

    CREATE TABLE IF NOT EXISTS email_drafts (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
      to_addrs     TEXT NOT NULL,
      cc           TEXT,
      bcc          TEXT,
      subject      TEXT,
      body_text    TEXT,
      body_html    TEXT,
      in_reply_to  TEXT,
      updated_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_email_drafts_account ON email_drafts(account_id);
  `);

  try {
    const accCols = d.prepare('PRAGMA table_info(email_accounts)').all() as Array<{ name: string }>;
    const accColNames = new Set(accCols.map((c) => c.name));
    if (!accColNames.has('display_name')) d.exec('ALTER TABLE email_accounts ADD COLUMN display_name TEXT');
    if (!accColNames.has('signature')) d.exec('ALTER TABLE email_accounts ADD COLUMN signature TEXT');
    if (!accColNames.has('smtp_host')) d.exec('ALTER TABLE email_accounts ADD COLUMN smtp_host TEXT');
    if (!accColNames.has('smtp_port')) d.exec('ALTER TABLE email_accounts ADD COLUMN smtp_port INTEGER');
    if (!accColNames.has('smtp_secure')) d.exec('ALTER TABLE email_accounts ADD COLUMN smtp_secure INTEGER');
    if (!accColNames.has('profile_id')) d.exec('ALTER TABLE email_accounts ADD COLUMN profile_id TEXT');

    const cacheCols = d.prepare('PRAGMA table_info(email_messages_cache)').all() as Array<{ name: string }>;
    const cacheColNames = new Set(cacheCols.map((c) => c.name));
    if (!cacheColNames.has('folder')) d.exec("ALTER TABLE email_messages_cache ADD COLUMN folder TEXT DEFAULT 'INBOX'");
    // P1: UIDs are folder-scoped per RFC 3501 — the old UNIQUE(account_id, uid) let Sent
    // overwrite INBOX rows on conflict. Rebuild the table once under the new key.
    // Cache-only table: contents are re-fetchable, so drop-and-recreate is safe.
    const cacheIdx = d.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'email_messages_cache'`).get() as { sql?: string } | undefined;
    if (cacheIdx?.sql && !cacheIdx.sql.includes('UNIQUE(account_id, folder, uid)')) {
      d.exec('DROP TABLE email_messages_cache');
      d.exec(`
        CREATE TABLE email_messages_cache (
          id         TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
          uid        TEXT NOT NULL,
          subject    TEXT,
          from_addr  TEXT,
          date       TEXT,
          body       TEXT,
          created_at INTEGER NOT NULL,
          folder     TEXT DEFAULT 'INBOX',
          flags      TEXT,
          UNIQUE(account_id, folder, uid)
        );
        CREATE INDEX IF NOT EXISTS idx_email_cache_account ON email_messages_cache(account_id);
      `);
    }
  } catch {
    // ignore migration errors if pragma inspection fails
  }
}

function validateProfileId(db: Database, profileId: string | null | undefined): void {
  if (profileId === null || profileId === undefined) return;
  let profile: unknown;
  try {
    profile = getProfile(profileId);
  } catch {
    // fallback to checking db directly if getProfile threw
  }
  if (!profile) {
    const row = db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId);
    if (!row) {
      throw new Error(`Unknown profile_id: ${profileId}`);
    }
  }
}

function formatAddrs(val: string[] | string | undefined | null): string {
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'string') return val;
  return '';
}

function parseAddrs(val: string | null | undefined): string[] {
  if (!val || typeof val !== 'string') return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

function toMasked(row: Record<string, unknown>): EmailAccountMasked {
  return {
    id: String(row.id),
    label: (row.label as string | null) ?? null,
    email: String(row.email),
    host: String(row.host),
    port: Number(row.port) || 993,
    username: String(row.username),
    has_password: Boolean(row.password_enc),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
    display_name: (row.display_name as string | null) ?? null,
    signature: (row.signature as string | null) ?? null,
    smtp_host: (row.smtp_host as string | null) ?? null,
    smtp_port: row.smtp_port != null ? Number(row.smtp_port) : null,
    smtp_secure: row.smtp_secure != null ? Boolean(row.smtp_secure) : null,
    profile_id: (row.profile_id as string | null) ?? null,
  };
}

function toDraft(row: Record<string, unknown>): Draft {
  const toAddrs = String(row.to_addrs || '');
  const toList = parseAddrs(toAddrs);
  const updatedAt = Number(row.updated_at) || 0;
  const bodyText = (row.body_text as string | null) ?? null;
  const bodyHtml = (row.body_html as string | null) ?? null;
  const inReplyTo = (row.in_reply_to as string | null) ?? null;
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    account_id: String(row.account_id),
    to: toList,
    to_addrs: toAddrs,
    cc: (row.cc as string | null) ?? null,
    bcc: (row.bcc as string | null) ?? null,
    subject: String(row.subject || ''),
    bodyText,
    body_text: bodyText,
    bodyHtml,
    body_html: bodyHtml,
    inReplyTo,
    in_reply_to: inReplyTo,
    updatedAt,
    updated_at: updatedAt,
  };
}

function toOutboxRow(row: Record<string, unknown>): OutboxRow {
  const toAddrs = String(row.to_addrs || '');
  const toList = parseAddrs(toAddrs);
  const createdAt = Number(row.created_at) || 0;
  const providerMsgId = (row.provider_msg_id as string | null) ?? null;
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    account_id: String(row.account_id),
    to: toList,
    to_addrs: toAddrs,
    subject: String(row.subject || ''),
    status: String(row.status || ''),
    providerMsgId,
    provider_msg_id: providerMsgId,
    error: (row.error as string | null) ?? null,
    createdAt,
    created_at: createdAt,
  };
}

export async function createAccount(
  dbOrInput: Database | CreateEmailAccountInput,
  maybeInput?: CreateEmailAccountInput
): Promise<EmailAccountMasked> {
  const isDbFirst = maybeInput !== undefined;
  const db = isDbFirst ? (dbOrInput as Database) : getDb();
  const input = isDbFirst ? maybeInput : (dbOrInput as CreateEmailAccountInput);
  ensureEmailTables(db);

  validateProfileId(db, input.profile_id);

  const id = randomUUID();
  const now = Date.now();
  const port = input.port ?? 993;
  const passwordEnc = input.password ? protectSecret(input.password) : null;
  const smtpSecure = input.smtp_secure != null ? (input.smtp_secure ? 1 : 0) : null;

  db.prepare(`
    INSERT INTO email_accounts (
      id, label, email, host, port, username, password_enc, created_at, updated_at,
      display_name, signature, smtp_host, smtp_port, smtp_secure, profile_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.label ?? null,
    input.email,
    input.host,
    port,
    input.username,
    passwordEnc,
    now,
    now,
    input.display_name ?? null,
    input.signature ?? null,
    input.smtp_host ?? null,
    input.smtp_port ?? null,
    smtpSecure,
    input.profile_id ?? null
  );

  const row = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as Record<string, unknown>;
  return toMasked(row);
}

export async function listAccounts(
  explicitDbOrFilter?: Database | { profileId?: string | null; profile_id?: string | null },
  maybeFilter?: { profileId?: string | null; profile_id?: string | null }
): Promise<EmailAccountMasked[]> {
  const isDb = explicitDbOrFilter && typeof (explicitDbOrFilter as Database).prepare === 'function';
  const db = isDb ? (explicitDbOrFilter as Database) : getDb();
  const filter = isDb ? maybeFilter : (explicitDbOrFilter as { profileId?: string | null; profile_id?: string | null } | undefined);
  ensureEmailTables(db);

  const profileId = filter ? (filter.profileId !== undefined ? filter.profileId : filter.profile_id) : undefined;
  let rows: Record<string, unknown>[];
  if (profileId !== undefined) {
    if (profileId === null) {
      rows = db.prepare('SELECT * FROM email_accounts WHERE profile_id IS NULL ORDER BY created_at DESC').all() as Record<string, unknown>[];
    } else {
      rows = db.prepare('SELECT * FROM email_accounts WHERE profile_id = ? ORDER BY created_at DESC').all(profileId) as Record<string, unknown>[];
    }
  } else {
    rows = db.prepare('SELECT * FROM email_accounts ORDER BY created_at DESC').all() as Record<string, unknown>[];
  }
  return rows.map(toMasked);
}

export async function getAccount(
  dbOrId: Database | string,
  maybeId?: string
): Promise<EmailAccountMasked | null> {
  const isDbFirst = maybeId !== undefined;
  const db = isDbFirst ? (dbOrId as Database) : getDb();
  const id = isDbFirst ? maybeId : (dbOrId as string);
  ensureEmailTables(db);
  const row = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return toMasked(row);
}

export async function updateAccount(
  dbOrId: Database | string,
  idOrInput: string | UpdateEmailAccountInput,
  maybeInput?: UpdateEmailAccountInput
): Promise<EmailAccountMasked | null> {
  const isDbFirst = maybeInput !== undefined;
  const db = isDbFirst ? (dbOrId as Database) : getDb();
  const id = isDbFirst ? (idOrInput as string) : (dbOrId as string);
  const input = isDbFirst ? maybeInput : (idOrInput as UpdateEmailAccountInput);
  ensureEmailTables(db);
  const existing = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return null;

  if (input.profile_id !== undefined) {
    validateProfileId(db, input.profile_id);
  }

  const now = Date.now();
  const label = input.label !== undefined ? input.label : existing.label;
  const email = input.email !== undefined ? input.email : existing.email;
  const host = input.host !== undefined ? input.host : existing.host;
  const port = input.port !== undefined ? input.port : existing.port;
  const username = input.username !== undefined ? input.username : existing.username;
  const passwordEnc = input.password !== undefined ? (input.password ? protectSecret(input.password) : null) : existing.password_enc;
  const displayName = input.display_name !== undefined ? input.display_name : existing.display_name;
  const signature = input.signature !== undefined ? input.signature : existing.signature;
  const smtpHost = input.smtp_host !== undefined ? input.smtp_host : existing.smtp_host;
  const smtpPort = input.smtp_port !== undefined ? input.smtp_port : existing.smtp_port;
  const smtpSecure = input.smtp_secure !== undefined
    ? (input.smtp_secure !== null ? (input.smtp_secure ? 1 : 0) : null)
    : existing.smtp_secure;
  const profileId = input.profile_id !== undefined ? input.profile_id : existing.profile_id;

  db.prepare(`
    UPDATE email_accounts
    SET label = ?, email = ?, host = ?, port = ?, username = ?, password_enc = ?, updated_at = ?,
        display_name = ?, signature = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?, profile_id = ?
    WHERE id = ?
  `).run(label, email, host, port, username, passwordEnc, now, displayName, signature, smtpHost, smtpPort, smtpSecure, profileId, id);

  const row = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id) as Record<string, unknown>;
  return toMasked(row);
}

export async function deleteAccount(
  dbOrId: Database | string,
  maybeId?: string
): Promise<boolean> {
  const isDbFirst = maybeId !== undefined;
  const db = isDbFirst ? (dbOrId as Database) : getDb();
  const id = isDbFirst ? maybeId : (dbOrId as string);
  ensureEmailTables(db);
  db.prepare('DELETE FROM email_drafts WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM email_outbox WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM email_messages_cache WHERE account_id = ?').run(id);
  const res = db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id) as { changes?: number };
  return Boolean(res && res.changes !== 0);
}

export async function revealAccountPassword(
  dbOrId: Database | string,
  maybeId?: string
): Promise<string | null> {
  const isDbFirst = maybeId !== undefined;
  const db = isDbFirst ? (dbOrId as Database) : getDb();
  const id = isDbFirst ? maybeId : (dbOrId as string);
  ensureEmailTables(db);
  const row = db.prepare('SELECT password_enc FROM email_accounts WHERE id = ?').get(id) as { password_enc?: string | null } | undefined;
  if (!row || !row.password_enc) return null;
  const plaintext = revealSecret(row.password_enc);
  return plaintext ?? null;
}

export async function bindProfile(
  dbOrAccountId: Database | string,
  accountIdOrProfileId: string | null,
  maybeProfileId?: string | null
): Promise<EmailAccountMasked> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : getDb();
  const accountId = isDbFirst ? (accountIdOrProfileId as string) : (dbOrAccountId as string);
  const profileId = isDbFirst ? (maybeProfileId ?? null) : (accountIdOrProfileId ?? null);
  ensureEmailTables(db);

  validateProfileId(db, profileId);

  const existing = db.prepare('SELECT id FROM email_accounts WHERE id = ?').get(accountId);
  if (!existing) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const now = Date.now();
  db.prepare('UPDATE email_accounts SET profile_id = ?, updated_at = ? WHERE id = ?').run(profileId, now, accountId);
  const row = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId) as Record<string, unknown>;
  return toMasked(row);
}

export async function saveDraft(
  dbOrAccountId: Database | string,
  accountIdOrDraft: string | DraftInput,
  maybeDraft?: DraftInput,
  maybeDb?: Database
): Promise<Draft> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? (accountIdOrDraft as string) : (dbOrAccountId as string);
  const draft = isDbFirst ? maybeDraft! : (accountIdOrDraft as DraftInput);
  ensureEmailTables(db);

  const existingAccount = db.prepare('SELECT id FROM email_accounts WHERE id = ?').get(accountId);
  if (!existingAccount) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const id = draft.id || randomUUID();
  const now = Date.now();
  const toAddrs = formatAddrs(draft.to ?? draft.to_addrs);
  const cc = draft.cc ? formatAddrs(draft.cc) : null;
  const bcc = draft.bcc ? formatAddrs(draft.bcc) : null;
  const subject = draft.subject ?? '';
  const bodyText = draft.bodyText ?? draft.body_text ?? null;
  const bodyHtml = draft.bodyHtml ?? draft.body_html ?? null;
  const inReplyTo = draft.inReplyTo ?? draft.in_reply_to ?? null;

  const existing = db.prepare('SELECT id, account_id FROM email_drafts WHERE id = ?').get(id) as
    | { id: string; account_id: string }
    | undefined;
  if (existing && existing.account_id !== accountId) {
    // A caller-supplied id owned by another account: refuse rather than return
    // foreign data as a successful save.
    throw new Error(`Draft not found in this account: ${id}`);
  }
  if (existing) {
    db.prepare(`
      UPDATE email_drafts
      SET to_addrs = ?, cc = ?, bcc = ?, subject = ?, body_text = ?, body_html = ?, in_reply_to = ?, updated_at = ?
      WHERE id = ? AND account_id = ?
    `).run(toAddrs, cc, bcc, subject, bodyText, bodyHtml, inReplyTo, now, id, accountId);
  } else {
    db.prepare(`
      INSERT INTO email_drafts (id, account_id, to_addrs, cc, bcc, subject, body_text, body_html, in_reply_to, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, accountId, toAddrs, cc, bcc, subject, bodyText, bodyHtml, inReplyTo, now);
  }

  const row = db.prepare('SELECT * FROM email_drafts WHERE id = ? AND account_id = ?').get(id, accountId) as Record<string, unknown>;
  return toDraft(row);
}

export async function listDrafts(
  dbOrAccountId: Database | string,
  maybeAccountId?: string,
  maybeDb?: Database
): Promise<Draft[]> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? maybeAccountId! : (dbOrAccountId as string);
  ensureEmailTables(db);

  const rows = db.prepare('SELECT * FROM email_drafts WHERE account_id = ? ORDER BY updated_at DESC').all(accountId) as Record<string, unknown>[];
  return rows.map(toDraft);
}

export async function deleteDraft(
  dbOrAccountId: Database | string,
  accountIdOrDraftId: string,
  maybeDraftId?: string,
  maybeDb?: Database
): Promise<boolean> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? accountIdOrDraftId : (dbOrAccountId as string);
  const draftId = isDbFirst ? maybeDraftId! : accountIdOrDraftId;
  ensureEmailTables(db);

  const res = db.prepare('DELETE FROM email_drafts WHERE id = ? AND account_id = ?').run(draftId, accountId) as { changes?: number };
  return Boolean(res && res.changes !== 0);
}

export async function recordOutbox(
  dbOrAccountId: Database | string,
  accountIdOrData: string | {
    to: string[] | string;
    to_addrs?: string[] | string;
    subject?: string;
    status: 'sent' | 'failed' | string;
    providerMsgId?: string | null;
    provider_msg_id?: string | null;
    error?: string | null;
  },
  maybeData?: {
    to: string[] | string;
    to_addrs?: string[] | string;
    subject?: string;
    status: 'sent' | 'failed' | string;
    providerMsgId?: string | null;
    provider_msg_id?: string | null;
    error?: string | null;
  },
  maybeDb?: Database
): Promise<OutboxRow> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? (accountIdOrData as string) : (dbOrAccountId as string);
  const data = isDbFirst ? maybeData! : (accountIdOrData as {
    to: string[] | string;
    to_addrs?: string[] | string;
    subject?: string;
    status: 'sent' | 'failed' | string;
    providerMsgId?: string | null;
    provider_msg_id?: string | null;
    error?: string | null;
  });
  ensureEmailTables(db);

  const id = randomUUID();
  const toAddrs = formatAddrs(data.to ?? data.to_addrs);
  const subject = data.subject ?? '';
  const status = data.status;
  const providerMsgId = data.providerMsgId ?? data.provider_msg_id ?? null;
  const error = data.error ?? null;
  const createdAt = Date.now();

  db.prepare(`
    INSERT INTO email_outbox (id, account_id, to_addrs, subject, status, provider_msg_id, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, accountId, toAddrs, subject, status, providerMsgId, error, createdAt);

  const row = db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(id) as Record<string, unknown>;
  return toOutboxRow(row);
}

export async function listOutbox(
  dbOrAccountId: Database | string,
  maybeAccountId?: string,
  maybeDb?: Database
): Promise<OutboxRow[]> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? maybeAccountId! : (dbOrAccountId as string);
  ensureEmailTables(db);

  const rows = db.prepare('SELECT * FROM email_outbox WHERE account_id = ? ORDER BY created_at DESC').all(accountId) as Record<string, unknown>[];
  return rows.map(toOutboxRow);
}

export function extractCodes(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const found: string[] = [];
  const add = (val: string) => {
    const trimmed = val.trim();
    if (trimmed && !found.includes(trimmed)) {
      found.push(trimmed);
    }
  };

  // 1. URLs for confirmation/verification links
  const urlRegex = /https?:\/\/[^\s<>"')]+(?:confirm|verify|token|activate|validate|code=)[^\s<>"')]+/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    add(match[0]);
  }

  // 2. Explicit code labels (e.g. "verification code is 482910", "code: A9B2-C3D4", "code: 123456")
  const labelRegex = /(?:verification\s+code|security\s+code|confirm(?:ation)?\s+code|passcode|one-time\s+password|otp|pin|auth(?:entication)?\s+code|код(?:\s+подтверждения)?|проверочный\s+код)[\s:=]+([A-Z0-9]{4,10}(?:-[A-Z0-9]{3,6})?)/gi;
  while ((match = labelRegex.exec(text)) !== null) {
    const code = match[1];
    if (code && !/^(?:the|this|that|your|here)$/i.test(code)) {
      add(code);
    }
  }

  // 3. Hyphenated 6-digit or 8-char codes: 123-456, ABCD-EFGH
  const hyphenRegex = /\b([0-9]{3}-[0-9]{3})\b/g;
  while ((match = hyphenRegex.exec(text)) !== null) {
    add(match[1]);
    add(match[1].replace('-', ''));
  }

  const hyphenAlphaRegex = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/g;
  while ((match = hyphenAlphaRegex.exec(text)) !== null) {
    add(match[1]);
    add(match[1].replace('-', ''));
  }
  // 4. Standalone 6-digit numeric codes (e.g. 123456, 849201)
  const sixDigitRegex = /\b(?<![-#])([0-9]{6})\b(?![-#])/g;
  while ((match = sixDigitRegex.exec(text)) !== null) {
    const num = match[1];
    // filter out plausible dates like 202609
    add(num);
  }

  // 5. Standalone 8-character alphanumeric codes with mixed digits/letters (e.g. X7K9P2M4, 8F3K9L2P)
  const eightCharRegex = /\b([A-Z0-9]{8})\b/g;
  while ((match = eightCharRegex.exec(text)) !== null) {
    const candidate = match[1];
    // Require at least one digit and uppercase letters to avoid common 8-letter English words
    const hasDigit = /[0-9]/.test(candidate);
    const hasAlpha = /[A-Z]/.test(candidate);
    if (hasDigit && hasAlpha) {
      add(candidate);
    }
  }

  return found;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function decodeTransferEncoding(content: string, enc: string): string {
  const normalized = enc.toLowerCase().trim();
  if (normalized === 'base64') {
    try {
      return Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return content;
    }
  }
  if (normalized === 'quoted-printable') {
    return content
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return content;
}

function parseMimeEntity(headerText: string, bodyText: string): { text?: string; html?: string } {
  const ctMatch = headerText.match(/Content-Type:\s*([^;\r\n]+)/i);
  const contentType = (ctMatch ? ctMatch[1] : 'text/plain').trim().toLowerCase();

  const cteMatch = headerText.match(/Content-Transfer-Encoding:\s*([^\s;\r\n]+)/i);
  const encoding = (cteMatch ? cteMatch[1] : '').trim().toLowerCase();

  if (contentType.startsWith('multipart/')) {
    const boundaryMatch = headerText.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
    const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : null;
    if (boundary) {
      const boundaryDelimiter = `--${boundary}`;
      const rawParts = bodyText.split(boundaryDelimiter);
      let foundText: string | undefined;
      let foundHtml: string | undefined;

      for (const rawPart of rawParts) {
        const trimmed = rawPart.trim();
        if (!trimmed || trimmed === '--') continue;
        const partEnd = rawPart.search(/\r?\n\r?\n/);
        if (partEnd === -1) continue;
        const partHeaders = rawPart.slice(0, partEnd);
        const partBody = rawPart.slice(partEnd).replace(/^\r?\n\r?\n/, '');
        const res = parseMimeEntity(partHeaders, partBody);
        if (res.text && !foundText) foundText = res.text;
        if (res.html && !foundHtml) foundHtml = res.html;
      }
      return {
        text: foundText ?? (foundHtml ? stripHtml(foundHtml) : undefined),
        html: foundHtml,
      };
    }
  }

  const decoded = decodeTransferEncoding(bodyText, encoding);
  if (contentType === 'text/html') {
    return { html: decoded, text: stripHtml(decoded) };
  }
  if (contentType === 'text/plain') {
    return { text: decoded };
  }
  return { text: decoded };
}

export function extractMimeParts(raw: string): { text: string; html?: string } {
  if (!raw || typeof raw !== 'string') {
    return { text: '' };
  }

  const headerEnd = raw.search(/\r?\n\r?\n/);
  if (headerEnd === -1) {
    return { text: raw };
  }

  const headerText = raw.slice(0, headerEnd);
  const bodyText = raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '');

  if (!/(?:Content-Type|MIME-Version|Subject|From|To):/i.test(headerText)) {
    return { text: raw };
  }

  const entity = parseMimeEntity(headerText, bodyText);
  return {
    text: entity.text ?? (entity.html ? stripHtml(entity.html) : raw),
    html: entity.html,
  };
}

export class SimpleImapSession {
  private socket: net.Socket | null = null;
  private buffer = '';
  private tagCounter = 1;

  async connect(host: string, port: number, socketFactory?: SocketFactory | null): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onConnect = () => {
      resolve();
    };

    if (socketFactory) {
      this.socket = socketFactory({ host, port, tls: port === 993 });
      this.socket.on('connect', onConnect);
      if (this.socket.connecting === false && !this.socket.destroyed) {
        setTimeout(onConnect, 5);
      }
    } else if (port === 993) {
      this.socket = tls.connect({ host, port, rejectUnauthorized: false }, onConnect);
    } else {
      this.socket = net.connect({ host, port }, onConnect);
    }

    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
    });

    this.socket.on('error', (err) => {
      reject(err);
    });

    return promise;
  }

  async readUntilTag(tag: string, timeoutMs = 5000): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const start = Date.now();
    const check = () => {
      const regex = new RegExp(`^${tag}\\s+(OK|NO|BAD).*$`, 'm');
      const m = this.buffer.match(regex);
      if (m) {
        const matchIndex = this.buffer.indexOf(m[0]);
        const endIndex = matchIndex + m[0].length;
        const result = this.buffer.slice(0, endIndex);
        this.buffer = this.buffer.slice(endIndex);
        if (m[1] === 'OK') {
          resolve(result);
        } else {
          reject(new Error(`IMAP command failed: ${m[0]}`));
        }
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`IMAP command timed out waiting for tag ${tag}`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
    return promise;
  }

  async sendCommand(cmd: string, timeoutMs = 5000): Promise<string> {
    const tag = `A${String(this.tagCounter++).padStart(3, '0')}`;
    const line = `${tag} ${cmd}\r\n`;
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Socket is not connected');
    }
    this.socket.write(line);
    return this.readUntilTag(tag, timeoutMs);
  }

  async readBanner(timeoutMs = 3000): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    const start = Date.now();
    const check = () => {
      if (this.buffer.includes('* OK') || this.buffer.includes('* PREAUTH')) {
        const newline = this.buffer.indexOf('\n');
        const banner = this.buffer.slice(0, newline + 1);
        this.buffer = this.buffer.slice(newline + 1);
        resolve(banner);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve('');
        return;
      }
      setTimeout(check, 20);
    };
    check();
    return promise;
  }

  async waitForContinuation(tag: string, timeoutMs = 3000): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const start = Date.now();
    const check = () => {
      // A '+' anywhere starts a continuation line per RFC 3501; consume through EOL.
      if (this.buffer.includes('+')) {
        const idx = this.buffer.indexOf('+');
        const nl = this.buffer.indexOf('\n', idx);
        if (nl !== -1) {
          this.buffer = this.buffer.slice(nl + 1);
        } else {
          this.buffer = this.buffer.slice(idx + 1);
        }
        resolve();
        return;
      }
      // Server rejected the APPEND header (NO/BAD): fail BEFORE writing MIME bytes,
      // or the payload lands on the wire as invalid IMAP commands.
      const tagged = this.buffer.match(new RegExp(`^${tag}\\s+(OK|NO|BAD)(.*)$`, 'm'));
      if (tagged) {
        const [, status, rest] = tagged;
        if (status === 'OK') {
          resolve();
        } else {
          reject(new Error(`IMAP APPEND rejected: ${tag} ${status}${rest}`));
        }
        return;
      }
      if (Date.now() - start > timeoutMs) {
        // No continuation and no tagged reply: proceed — some servers accept
        // the literal without an explicit continuation request.
        resolve();
        return;
      }
      setTimeout(check, 20);
    };
    check();
    return promise;
  }

  async list(reference = '""', mailbox = '"*"', timeoutMs = 5000): Promise<string> {
    return this.sendCommand(`LIST ${reference} ${mailbox}`, timeoutMs);
  }

  async status(folder: string, items = '(UNSEEN)', timeoutMs = 5000): Promise<string> {
    return this.sendCommand(`STATUS "${folder}" ${items}`, timeoutMs);
  }

  async search(criteria: string, timeoutMs = 5000): Promise<string> {
    return this.sendCommand(`UID SEARCH ${criteria}`, timeoutMs);
  }

  async store(uid: string, action: string, flags: string, timeoutMs = 5000): Promise<string> {
    return this.sendCommand(`UID STORE ${uid} ${action} (${flags})`, timeoutMs);
  }

  async append(folder: string, raw: string, flags?: string[], timeoutMs = 10000): Promise<string> {
    const tag = `A${String(this.tagCounter++).padStart(3, '0')}`;
    const flagsStr = flags && flags.length > 0 ? ` (${flags.join(' ')})` : '';
    const rawBuffer = Buffer.from(raw, 'utf8');
    const header = `${tag} APPEND "${folder}"${flagsStr} {${rawBuffer.length}}\r\n`;
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Socket is not connected');
    }
    this.socket.write(header);
    await this.waitForContinuation(tag, 3000);
    this.socket.write(rawBuffer);
    this.socket.write('\r\n');
    return this.readUntilTag(tag, timeoutMs);
  }

  close(): void {
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(`A${String(this.tagCounter++).padStart(3, '0')} LOGOUT\r\n`);
      } catch {
        // ignore
      }
      this.socket.end();
      this.socket.destroy();
    }
    this.socket = null;
    this.buffer = '';
  }
}

export type SExpValue = string | null | SExpValue[];

function parseSExp(str: string): SExpValue {
  let pos = 0;
  function skipWhitespace(): void {
    while (pos < str.length && /\s/.test(str[pos])) pos++;
  }
  function parseItem(): SExpValue {
    skipWhitespace();
    if (pos >= str.length) return null;
    if (str[pos] === '(') {
      pos++;
      const list: SExpValue[] = [];
      while (pos < str.length) {
        skipWhitespace();
        if (str[pos] === ')') {
          pos++;
          break;
        }
        list.push(parseItem());
      }
      return list;
    } else if (str[pos] === '"') {
      pos++;
      let res = '';
      while (pos < str.length) {
        if (str[pos] === '\\') {
          pos++;
          if (pos < str.length) res += str[pos++];
        } else if (str[pos] === '"') {
          pos++;
          break;
        } else {
          res += str[pos++];
        }
      }
      return res;
    } else {
      let res = '';
      while (pos < str.length && !/[\s()]/.test(str[pos])) {
        res += str[pos++];
      }
      return res.toUpperCase() === 'NIL' ? null : res;
    }
  }
  return parseItem();
}

function parseEnvelopeResponses(raw: string): EmailMessageSummary[] {
  const list: EmailMessageSummary[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('*')) continue;
    const uidMatch = line.match(/\bUID\s+(\d+)\b/i);
    const uid = uidMatch ? uidMatch[1] : '';
    if (!uid) continue;

    let subject = '(No Subject)';
    let from = 'unknown';
    let date = '';

    const flagsMatch = line.match(/\bFLAGS\s+\(([^)]*)\)/i);
    const flagList = flagsMatch ? flagsMatch[1].split(/\s+/).filter(Boolean) : [];
    const seen = flagList.some((f) => /\\seen/i.test(f));
    const flagged = flagList.some((f) => /\\flagged/i.test(f));
    const answered = flagList.some((f) => /\\answered/i.test(f));

    const envIdx = line.indexOf('ENVELOPE');
    if (envIdx !== -1) {
      const envSexp = parseSExp(line.substring(envIdx + 'ENVELOPE'.length).trim());
      if (Array.isArray(envSexp)) {
        if (typeof envSexp[0] === 'string' && envSexp[0]) {
          date = envSexp[0];
        }
        if (typeof envSexp[1] === 'string' && envSexp[1]) {
          subject = envSexp[1];
        }
        if (Array.isArray(envSexp[2]) && envSexp[2].length > 0) {
          const firstAddr = envSexp[2][0];
          if (Array.isArray(firstAddr) && firstAddr.length >= 4) {
            const mailbox = firstAddr[2];
            const host = firstAddr[3];
            if (mailbox && host) {
              from = `${mailbox}@${host}`;
            } else if (mailbox) {
              from = String(mailbox);
            }
          }
        }
      }
    }

    list.push({ uid, subject, from, date, flags: flagList, seen, flagged, answered });
  }
  return list;
}

function parseBodyResponse(raw: string): string {
  const literalMatch = raw.match(/BODY(?:\[\]|\.PEEK\[\])?\s*\{(\d+)\}\r?\n/i);
  if (literalMatch && literalMatch.index !== undefined) {
    const len = parseInt(literalMatch[1], 10);
    const start = literalMatch.index + literalMatch[0].length;
    return raw.substring(start, start + len);
  }

  const quotedMatch = raw.match(/BODY(?:\[\]|\.PEEK\[\])?\s*"([^"]*)"/i);
  if (quotedMatch) {
    return quotedMatch[1];
  }

  return raw.replace(/^\* \d+ FETCH \(.*?\r?\n/i, '').replace(/\)\r?\n[A-Z0-9]+ OK.*$/s, '').trim();
}

export async function listInbox(
  dbOrAccountId: Database | string,
  accountIdOrSocketFactory?: string | SocketFactory,
  maybeSocketFactory?: SocketFactory
): Promise<InboxResult> {
  // Legacy entry point: INBOX listing with the old no-flags FETCH shape preserved
  // via listMessages (same SELECT, same envelope parse, same cache fallback).
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? dbOrAccountId : getDb();
  const accountId = isDbFirst ? (accountIdOrSocketFactory as string) : dbOrAccountId;
  const socketFactory = isDbFirst ? maybeSocketFactory : (accountIdOrSocketFactory as SocketFactory | undefined);
  // SAFETY: listMessages overload takes the factory in the queryOrSocketFactory slot
  // (typeof function branch); undefined falls through to the global custom factory.
  return listMessages(db, accountId, 'INBOX', socketFactory as unknown as string);
}

export async function listFolders(
  dbOrAccountId: Database | string,
  accountIdOrSocketFactory?: string | SocketFactory,
  maybeSocketFactory?: SocketFactory,
  maybeDb?: Database
): Promise<{ name: string; unread: number }[]> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? (accountIdOrSocketFactory as string) : (dbOrAccountId as string);
  const socketFactory = isDbFirst
    ? maybeSocketFactory
    : (typeof accountIdOrSocketFactory === 'function' ? accountIdOrSocketFactory : maybeSocketFactory);
  ensureEmailTables(db);

  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId) as Record<string, unknown> | undefined;
  if (!account) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const password = account.password_enc ? revealSecret(String(account.password_enc)) : '';
  const factory = socketFactory ?? customSocketFactory;

  const session = new SimpleImapSession();
  try {
    await session.connect(String(account.host), Number(account.port) || 993, factory);
    await session.readBanner();

    await session.sendCommand(`LOGIN "${account.username}" "${password}"`);
    const listRes = await session.list('""', '"*"');

    const folderMap = new Map<string, { name: string; unread: number; noselect: boolean }>();
    const lines = listRes.split(/\r?\n/);
    const listLineRegex = /^\*\s+LIST\s+\((.*?)\)\s+(?:"([^"]*)"|NIL)\s+(?:"([^"]*)"|(\S+))/i;

    for (const line of lines) {
      const m = line.match(listLineRegex);
      if (!m) continue;
      const flagsStr = m[1] || '';
      const folderName = (m[3] !== undefined ? m[3] : m[4]) || '';
      if (!folderName) continue;
      const noselect = /\\noselect/i.test(flagsStr);
      folderMap.set(folderName, { name: folderName, unread: 0, noselect });
    }

    if (!folderMap.has('INBOX')) {
      folderMap.set('INBOX', { name: 'INBOX', unread: 0, noselect: false });
    }

    for (const [name, folder] of folderMap.entries()) {
      if (folder.noselect) continue;
      try {
        const statusRes = await session.status(name, '(UNSEEN)');
        const unseenMatch = statusRes.match(/UNSEEN\s+(\d+)/i);
        if (unseenMatch) {
          folder.unread = parseInt(unseenMatch[1], 10);
        }
      } catch {
        folder.unread = 0;
      }
    }

    session.close();
    return Array.from(folderMap.values()).map((f) => ({ name: f.name, unread: f.unread }));
  } catch (err) {
    session.close();
    const cachedRows = db.prepare(`
      SELECT DISTINCT folder FROM email_messages_cache WHERE account_id = ?
    `).all(accountId) as Array<{ folder?: string | null }>;

    if (cachedRows.length > 0) {
      return cachedRows.map((r) => ({ name: r.folder || 'INBOX', unread: 0 }));
    }
    throw err;
  }
}

export async function listMessages(
  dbOrAccountId: Database | string,
  accountIdOrFolder = 'INBOX',
  folderOrQuery?: string,
  queryOrSocketFactory?: string | SocketFactory,
  maybeSocketFactory?: SocketFactory,
  maybeDb?: Database
): Promise<InboxResult> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? accountIdOrFolder : (dbOrAccountId as string);
  const folder = isDbFirst
    ? (folderOrQuery ?? 'INBOX')
    : (accountIdOrFolder && accountIdOrFolder !== accountId ? accountIdOrFolder : 'INBOX');
  const query = isDbFirst
    ? (typeof queryOrSocketFactory === 'string' ? queryOrSocketFactory : undefined)
    : folderOrQuery;
  const socketFactory = isDbFirst
    ? (typeof queryOrSocketFactory === 'function' ? queryOrSocketFactory : maybeSocketFactory)
    : (typeof queryOrSocketFactory === 'function' ? queryOrSocketFactory : maybeSocketFactory);

  ensureEmailTables(db);

  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId) as Record<string, unknown> | undefined;
  if (!account) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const password = account.password_enc ? revealSecret(String(account.password_enc)) : '';
  const factory = socketFactory ?? customSocketFactory;

  const session = new SimpleImapSession();
  try {
    await session.connect(String(account.host), Number(account.port) || 993, factory);
    await session.readBanner();

    await session.sendCommand(`LOGIN "${account.username}" "${password}"`);
    const selectRes = await session.sendCommand(`SELECT "${folder}"`);

    let messages: EmailMessageSummary[] = [];

    if (query && query.trim()) {
      const q = query.trim();
      const standardKeywords = /^(ALL|UNSEEN|SEEN|FLAGGED|UNFLAGGED|ANSWERED|UNANSWERED|DELETED|NEW|OLD|RECENT|FROM|TO|SUBJECT|BODY|TEXT)\b/i;
      const searchCriteria = standardKeywords.test(q) ? q : `TEXT "${q.replace(/"/g, '\\"')}"`;
      const searchRes = await session.search(searchCriteria);
      const uids = searchRes.replace(/^\*\s+SEARCH/im, '').trim().split(/\s+/).filter(Boolean);

      if (uids.length > 0) {
        const fetchRes = await session.sendCommand(`UID FETCH ${uids.join(',')} (UID FLAGS ENVELOPE)`);
        messages = parseEnvelopeResponses(fetchRes);
      }
    } else {
      // P3: on an empty folder strict servers reject `UID FETCH 1:*` with NO/BAD.
      // The SELECT reply above carries `* N EXISTS` — zero means "empty", not an error.
      const existsMatch = selectRes.match(/^\*\s+(\d+)\s+EXISTS/im);
      if (existsMatch && Number(existsMatch[1]) === 0) {
        session.close();
        return { messages: [], cached: false };
      }
      const fetchRes = await session.sendCommand('UID FETCH 1:* (UID FLAGS ENVELOPE)');
      messages = parseEnvelopeResponses(fetchRes);
    }

    for (const msg of messages) {
      db.prepare(`
        INSERT INTO email_messages_cache (id, account_id, uid, subject, from_addr, date, created_at, folder, flags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, folder, uid) DO UPDATE SET
          subject = excluded.subject,
          from_addr = excluded.from_addr,
          date = excluded.date,
          folder = excluded.folder,
          flags = excluded.flags
      `).run(randomUUID(), accountId, msg.uid, msg.subject, msg.from, msg.date, Date.now(), folder, JSON.stringify(msg.flags ?? []));
    }

    session.close();
    return { messages, cached: false };
  } catch (err) {
    session.close();
    const reason = err instanceof Error ? err.message : String(err);
    const cachedRows = db.prepare(`
      SELECT uid, subject, from_addr as "from", date, flags
      FROM email_messages_cache
      WHERE account_id = ? AND (folder = ? OR folder IS NULL)
      ORDER BY created_at DESC
    `).all(accountId, folder) as Array<{ uid: string; subject: string; from: string; date: string; flags?: string | null }>;

    const messages: EmailMessageSummary[] = cachedRows.map((r) => {
      let flagList: string[] = [];
      try {
        flagList = r.flags ? JSON.parse(r.flags) : [];
      } catch {
        // ignore
      }
      return {
        uid: r.uid,
        subject: r.subject,
        from: r.from,
        date: r.date,
        flags: flagList,
        seen: flagList.some((f) => /\\seen/i.test(f)),
        flagged: flagList.some((f) => /\\flagged/i.test(f)),
        answered: flagList.some((f) => /\\answered/i.test(f)),
      };
    });

    return { messages, cached: true, error: reason };
  }
}

export async function setMessageFlags(
  dbOrAccountId: Database | string,
  accountIdOrFolder: string,
  folderOrUid: string,
  uidOrFlags: string | { seen?: boolean; flagged?: boolean; answered?: boolean },
  maybeFlagsOrSocketFactory?: { seen?: boolean; flagged?: boolean; answered?: boolean } | SocketFactory,
  maybeSocketFactory?: SocketFactory,
  maybeDb?: Database
): Promise<void> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? accountIdOrFolder : (dbOrAccountId as string);
  const folder = isDbFirst ? folderOrUid : accountIdOrFolder;
  const uid = isDbFirst ? (uidOrFlags as string) : folderOrUid;
  const flags = isDbFirst
    ? (maybeFlagsOrSocketFactory as { seen?: boolean; flagged?: boolean; answered?: boolean })
    : (uidOrFlags as { seen?: boolean; flagged?: boolean; answered?: boolean });
  const socketFactory = isDbFirst
    ? maybeSocketFactory
    : (typeof maybeFlagsOrSocketFactory === 'function' ? maybeFlagsOrSocketFactory : maybeSocketFactory);

  ensureEmailTables(db);

  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId) as Record<string, unknown> | undefined;
  if (!account) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const password = account.password_enc ? revealSecret(String(account.password_enc)) : '';
  const factory = socketFactory ?? customSocketFactory;

  const session = new SimpleImapSession();
  try {
    await session.connect(String(account.host), Number(account.port) || 993, factory);
    await session.readBanner();

    await session.sendCommand(`LOGIN "${account.username}" "${password}"`);
    await session.sendCommand(`SELECT "${folder}"`);

    const addFlags: string[] = [];
    const remFlags: string[] = [];
    if (flags.seen === true) addFlags.push('\\Seen');
    if (flags.seen === false) remFlags.push('\\Seen');
    if (flags.flagged === true) addFlags.push('\\Flagged');
    if (flags.flagged === false) remFlags.push('\\Flagged');
    if (flags.answered === true) addFlags.push('\\Answered');
    if (flags.answered === false) remFlags.push('\\Answered');

    if (addFlags.length > 0) {
      await session.store(uid, '+FLAGS', addFlags.join(' '));
    }
    if (remFlags.length > 0) {
      await session.store(uid, '-FLAGS', remFlags.join(' '));
    }

    // Update local cache
    const cachedRow = db.prepare('SELECT flags FROM email_messages_cache WHERE account_id = ? AND folder = ? AND uid = ?').get(accountId, folder, uid) as { flags?: string | null } | undefined;
    if (cachedRow) {
      let currentFlags: string[] = [];
      try {
        currentFlags = cachedRow.flags ? JSON.parse(cachedRow.flags) : [];
      } catch {
        // ignore
      }
      for (const f of addFlags) {
        if (!currentFlags.some((cf) => cf.toLowerCase() === f.toLowerCase())) currentFlags.push(f);
      }
      for (const f of remFlags) {
        currentFlags = currentFlags.filter((cf) => cf.toLowerCase() !== f.toLowerCase());
      }
      db.prepare('UPDATE email_messages_cache SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?').run(JSON.stringify(currentFlags), accountId, folder, uid);
    }

    session.close();
  } catch (err) {
    session.close();
    throw err;
  }
}

export async function appendMessage(
  dbOrAccountId: Database | string,
  accountIdOrFolder: string,
  folderOrRaw: string,
  maybeRawOrSocketFactory?: string | SocketFactory,
  maybeSocketFactory?: SocketFactory,
  maybeDb?: Database
): Promise<void> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : (maybeDb ?? getDb());
  const accountId = isDbFirst ? accountIdOrFolder : (dbOrAccountId as string);
  const folder = isDbFirst ? folderOrRaw : accountIdOrFolder;
  const raw = isDbFirst ? (maybeRawOrSocketFactory as string) : folderOrRaw;
  const socketFactory = isDbFirst
    ? maybeSocketFactory
    : (typeof maybeRawOrSocketFactory === 'function' ? maybeRawOrSocketFactory : maybeSocketFactory);

  ensureEmailTables(db);

  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId) as Record<string, unknown> | undefined;
  if (!account) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const password = account.password_enc ? revealSecret(String(account.password_enc)) : '';
  const factory = socketFactory ?? customSocketFactory;

  const session = new SimpleImapSession();
  try {
    await session.connect(String(account.host), Number(account.port) || 993, factory);
    await session.readBanner();

    await session.sendCommand(`LOGIN "${account.username}" "${password}"`);
    await session.append(folder, raw, ['\\Seen']);
    session.close();
  } catch (err) {
    session.close();
    throw err;
  }
}

export async function readMessage(
  dbOrAccountId: Database | string,
  accountIdOrUid: string,
  uidOrFolderOrFactory?: string | SocketFactory,
  folderOrFactory?: string | SocketFactory,
  maybeSocketFactory?: SocketFactory
): Promise<EmailMessageDetail> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? dbOrAccountId : getDb();
  const accountId = isDbFirst ? accountIdOrUid : dbOrAccountId;
  // Overloads: (db, id, uid, [folder], [factory]) and (id, uid, [folder], [factory]);
  // a function in the folder slot is the socket factory (old 3-arg call shape).
  const uid = isDbFirst ? (uidOrFolderOrFactory as string) : accountIdOrUid;
  const folder = isDbFirst
    ? (typeof folderOrFactory === 'string' ? folderOrFactory : 'INBOX')
    : (typeof uidOrFolderOrFactory === 'string' ? uidOrFolderOrFactory : 'INBOX');
  const socketFactory = isDbFirst
    ? (typeof folderOrFactory === 'function' ? folderOrFactory : maybeSocketFactory)
    : (typeof folderOrFactory === 'function'
      ? folderOrFactory
      : (typeof uidOrFolderOrFactory === 'function' ? uidOrFolderOrFactory : maybeSocketFactory));
  ensureEmailTables(db);

  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId) as Record<string, unknown> | undefined;
  if (!account) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const cachedRow = db.prepare(`
    SELECT * FROM email_messages_cache WHERE account_id = ? AND folder = ? AND uid = ?
  `).get(accountId, folder, uid) as { id: string; subject: string; from_addr: string; date: string; body?: string | null; flags?: string | null } | undefined;

  const password = account.password_enc ? revealSecret(String(account.password_enc)) : '';
  const factory = socketFactory ?? customSocketFactory;

  const session = new SimpleImapSession();
  try {
    await session.connect(String(account.host), Number(account.port) || 993, factory);
    await session.readBanner();

    await session.sendCommand(`LOGIN "${account.username}" "${password}"`);
    await session.sendCommand(`SELECT "${folder}"`);

    const fetchRes = await session.sendCommand(`UID FETCH ${uid} (UID BODY[])`);
    const rawBody = parseBodyResponse(fetchRes);
    const mime = extractMimeParts(rawBody);

    const now = Date.now();
    const id = cachedRow?.id ?? randomUUID();
    const subject = cachedRow?.subject ?? '(No Subject)';
    const from = cachedRow?.from_addr ?? 'unknown';
    const date = cachedRow?.date ?? '';

    db.prepare(`
      INSERT INTO email_messages_cache (id, account_id, uid, subject, from_addr, date, body, created_at, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, folder, uid) DO UPDATE SET
        body = excluded.body,
        created_at = excluded.created_at
    `).run(id, accountId, uid, subject, from, date, rawBody, now, folder);

    session.close();
    return {
      id,
      accountId,
      uid,
      subject,
      from,
      date,
      body: mime.text || rawBody,
      text: mime.text || rawBody,
      html: mime.html,
      cached: false,
    };
  } catch (err) {
    session.close();
    if (cachedRow && cachedRow.body !== null && cachedRow.body !== undefined) {
      const mime = extractMimeParts(cachedRow.body);
      return {
        id: cachedRow.id,
        accountId,
        uid,
        subject: cachedRow.subject ?? '(No Subject)',
        from: cachedRow.from_addr ?? 'unknown',
        date: cachedRow.date ?? '',
        body: mime.text || cachedRow.body,
        text: mime.text || cachedRow.body,
        html: mime.html,
        cached: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    throw err;
  }
}

export function createImapClient(
  config: { host: string; port?: number; username: string; password?: string },
  socketFactory?: SocketFactory
) {
  return {
    async fetchInbox(): Promise<EmailMessageSummary[]> {
      const session = new SimpleImapSession();
      await session.connect(config.host, config.port ?? 993, socketFactory ?? customSocketFactory);
      await session.readBanner();
      await session.sendCommand(`LOGIN "${config.username}" "${config.password ?? ''}"`);
      await session.sendCommand('SELECT INBOX');
      const fetchRes = await session.sendCommand('UID FETCH 1:* (UID ENVELOPE)');
      const messages = parseEnvelopeResponses(fetchRes);
      session.close();
      return messages;
    },
    async fetchMessageBody(uid: string): Promise<string> {
      const session = new SimpleImapSession();
      await session.connect(config.host, config.port ?? 993, socketFactory ?? customSocketFactory);
      await session.readBanner();
      await session.sendCommand(`LOGIN "${config.username}" "${config.password ?? ''}"`);
      await session.sendCommand('SELECT INBOX');
      const fetchRes = await session.sendCommand(`UID FETCH ${uid} (UID BODY[])`);
      const body = parseBodyResponse(fetchRes);
      session.close();
      return body;
    },
  };
}
