# Recon — imap-mail-profiles

## What exists (verified in repo)
- `src/main/email/manager.ts` — hand-rolled `SimpleImapSession` (LOGIN/SELECT/FETCH only),
  tables `email_accounts` + `email_messages_cache`, `extractCodes`, fake-`SocketFactory` seam for tests.
- `src/main/api/routes/email.ts` mounted at `/api/v1/email` (server.ts:304) — account CRUD,
  inbox list, message read, codes. Envelope `{code, msg, data}`.
- `src/renderer/src/pages/Email.tsx` — accounts + inbox + codes UI; api fns in `src/renderer/src/api.ts`.
- MCP: `mcp/src/toolManifest.ts` (TOOL_DEFINITIONS, tiers default/gated), `tools.ts` router,
  `auth.ts` scope sets. Zero email tools today.
- SDK `packages/sdk-node`: no email domain.
- Browser profiles: `src/main/profiles/profileManager.ts`, id lookup exists (`getLiveProfile`).
- Tests: `tests/unit/email.test.ts` (18) + 2 integration. Zero mail deps installed (no nodemailer/imapflow).

## Blast radius
| Slice | Files | Owner |
|---|---|---|
| Mail core (IMAP LIST/STORE/SEARCH/APPEND, flags, MIME text, identity+profile_id columns, SMTP send, outbox, drafts) | `src/main/email/manager.ts`, `src/main/email/smtp.ts` (new), `tests/unit/email*.test.ts` | T1 |
| REST | `src/main/api/routes/email.ts` | T2 (blocked-by T1) |
| MCP | `mcp/src/toolManifest.ts`, `mcp/src/auth.ts`, `mcp/src/tools.ts` | T3 (blocked-by T2) |
| SDK | `packages/sdk-node/src/client.ts`, `types.ts` | T4 (blocked-by T2) |
| UI | `src/renderer/src/pages/Email.tsx`, `src/renderer/src/api.ts` | T5 (blocked-by T2) |
| Docs | `docs/MCP.md`, `docs/openapi.yaml` email section | T6 (blocked-by T2) |

## Key decisions (settled)
- SMTP via `nodemailer` (new dep; nothing in stdlib/installed covers SMTP+MIME). IMAP stays
  hand-rolled, extended in the existing session pattern (LIST/STORE/SEARCH/APPEND).
- Auth stays user/pass (app passwords); OAuth2 deferred — out of scope.
- Send is a gated MCP tool (external side effect, same bar as `cookies.export`).
- `profile_id` nullable column on `email_accounts`, validated against profileManager; no
  change to profiles table.

## Riskiest seam
Wire-level IMAP/SMTP in `manager.ts` — hand-parsed S-exps/literals. Mitigation: extend the
existing tested pattern, fake-socket unit tests per new verb, no MIME authoring by hand
(nodemailer builds, minimal parser extracts text/HTML parts only).

## Acceptance check
`vitest run tests/unit/email` green · `tsc -p tsconfig.main.json --noEmit` green ·
REST send/list/flags exercised against fake socket · MCP `email.*` tools listed and routed ·
oracle blind pass vs manifest R01–R08.
