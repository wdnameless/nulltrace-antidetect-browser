## Why

The mail side of NullTrace is read-only: operators attach IMAP accounts, read inboxes, and pull
verification codes. Anything beyond reading — answering a message, sending from an attached
identity, organising folders, or letting an agent act on mail — happens outside the product.
Mail accounts are second-class next to browser profiles: no identity (name, signature), no SMTP,
no link to the profile whose registrations they serve, and no MCP surface at all.

## What Changes

- Mail accounts become **mail profiles**: display name, signature, SMTP settings, optional
  binding to one browser profile — many attachable, switchable in UI and over MCP.
- **Send**: single-message SMTP send (text+HTML, cc/bcc, reply/forward headers) from any
  account, saved to Sent via IMAP APPEND, with per-message sent/failed status (outbox).
- **Track** (Thunderbird parity, local state only): folder list, per-folder listing, search,
  Seen/Answered/Flagged flags round-tripped to the server, Drafts save/load, unread counts.
- **Full mail-client UI**: composer, drafts, outbox, folder sidebar, search, account settings.
- **MCP `email.*` tools**: full agent surface — accounts, folders, messages, flags, codes,
  drafts, send (gated), outbox, profile binding.

## Capabilities

### New Capabilities
- `mail-profiles`: multi-account IMAP/SMTP mail profiles — identities, folders, flags, search,
  drafts, outbox, optional browser-profile binding, full UI.
- `mail-mcp`: MCP `email.*` tool family exposing the mail surface to agents with tiered scopes.

### Modified Capabilities
- None (pure extension; existing email endpoints and UI flows keep behavior).

## Impact

- Affected code: `src/main/email/` (IMAP verbs + SMTP), `src/main/api/routes/email.ts`,
  `mcp/src/` (manifest/auth/router), `packages/sdk-node`, `src/renderer/src/pages/Email.tsx`.
- New dependency: `nodemailer` (SMTP+MIME; nothing in stdlib/installed covers it).
- DB: new columns on `email_accounts` (identity, SMTP, `profile_id`), `outbox` + `drafts`
  tables; additive migrations only.

## Goals / Non-Goals

**Goals:**
- Send, organise, and track mail from many accounts without leaving NullTrace.
- Agents do everything the UI does, over typed MCP tools.
- Existing read/codes flows keep working byte-for-byte.

**Non-Goals:**
- Bulk campaigns, queues, throttling, per-account rate limits (widget: single send).
- Open-tracking pixel, link rewriting, callback ingestion (widget: local state only).
- OAuth2 / app-specific flows beyond user-supplied passwords (deferred).

## Risks / Trade-offs

- [Hand-rolled IMAP vs library] -> extending the existing session keeps zero new IMAP deps
  and matches tested patterns, but hand-parsing APPEND/STORE/SEARCH responses risks wire
  desync. Mitigation: one verb per tested function, fake-socket unit tests per verb.
- [SMTP library] -> new `nodemailer` dependency for send/MIME. Mitigation: pinned version,
  used only in `src/main/email/smtp.ts`, SBOM regenerated.
- [Gated send] -> agents need elevated scope to send. Accepted: external side effect,
  same bar as `cookies.export`.
