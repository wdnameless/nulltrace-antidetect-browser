## Purpose

Requirements and verification for multi-account mail profiles: identities, SMTP send,
folders/flags/search, drafts, outbox, browser-profile binding, full UI, and MCP tools.
Trace: R01–R08 in `manifest.md`.

## ADDED Requirements

### Requirement: Mail accounts are named profiles with identity and SMTP
Accounts MUST carry display name, signature, SMTP host/port/security, and support many
accounts side by side (R01).

#### Scenario: Create and switch between several accounts
- **GIVEN** two IMAP accounts with distinct labels
- **WHEN** both are created and listed
- **THEN** both appear with label, email, host, and masked credentials, and either can be
  selected for inbox/send operations

#### Scenario: Identity used on send
- **GIVEN** an account with display name "Ops" and a signature
- **WHEN** a message is sent from it
- **THEN** the From header is "Ops <addr>" and the signature is appended to the body

### Requirement: Single-message SMTP send with Sent + outbox record
Any account MUST send one message (to/cc/bcc, subject, text+HTML, reply/forward headers);
each attempt MUST land in Sent on success and in the outbox with status on either outcome (R02).

#### Scenario: Successful send
- **GIVEN** a configured account
- **WHEN** `send` is called with to/subject/body
- **THEN** the message is delivered via SMTP, appended to the Sent folder, and recorded
  `status=sent` with the provider message id

#### Scenario: Failed send is recorded, not lost
- **GIVEN** an account with unreachable SMTP
- **WHEN** `send` is called
- **THEN** delivery fails with the provider's error text and the outbox row is `status=failed`
  carrying that reason

### Requirement: Thunderbird-like local tracking — folders, flags, search, drafts
The system MUST list folders, list/search messages per folder, round-trip
Seen/Answered/Flagged flags to the server, save/load drafts, and report unread counts (R03).

#### Scenario: Flags round-trip
- **GIVEN** a message in INBOX
- **WHEN** it is marked read and flagged
- **THEN** a subsequent list shows both flags, and an IMAP STORE was issued so a second
  client observes the same state

#### Scenario: Draft survives restart
- **GIVEN** a composed draft saved for an account
- **WHEN** the app restarts and drafts are listed
- **THEN** the draft is present with to/subject/body intact

### Requirement: Full mail-client UI
The desktop UI MUST expose composer (new/reply/forward), drafts, outbox with statuses,
folder sidebar with unread counts, search, and account settings incl. profile binding —
while the existing codes-extraction flow keeps working (R04, R07).

#### Scenario: Reply from the UI
- **GIVEN** a selected message
- **WHEN** the operator hits Reply, edits, and sends
- **THEN** the reply carries In-Reply-To/References and appears in Sent and the outbox as sent

#### Scenario: Codes flow preserved
- **GIVEN** a verification message
- **WHEN** it is opened
- **THEN** extracted codes render exactly as before the change

### Requirement: Optional binding of a mail account to a browser profile
An account MAY link to exactly one browser profile; unknown profile ids MUST be rejected;
clearing the link MUST NOT delete the account (R05).

#### Scenario: Bind and filter
- **GIVEN** a browser profile P and a mail account A
- **WHEN** A is bound to P and accounts are listed with `profile_id=P`
- **THEN** A appears; unbinding removes it from that filter while A still exists

### Requirement: MCP agent surface for all of the above
MCP MUST expose typed `email.*` tools covering accounts, folders, messages, flags, codes,
drafts, send, outbox, and binding; read tools default tier, send/delete gated; passwords
MUST never appear in outputs, logs, or audit (R06, R08).

#### Scenario: Agent reads and sends
- **GIVEN** an agent with automation scope plus the gated mail scope
- **WHEN** it lists accounts, reads a message, then sends a reply
- **THEN** each call returns structured JSON matching the manifest schemas, and the audit
  log contains the calls with credentials redacted

#### Scenario: Ungated send denied
- **GIVEN** an agent without the gated scope
- **WHEN** it calls `email.messages.send`
- **THEN** the call is rejected before any SMTP traffic

### Requirement: Existing behavior and secrecy preserved
Account CRUD, inbox list, message read, codes extraction, and cache-fallback-with-reason
MUST keep working; list/get MUST stay masked with `/reveal` the only plaintext path (R07, R08).

#### Scenario: Old tests green
- **GIVEN** the pre-change email test suite
- **WHEN** the full suite runs after the change
- **THEN** all pre-existing email tests pass unmodified
