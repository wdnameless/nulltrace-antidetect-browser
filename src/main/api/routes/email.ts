import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../../db';
import {
  listAccounts,
  getAccount,
  createAccount,
  updateAccount,
  deleteAccount,
  revealAccountPassword,
  listInbox,
  readMessage,
  extractCodes,
  listFolders,
  listMessages,
  setMessageFlags,
  saveDraft,
  listDrafts,
  deleteDraft,
  listOutbox,
  bindProfile,
  CreateEmailAccountInput,
  UpdateEmailAccountInput,
} from '../../email/manager';
import { sendMail } from '../../email/smtp';

const router = Router();

// Envelope helpers
function ok<T>(res: Response, data: T, msg = 'ok') {
  return res.json({ code: 0, msg, data });
}

function fail(res: Response, msg: string, code = -1, status?: number) {
  if (status && status !== 200) {
    res.status(status);
  }
  return res.json({ code, msg, data: null });
}

function handleRouteError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Unknown profile_id')) {
    return fail(res, message, 400, 400);
  }
  if (message.includes('not found')) {
    return fail(res, message, 404, 404);
  }
  return fail(res, message);
}

function splitAddrList(value: string[] | string | undefined): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizeRefList(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  return [value];
}

async function requireAccount(res: Response, id: string) {
  const account = await getAccount(getDb(), id);
  if (!account) {
    fail(res, 'Account not found', 404, 404);
    return false;
  }
  return true;
}
// Zod schemas for validated inputs
const bindProfileSchema = z.object({
  profile_id: z.string().nullable().optional(),
});

const patchFlagsSchema = z.object({
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  answered: z.boolean().optional(),
  folder: z.string().optional(),
});

const sendMailSchema = z.object({
  to: z.union([z.array(z.string().min(1)).min(1), z.string().min(1)]),
  cc: z.union([z.array(z.string()), z.string()]).optional(),
  bcc: z.union([z.array(z.string()), z.string()]).optional(),
  subject: z.string(),
  text: z.string().optional(),
  html: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.union([z.array(z.string()), z.string()]).optional(),
});

const draftSchema = z.object({
  id: z.string().optional(),
  to: z.union([z.array(z.string()), z.string()]).optional(),
  to_addrs: z.union([z.array(z.string()), z.string()]).optional(),
  cc: z.union([z.array(z.string()), z.string()]).optional(),
  bcc: z.union([z.array(z.string()), z.string()]).optional(),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
  body_text: z.string().optional(),
  bodyHtml: z.string().optional(),
  body_html: z.string().optional(),
  inReplyTo: z.string().optional(),
  in_reply_to: z.string().optional(),
});

// 1. Account CRUD
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const profileIdQuery = req.query.profile_id;
    let filter: { profile_id?: string | null } | undefined;
    if (profileIdQuery !== undefined) {
      filter = { profile_id: profileIdQuery === '' ? null : (profileIdQuery as string) };
    }
    const accounts = await listAccounts(getDb(), filter);
    return ok(res, accounts);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

