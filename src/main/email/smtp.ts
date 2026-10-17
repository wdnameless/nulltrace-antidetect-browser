import nodemailer from 'nodemailer';
import type { SendMailOptions, Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { randomUUID } from 'crypto';
import { getDb } from '../db';
import type { Database } from '../db';
import { revealAccountPassword, recordOutbox, appendMessage, ensureEmailTables } from './manager';

export interface SendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
}

export type MailTransportFactory = (options: unknown) => Transporter;

let customTransportFactory: MailTransportFactory | null = null;

export function setMailTransportFactory(factory: MailTransportFactory | null): void {
  customTransportFactory = factory;
}

export async function sendMail(
  dbOrAccountId: Database | string,
  accountIdOrDraft: string | SendInput,
  maybeDraft?: SendInput
): Promise<{ messageId: string }> {
  const isDbFirst = typeof dbOrAccountId !== 'string';
  const db = isDbFirst ? (dbOrAccountId as Database) : getDb();
  const accountId = isDbFirst ? (accountIdOrDraft as string) : (dbOrAccountId as string);
  const draft = isDbFirst ? maybeDraft! : (accountIdOrDraft as SendInput);

  ensureEmailTables(db);

  const account = db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(accountId) as Record<string, unknown> | undefined;
  if (!account) {
    throw new Error(`Email account not found: ${accountId}`);
  }

  const password = await revealAccountPassword(db, accountId);

  // 1. From header
  const emailAddr = String(account.email);
  const displayName = account.display_name ? String(account.display_name).trim() : '';
  const fromHeader = displayName ? `"${displayName.replace(/"/g, '\\"')}" <${emailAddr}>` : emailAddr;

  // 2. Append signature if configured
  const signature = account.signature ? String(account.signature) : '';
  let textBody = draft.text;
  let htmlBody = draft.html;

  if (signature) {
    if (textBody !== undefined) {
      textBody = `${textBody}\n\n${signature}`;
    } else if (htmlBody === undefined) {
      textBody = signature;
    }

    if (htmlBody !== undefined) {
      const sigHtml = signature.replace(/\n/g, '<br>');
      htmlBody = `${htmlBody}<br><br>${sigHtml}`;
    }
  }

  // 3. Mail options
  const mailOptions: SendMailOptions = {
    from: fromHeader,
    to: draft.to,
    subject: draft.subject,
  };
  if (draft.cc && draft.cc.length > 0) mailOptions.cc = draft.cc;
  if (draft.bcc && draft.bcc.length > 0) mailOptions.bcc = draft.bcc;
  if (textBody !== undefined) mailOptions.text = textBody;
  if (htmlBody !== undefined) mailOptions.html = htmlBody;
  if (draft.inReplyTo) mailOptions.inReplyTo = draft.inReplyTo;
  if (draft.references && draft.references.length > 0) {
    mailOptions.references = draft.references;
  }

  // 4. Nodemailer transporter configuration
  const host = String(account.smtp_host || account.host);
  const secure = account.smtp_secure != null ? Boolean(account.smtp_secure) : (Number(account.smtp_port) === 465);
  const port = account.smtp_port != null ? Number(account.smtp_port) : (secure ? 465 : 587);
  const authUser = String(account.username || account.email);

  const transportOptions: Record<string, unknown> = {
    host,
    port,
    secure,
  };
  if (authUser && password) {
    transportOptions.auth = {
      user: authUser,
      pass: password,
    };
  }

  try {
    const transporter = customTransportFactory
      ? customTransportFactory(transportOptions)
      : nodemailer.createTransport(transportOptions as nodemailer.TransportOptions);

    const info = await transporter.sendMail(mailOptions);
    const messageId = (info && typeof info === 'object' && 'messageId' in info && typeof info.messageId === 'string' && info.messageId)
      ? info.messageId
      : `<${randomUUID()}@${emailAddr.split('@')[1] || 'local'}>`;

    // Record success in outbox
    await recordOutbox(db, accountId, {
      to: draft.to,
      subject: draft.subject,
      status: 'sent',
      providerMsgId: messageId,
    });

    // Best-effort APPEND to Sent folder
    try {
      const composer = new MailComposer(mailOptions);
      const compiled = await composer.compile().build();
      const rawMime = compiled.toString('utf8');
      await appendMessage(db, accountId, 'Sent', rawMime);
    } catch {
      // Sent append failure does not fail the delivery
    }

    return { messageId };
  } catch (err: unknown) {
    const providerError = err instanceof Error ? err.message : String(err);
    await recordOutbox(db, accountId, {
      to: draft.to,
      subject: draft.subject,
      status: 'failed',
      error: providerError,
    });
    throw new Error(providerError);
  }
}
