# cloud-sync-ux-redesign — Spec

## ADDED Requirements

### Requirement: profile_extensions launch_args migration
The system MUST add the `launch_args` column to pre-existing `profile_extensions` tables at startup.

#### Scenario: old database syncs without crash
- **GIVEN** a database whose `profile_extensions` lacks `launch_args`
- **WHEN** the app starts and the operator presses Sync now
- **THEN** migration adds the column and the sync cycle completes with no `no such column` error

### Requirement: single status card
The connected state MUST render one status card showing connection state, account, last sync time,
and pending conflicts — and one primary Sync now button.

#### Scenario: connected at a glance
- **GIVEN** a connected Google Drive
- **WHEN** the operator opens Cloud Sync
- **THEN** one card answers "am I connected, as whom, when did it last sync" plus a single Sync now button

### Requirement: Advanced disclosure
Verify, Check for Remote Updates, Pull, Push, Sync Log, and the Chromium Mirror block MUST live
inside a collapsed-by-default Advanced disclosure.

#### Scenario: advanced stays hidden
- **GIVEN** a connected state
- **WHEN** the operator opens the page
- **THEN** none of Verify/Pull/Push/Log/Mirror controls are visible until Advanced is expanded

### Requirement: destructive confirmations
Disconnect, Change Passphrase (already two-step), Pull, and Push MUST open a confirmation dialog
explaining consequences before executing.

#### Scenario: disconnect requires confirmation
- **GIVEN** a connected state
- **WHEN** the operator clicks Disconnect
- **THEN** a dialog explains local data stays and sync stops, and nothing happens until confirmed

### Requirement: human error presentation
A sync failure MUST render a human sentence plus [Details] (raw error, collapsed) and [Retry].

#### Scenario: failure is readable
- **GIVEN** a failed sync cycle with a technical error
- **WHEN** the operator looks at the page
- **THEN** they see a plain-language sentence, a Details disclosure with the raw text, and a Retry button —
  never a bare SQL message
