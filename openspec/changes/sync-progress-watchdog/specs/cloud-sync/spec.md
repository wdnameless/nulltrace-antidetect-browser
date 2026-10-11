# sync-progress-watchdog — Spec

## ADDED Requirements

### Requirement: network timeouts on sync fetches
Every HTTP call on the sync path MUST fail within a bounded time instead of hanging forever.

#### Scenario: stalled socket fails loudly
- **GIVEN** a Drive API call that never responds
- **WHEN** the ceiling elapses
- **THEN** the cycle fails with a timeout error row in the Sync Log, and `isSyncing` resets

### Requirement: stuck-cycle watchdog
The engine MUST flag a cycle running longer than the ceiling as stuck.

#### Scenario: stuck is surfaced
- **GIVEN** a cycle in flight for longer than the ceiling
- **WHEN** the UI polls status
- **THEN** it receives `stuck: true` and renders "sync appears stuck" guidance instead of a spinner

### Requirement: visible sync phase
Status MUST carry the current cycle phase and start time; the UI MUST render phase + elapsed.

#### Scenario: progress during first pull
- **GIVEN** a running cycle
- **WHEN** the operator looks at the page
- **THEN** they see e.g. "Pulling… 42s" updating until the cycle completes

### Requirement: honest Sync now outcome
The Sync now notice MUST reflect the polled cycle outcome, never the HTTP return.

#### Scenario: no premature success
- **GIVEN** a Sync now press
- **WHEN** the request returns while the cycle still runs
- **THEN** no success notice appears; it appears only after `syncing` flips false, showing success or the real error
