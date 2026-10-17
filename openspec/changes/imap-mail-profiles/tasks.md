# Tasks — imap-mail-profiles

Trace key: every task names its R## (G3 backward); every R01–R08 has ≥1 task (G3 forward).
R01→T1,T2,T3,T5 · R02→T1,T2,T3,T5 · R03→T1,T2,T3,T5 · R04→T5 · R05→T1,T2,T3,T5 ·
R06→T2,T3,T4,T6 · R07→T1–T5 (regression guard each) · R08→T1,T2,T3.

## T1. Mail core: IMAP verbs, SMTP send, outbox, drafts, binding column
Zone: `src/main/email/`, `tests/unit/email*.test.ts` · R01,R02,R03,R05,R07,R08 · blocked-by: —
- [ ] 1.1 `manager.ts`: extend `SimpleImapSession` with LIST / STATUS / SEARCH / STORE (+FLAGS/−FLAGS) / APPEND; `listFolders`, `listMessages(accountId, folder, query?)`, `setMessageFlags`, `appendMessage`; unread counts via STATUS.
- [ ] 1.2 MIME: minimal text/HTML part extraction for read (no hand-built MIME on receive path).
- [ ] 1.3 `smtp.ts` (new): nodemailer transport per account (host/port/security/auth from columns); `sendMail(accountId, draft)` → `{messageId}`; reply/forward headers (In-Reply-To/References); signature append; From `"displayName <addr>"`.
- [ ] 1.4 Schema: `email_accounts` += display_name, signature, smtp_host, smtp_port, smtp_secure, profile_id (nullable); new `email_outbox` (id, account_id, to_addrs, subject, status, provider_msg_id, error, created_at) + `email_drafts` (id, account_id, to_addrs, cc, bcc, subject, body_text, body_html, in_reply_to, updated_at). Additive only. `profile_id` validated against profileManager on write.
- [ ] 1.5 `saveDraft/getDrafts/deleteDraft`, `recordOutbox/listOutbox`; successful send APPENDs to Sent.
- [ ] 1.6 Unit tests per new verb over fake SocketFactory + nodemailer stub transport; pre-existing 20 email tests pass unmodified (R07); masked shapes unchanged (R08).
- Accept: `vitest run tests/unit/email` green; new coverage ≥1 test per new public fn.

## T2. REST surface
Zone: `src/main/api/routes/email.ts` · R01–R06,R07,R08 · blocked-by: T1
- [ ] 2.1 Account: extend create/update with identity+SMTP fields; `POST /accounts/:id/bind-profile` {profile_id|null}; list filter `?profile_id=`.
- [ ] 2.2 `GET /accounts/:id/folders` · `GET /accounts/:id/folders/:folder/messages?q=&unread=` · `GET .../messages/:uid` (folder-aware) · `PATCH .../messages/:uid/flags` {seen,flagged,answered} · `POST /accounts/:id/send` · `GET /accounts/:id/outbox` · drafts CRUD under `/accounts/:id/drafts`.
- [ ] 2.3 Same `{code,msg,data}` envelope; Zod validation on send/draft/bind inputs; masked outputs; `/reveal` untouched.
- Accept: each endpoint exercised (supertest or route-level test); typecheck green.

## T3. MCP `email.*` tools
Zone: `mcp/src/toolManifest.ts`, `mcp/src/auth.ts`, `mcp/src/tools.ts`, `mcp/src/redaction.ts`, `tests/unit/mcp/` · R06,R08 · blocked-by: T2
- [ ] 3.1 Manifest: `email.accounts.list/get/create/update/delete`, `email.folders.list`, `email.messages.list/read/search/set_flags`, `email.codes.extract`, `email.drafts.save/list/delete`, `email.messages.send` (gated), `email.outbox.list`, `email.accounts.bind_profile`. Default tier reads; send+delete gated.
- [ ] 3.2 `auth.ts` scope sets + `tools.ts` router cases calling the backend client; redaction of password/body credentials in args/audit.
- [ ] 3.3 Unit tests: manifest schemas valid, router dispatch per tool, gated-send denial without scope, redaction proof.
- Accept: `listTools` includes all `email.*`; denial test green.

## T4. SDK email domain
Zone: `packages/sdk-node/src/client.ts`, `types.ts` · R06 · blocked-by: T2
- [ ] 4.1 Typed `email` section mirroring T2 endpoints; export types.
- Accept: SDK email call compiles against T2 routes; existing SDK tests green.

## T5. Full mail-client UI
Zone: `src/renderer/src/pages/Email.tsx`, `src/renderer/src/api.ts` · R01–R05,R07 · blocked-by: T2
- [ ] 5.1 Account switcher w/ identity; settings modal (IMAP+SMTP, display name, signature, profile binding picker).
- [ ] 5.2 Folder sidebar + unread counts; message list w/ flags + search box; message view (codes flow preserved).
- [ ] 5.3 Composer modal (new/reply/forward, to/cc/bcc, text+HTML); drafts save/load; outbox view with sent/failed + reason; send error surfaced with provider text.
- Accept: manual smoke per scenario in spec (reply, drafts, flags, bind); no regression in codes flow (screenshot or logged run).

## T6. Docs
Zone: `docs/MCP.md`, `docs/openapi.yaml` · R06 · blocked-by: T2
- [ ] 6.1 Document `email.*` tools (tiers, schemas, gated-send note); OpenAPI email paths.
- Accept: `openapi:check` green; MCP.md mentions every new tool.
