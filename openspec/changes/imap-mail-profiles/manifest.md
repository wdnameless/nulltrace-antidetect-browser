# Requirements manifest — IMAP mail profiles (Thunderbird-like) + MCP

Verbatim operator statements are quoted; each requirement names the evidence that proves it.

## R01 — Mail accounts behave as profiles, many attachable

> «хочу чтобы там тоже были профили, можно было бы подключать много аккаунтов как профили»

Operator words: «там тоже были профили» — like browser profiles, the mail side must have
named switchable identities, and «много аккаунтов» — no practical limit.
Evidence: `email_accounts` rows carry label/display-name/signature/SMTP config; UI lists and
switches between N accounts; MCP `email.accounts.list` returns all; no hard-coded cap.

## R02 — Send mail from any attached account

> «рассылать оттуда письма» (widget: «Одиночная отправка»)

Single-message send from a chosen account: to/cc/bcc/subject/text+html body. Evidence:
`POST /api/v1/email/accounts/:id/send` returns message id; sent mail landable in Sent via
IMAP APPEND; MCP `email.messages.send` (gated) routes to it.
Explicitly OUT (widget choice): bulk campaigns, queues, throttling, per-account rate limits.

## R03 — Track mail state like a mail client

> «трекать и все остальное как в других IMAP сервисах по типу thunderbird» (widget: «Статусы и папки»)

Thunderbird parity for local state: folder list, per-folder message list, search, read/unread,
flagged/answered flags, Sent + Drafts sync, send statuses (sent/failed recorded per message).
Evidence: REST `GET folders`, `GET folders/:f/messages`, `PATCH messages/:uid/flags`,
`GET outbox`; flags round-trip to the server (STORE) and persist in cache; UI shows folders,
unread counts, flags, drafts, outbox.
Explicitly OUT (widget choice): open-tracking pixel, link rewriting, callback ingestion.

## R04 — Everything else Thunderbird does (read/compose basics)

> «и все остальное как в других IMAP сервисах по типу thunderbird» (widget: «Полный почтовик»)

Full mail-client UI on top of R01–R03: compose with reply/forward, drafts save/load,
message view with codes extraction preserved, folder sidebar, search box, account settings
(IMAP+SMTP, identity, signature, profile binding).
Evidence: `Email.tsx` exposes composer, drafts, outbox, folders, search; existing
codes-extraction flow keeps working.

## R05 — Mail identity optionally bound to a browser profile

> «там тоже были профили» (widget: «+ привязка к браузерным профилям»)

An email account may link to one browser profile (`profile_id`), so a profile's mail
(registrations, codes) is reachable in its context. Evidence: nullable `profile_id` column,
validated against profileManager (rejects unknown ids); `POST .../bind-profile` sets/clears;
UI shows and edits the binding; MCP can filter accounts by profile.

## R06 — Agent operates mail over MCP

> «Так же добавь все это в мсп чтобы агент мог с этим взаимодействовать»

Full MCP surface: accounts (list/get/create/update/delete), folders, messages
(list/read/search/flags), codes extract, drafts (save/list/delete), send, outbox, bind-profile.
Evidence: `email.*` entries in TOOL_DEFINITIONS; router executes each against the backend;
read tools default tier, send/delete gated; `docs/MCP.md` documents them; redaction keeps
passwords out of logs/audit.

## R07 — Existing mail behavior must not break

Implicit (no operator quote; regression guard). Account CRUD, inbox list, message read,
codes extraction, cache fallback with error reason keep working.
Evidence: existing 20 email tests green plus new ones; `tests/unit/email.test.ts` untouched
in behavior for old paths.

## R08 — Secrets stay secret

Implicit (repo law; secrets redaction gate). Passwords never in list/get responses, MCP
outputs, logs, or audit. Evidence: masked shapes unchanged; `/reveal` stays the only
plaintext path; `redactSensitiveArgs` covers new email tools; no password in test fixtures.

## Status (Wave 2 gate)

| ID | Status |
|----|--------|
| R01 | in-spec |
| R02 | in-spec |
| R03 | in-spec |
| R04 | in-spec |
| R05 | in-spec |
| R06 | in-spec |
| R07 | in-spec |
| R08 | in-spec |

Zero `open` — G2 satisfied at scaffold time; forward/backward trace lives in `tasks.md`.
