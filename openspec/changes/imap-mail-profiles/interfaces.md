# Interfaces — imap-mail-profiles

Deep modules, consumer-side seams. Only the orchestrator edits this file; worker
INTERFACES append below the seed (none yet — scaffold stage).

## Seed (Wave 2 — contract workers build against)

### M1 `src/main/email/manager.ts` (extends existing; no renames)
```ts
listFolders(accountId: string): Promise<{ name: string; unread: number }[]>
listMessages(accountId: string, folder = 'INBOX', query?: string): Promise<InboxResult>
setMessageFlags(accountId: string, folder: string, uid: string, flags: { seen?: boolean; flagged?: boolean; answered?: boolean }): Promise<void>
appendMessage(accountId: string, folder: string, raw: string): Promise<void>
saveDraft(accountId: string, d: DraftInput): Promise<Draft>
listDrafts(accountId: string): Promise<Draft[]>
deleteDraft(accountId: string, draftId: string): Promise<boolean>
listOutbox(accountId: string): Promise<OutboxRow[]>
bindProfile(accountId: string, profileId: string | null): Promise<EmailAccountMasked> // throws on unknown profile
```
Existing exports (`createAccount`, `listAccounts`, `listInbox`, `readMessage`,
`extractCodes`, …) unchanged in signature and behavior.

### M2 `src/main/email/smtp.ts` (new, owns the nodemailer dep)
```ts
sendMail(accountId: string, draft: SendInput): Promise<{ messageId: string }>
// SendInput { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text?: string; html?: string; inReplyTo?: string; references?: string[] }
// Throws Error with provider text; manager records outbox row + APPENDs Sent.
```

### R1 REST `/api/v1/email` (envelope `{code,msg,data}`, masked outputs)
```
POST   /accounts/:id/send                 R02
GET    /accounts/:id/folders               R03
GET    /accounts/:id/folders/:f/messages   R03  (?q=, ?unread=1)
PATCH  /accounts/:id/messages/:uid/flags   R03
GET    /accounts/:id/outbox                R02/R03
GET    /accounts/:id/drafts  POST ...  DELETE /accounts/:id/drafts/:d  R03
POST   /accounts/:id/bind-profile          R05
GET    /accounts?profile_id=               R05 (filter)
```
Account create/update extended with display_name, signature, smtp_* (R01).

### C1 MCP `email.*` (manifest `mcp/src/toolManifest.ts`)
Default: accounts.list/get/create/update, folders.list, messages.list/read/search/set_flags,
codes.extract, drafts.save/list/delete, outbox.list, accounts.bind_profile.
Gated: messages.send, accounts.delete.
Schemas mirror R1; no password fields in any output schema; `redactSensitiveArgs` extended.

### U1 UI `Email.tsx` ↔ `api.ts`
`api.ts` gains one fn per R1 endpoint (same names as existing `email*` fns style);
`Email.tsx` consumes only via `api.*` — no direct fetch.

### D1 DB (additive)
`email_accounts` += display_name TEXT, signature TEXT, smtp_host TEXT, smtp_port INT,
smtp_secure INT, profile_id TEXT NULL (validated vs profileManager, no FK pragma change).
New `email_outbox`, `email_drafts` per tasks.md T1.4.

## Worker appendices
(none — Wave 3 not started)