router.post('/accounts', async (req: Request, res: Response) => {
  try {
    const {
      email,
      host,
      port,
      username,
      password,
      label,
      display_name,
      signature,
      smtp_host,
      smtp_port,
      smtp_secure,
      profile_id,
    } = req.body as CreateEmailAccountInput;
    if (!email || !host || !username) {
      return fail(res, 'email, host, and username are required');
    }
    const account = await createAccount(getDb(), {
      email,
      host,
      port: port ? Number(port) : 993,
      username,
      password,
      label,
      display_name,
      signature,
      smtp_host,
      smtp_port: smtp_port == null ? undefined : Number(smtp_port),
      smtp_secure: smtp_secure == null ? undefined : Boolean(smtp_secure),
      profile_id,
    });
    return ok(res, account);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

router.get('/accounts/:id', async (req: Request, res: Response) => {
  try {
    const account = await getAccount(getDb(), req.params.id);
    if (!account) {
      return fail(res, 'Account not found');
    }
    return ok(res, account);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

const handleUpdateAccount = async (req: Request, res: Response) => {
  try {
    const updated = await updateAccount(getDb(), req.params.id, req.body as UpdateEmailAccountInput);
    if (!updated) {
      return fail(res, 'Account not found');
    }
    return ok(res, updated);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
};
router.put('/accounts/:id', handleUpdateAccount);
router.patch('/accounts/:id', handleUpdateAccount);

router.delete('/accounts/:id', async (req: Request, res: Response) => {
  try {
    const deleted = await deleteAccount(getDb(), req.params.id);
    return ok(res, { deleted });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

// Profile binding
router.post('/accounts/:id/bind-profile', async (req: Request, res: Response) => {
  const parsed = bindProfileSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return fail(res, parsed.error.issues[0]?.message ?? 'Invalid profile_id', 400, 400);
  }
  try {
    const account = await bindProfile(getDb(), req.params.id, parsed.data.profile_id ?? null);
    return ok(res, account);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

// Reveal password endpoint (dedicated action per accountVault convention)
router.post('/accounts/:id/reveal', async (req: Request, res: Response) => {
  try {
    const password = await revealAccountPassword(getDb(), req.params.id);
    if (password === null) {
      return fail(res, 'No password stored or account not found');
    }
    return ok(res, { password });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

// Folders & Folder-aware message endpoints
router.get('/accounts/:id/folders', async (req: Request, res: Response) => {
  try {
    const folders = await listFolders(getDb(), req.params.id);
    return ok(res, folders);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

router.get('/accounts/:id/folders/:folder/messages', async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;
    const result = await listMessages(getDb(), req.params.id, req.params.folder, query);
    if (req.query.unread === '1' || req.query.unread === 'true') {
      result.messages = result.messages.filter((m) => !m.seen && !m.flags?.some((f) => /\\seen/i.test(f)));
    }
    return ok(res, result);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

router.get('/accounts/:id/folders/:folder/messages/:uid', async (req: Request, res: Response) => {
  try {
    const message = await readMessage(getDb(), req.params.id, req.params.uid, req.params.folder);
    return ok(res, { ...message, folder: req.params.folder });
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

// Message Flags
router.patch('/accounts/:id/messages/:uid/flags', async (req: Request, res: Response) => {
  const parsed = patchFlagsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return fail(res, parsed.error.issues[0]?.message ?? 'Invalid flags input', 400, 400);
  }
  try {
    const folder = (typeof req.query.folder === 'string' && req.query.folder.trim())
      || parsed.data.folder
      || 'INBOX';
    await setMessageFlags(getDb(), req.params.id, folder, req.params.uid, {
      seen: parsed.data.seen,
      flagged: parsed.data.flagged,
      answered: parsed.data.answered,
    });
    return ok(res, { success: true });
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

// SMTP Send & Outbox
router.post('/accounts/:id/send', async (req: Request, res: Response) => {
  const parsed = sendMailSchema.safeParse(req.body);
  if (!parsed.success) {
    return fail(res, parsed.error.issues[0]?.message ?? 'Invalid send parameters', 400, 400);
  }
  try {
    const toList = splitAddrList(parsed.data.to) ?? [];
    const ccList = splitAddrList(parsed.data.cc);
    const bccList = splitAddrList(parsed.data.bcc);
    const refList = parsed.data.references == null
      ? undefined
      : normalizeRefList(parsed.data.references);

    const result = await sendMail(getDb(), req.params.id, {
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject: parsed.data.subject,
      text: parsed.data.text,
      html: parsed.data.html,
      inReplyTo: parsed.data.inReplyTo,
      references: refList,
    });
    return ok(res, result);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

router.get('/accounts/:id/outbox', async (req: Request, res: Response) => {
  try {
    if (!await requireAccount(res, req.params.id)) return;
    const outbox = await listOutbox(getDb(), req.params.id);
    return ok(res, outbox);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

// Drafts
router.get('/accounts/:id/drafts', async (req: Request, res: Response) => {
  try {
    if (!await requireAccount(res, req.params.id)) return;
    const drafts = await listDrafts(getDb(), req.params.id);
    return ok(res, drafts);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

router.post('/accounts/:id/drafts', async (req: Request, res: Response) => {
  const parsed = draftSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return fail(res, parsed.error.issues[0]?.message ?? 'Invalid draft parameters', 400, 400);
  }
  try {
    const draft = await saveDraft(getDb(), req.params.id, parsed.data);
    return ok(res, draft);
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

router.delete('/accounts/:id/drafts/:draftId', async (req: Request, res: Response) => {
  try {
    if (!await requireAccount(res, req.params.id)) return;
    const deleted = await deleteDraft(getDb(), req.params.id, req.params.draftId);
    return ok(res, { deleted });
  } catch (err: unknown) {
    return handleRouteError(res, err);
  }
});

// Legacy message & code extraction
router.get('/accounts/:id/inbox', async (req: Request, res: Response) => {
  try {
    const result = await listInbox(getDb(), req.params.id);
    return ok(res, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

router.get('/accounts/:id/messages/:uid', async (req: Request, res: Response) => {
  try {
    const message = await readMessage(getDb(), req.params.id, req.params.uid);
    return ok(res, message);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

router.get('/accounts/:id/messages/:uid/codes', async (req: Request, res: Response) => {
  try {
    const message = await readMessage(getDb(), req.params.id, req.params.uid);
    const codes = extractCodes(message.body || '');
    return ok(res, { codes, message });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

router.get('/accounts/:id/codes', async (req: Request, res: Response) => {
  try {
    const { messages } = await listInbox(getDb(), req.params.id);
    const codes: Array<{ uid: string; subject: string; codes: string[] }> = [];
    for (const msg of messages) {
      const extracted = extractCodes(msg.subject);
      if (extracted.length > 0) {
        codes.push({ uid: msg.uid, subject: msg.subject, codes: extracted });
      }
    }
    return ok(res, { codes });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

router.post('/extract-codes', (req: Request, res: Response) => {
  try {
    const { text } = req.body as { text?: string };
    const codes = extractCodes(text || '');
    return ok(res, { codes });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(res, message);
  }
});

export default router;
