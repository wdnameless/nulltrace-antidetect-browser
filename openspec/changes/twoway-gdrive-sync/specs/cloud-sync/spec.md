# cloud-sync (two-way)

Two-way Google Drive synchronisation of all portable user data, with revision-committed payloads,
row-level merge, validation and verification.

## ADDED Requirements

### Requirement: Revision-committed payload

The system SHALL write each push as ONE sealed payload file under a fresh revision name, followed by
a plaintext manifest naming the current revision and its SHA-256.

#### Scenario: A push is interrupted before the manifest write
- **WHEN** the payload upload fails or the process dies before `manifest.json` is written
- **THEN** the previously committed revision remains readable and pullable
- **AND** no digest mismatch is reported for the folder

#### Scenario: Verification after push
- **WHEN** a push completes
- **THEN** the system re-downloads the manifest and the state file it names
- **AND** verifies the SHA-256 matches
- **AND** reports a mismatch as a failed sync rather than a success

#### Scenario: Large payload
- **WHEN** a payload exceeds 5 MB
- **THEN** it is uploaded through a chunked resumable session
- **AND** the upload survives a per-chunk network interruption

### Requirement: Row-level two-way merge

The system SHALL merge local and remote state per row using a locally stored base snapshot of row
hashes from the last successful sync.

#### Scenario: Row changed only remotely
- **WHEN** a row is unchanged locally since the base but changed remotely
- **THEN** the remote version is applied locally

#### Scenario: Row changed only locally
- **WHEN** a row changed locally and is unchanged remotely since the base
- **THEN** the local version is pushed and the base is updated

#### Scenario: Row changed on both sides identically
- **WHEN** both sides changed a row to the same value
- **THEN** nothing is written and the run is not reported as a conflict

#### Scenario: Row changed on both sides differently
- **WHEN** a row changed locally and remotely with differing values
- **THEN** it is reported as a conflict
- **AND** resolved by `keep_local` (default) or `overwrite_remote` when explicitly requested
- **AND** under `keep_local` the local value is pushed so the remote converges

#### Scenario: Row deleted locally
- **WHEN** a row present in the base is absent locally
- **THEN** a tombstone is pushed
- **AND** the row is deleted on the next pull instead of being resurrected

#### Scenario: Row deleted remotely
- **WHEN** a row present in the base is absent from the remote payload
- **THEN** the row is deleted locally

### Requirement: Complete entity coverage

The system SHALL synchronise profiles (including browser site state and cookies), vault credentials,
scripts, proxies, groups, tags, profile-tag and profile-extension links, extensions, triggers, devices,
global keys, and settings.

#### Scenario: Foreign-keyed profile arrives on a new machine
- **WHEN** a profile referencing a device, group or proxy arrives on a machine that lacks it
- **THEN** the referenced record is created or matched by name
- **AND** the profile is attached to the resolved record rather than a dangling id

#### Scenario: Secrets cross machines
- **WHEN** a vault credential is pushed
- **THEN** the stored value is revealed to plaintext on the pushing machine
- **AND** re-protected under the receiving machine's own secret key on pull
- **AND** a value that cannot be revealed is carried as an explicit marker, never as unreadable ciphertext

#### Scenario: Machine-local data stays put
- **WHEN** a sync runs
- **THEN** machine-local fields are not carried: workspace paths, runtime profile status, Chromium
  process bookkeeping, task/script run logs, and the local data directory

#### Scenario: Settings coverage
- **WHEN** settings are pushed
- **THEN** every persisted setting is carried except an explicit denylist (data dir, ports, the
  passphrase verifier, Drive secrets)
- **AND** theme, language and shortcuts therefore travel between machines

### Requirement: Automatic sync on change

The system SHALL trigger a debounced sync when data changes, and SHALL NOT trigger it for writes the
sync engine itself performs.

#### Scenario: A profile is edited
- **WHEN** any write reaches the database or the settings store outside the sync engine
- **THEN** a sync is requested after the debounce interval

#### Scenario: Pull does not loop
- **WHEN** a pull writes remote rows into the local database
- **THEN** no push is scheduled as a result of those writes

### Requirement: Folder discovery and validation

The system SHALL locate the sync folder by its defined name without operator file-picking, and SHALL
validate it before use.

#### Scenario: Folder found by name
- **WHEN** connecting
- **THEN** the folder named `nulltrace data` is found, or the legacy `NullTrace_Sync` is adopted, or
  the canonical folder is created

#### Scenario: Folder holds foreign data
- **WHEN** the discovered folder contains files but no NullTrace manifest
- **THEN** it is refused with a reason
- **AND** no file in it is read or overwritten

#### Scenario: Stored folder id no longer exists
- **WHEN** the remembered folder id is unknown to Drive
- **THEN** it is cleared and the folder is discovered again by name

### Requirement: Passphrase rotation

The system SHALL allow changing the sync passphrase without manual file surgery.

#### Scenario: Passphrase changed
- **WHEN** the operator supplies the current and a new passphrase
- **THEN** the current one is verified first
- **AND** a new revision sealed under the new passphrase is pushed
- **AND** older revisions are pruned

### Requirement: Operator-visible sync state

The system SHALL record every sync run and surface its outcome.

#### Scenario: Background sync fails
- **WHEN** an automatic sync fails
- **THEN** the failure is recorded with its reason and returned by the status endpoint

#### Scenario: Operator inspects history
- **WHEN** the operator opens the sync log
- **THEN** recent runs are listed with direction, outcome and counts