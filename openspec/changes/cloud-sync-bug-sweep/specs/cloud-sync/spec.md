# cloud-sync-bug-sweep — Spec

## ADDED Requirements

### Requirement: engine start preserves active failures
`startSyncEngine` MUST NOT clear a `lastError` that no cycle has yet superseded.

#### Scenario: authorize failure survives engine start
- **GIVEN** `lastError` holds an authorization failure
- **WHEN** the engine starts without running a cycle yet
- **THEN** `lastError` still holds that failure until a cycle completes or fails

### Requirement: auth poll ignores pre-attempt errors
The connect-status poll MUST ignore `lastError` values predating the current attempt.

#### Scenario: stale error does not kill OAuth
- **GIVEN** a `lastError` from an earlier failure
- **WHEN** a new connect attempt starts polling
- **THEN** the old error never terminates the new attempt

### Requirement: conflict inspection renders backend shape
The inspection panel MUST render the backend `ConflictItem` shape (`table/key/hashes`) without crashing.

#### Scenario: conflicts display
- **GIVEN** an inspection with conflicts
- **WHEN** the panel renders
- **THEN** each conflict shows table + key (+ hashes in details) and no exception is thrown

### Requirement: token cache defaults expiry
Token caching MUST fall back to a sane TTL when the server omits `expires_in`.

#### Scenario: missing expiry does not poison cache
- **GIVEN** a token response without `expires_in`
- **WHEN** the token is cached
- **THEN** it expires within ~1h instead of living forever (or being dropped)

### Requirement: dead grants disconnect
A refresh rejection (`invalid_grant`/revoked) MUST purge the refresh token so status reports disconnected.

#### Scenario: revoked grant surfaces
- **GIVEN** Google rejects the refresh token
- **WHEN** the next refresh runs
- **THEN** the stored grant is purged and `connected` becomes false

### Requirement: credential swap drops old grant
Saving new OAuth credentials MUST clear the previous client's refresh token.

#### Scenario: client switch reconnects clean
- **GIVEN** a stored grant for client A
- **WHEN** the operator saves client B credentials
- **THEN** no grant remains and status is configured-but-disconnected

### Requirement: disconnect clears account residue
Disconnect MUST clear `folderId` and cached email alongside tokens.

#### Scenario: reconnect picks its own folder
- **GIVEN** a disconnected account with a remembered folder
- **WHEN** a different account connects
- **THEN** no stale folder id or email leaks into the new session

### Requirement: mirror download stays binary
Mirror download MUST fail loudly instead of utf8-decoding binary data when no buffer API exists.

#### Scenario: no silent corruption
- **GIVEN** a transport without `downloadBuffer`
- **WHEN** a mirror download runs
- **THEN** it throws a clear error rather than producing a corrupt archive

### Requirement: engine stop cancels trailing work
`stopSyncEngine` MUST clear queued triggers and in-flight handles so no cycle runs after shutdown.

#### Scenario: clean shutdown
- **GIVEN** a queued trigger at stop time
- **WHEN** the engine stops
- **THEN** no further cycle executes

### Requirement: unlock triggers one sync
Session unlock MUST produce exactly one launch sync, not two back-to-back.

#### Scenario: single launch sync
- **GIVEN** a locked session
- **WHEN** unlock succeeds
- **THEN** exactly one sync cycle is scheduled

### Requirement: auth wait can be cancelled
The connecting progress state MUST offer Cancel, which aborts the backend attempt and frees the 409 lock.

#### Scenario: abandoned OAuth releases the lock
- **GIVEN** an in-flight authorization
- **WHEN** the operator presses Cancel
- **THEN** the backend attempt is cancelled and a retry is immediately possible

### Requirement: actions gated on session state
Sync now and Advanced actions MUST be disabled while the session is locked or a cycle is running.

#### Scenario: no instant failures
- **GIVEN** a locked or syncing session
- **WHEN** the operator looks at the actions
- **THEN** state-dependent buttons are disabled with the reason visible
