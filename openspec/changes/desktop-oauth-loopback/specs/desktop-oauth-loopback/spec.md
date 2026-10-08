# desktop-oauth-loopback

One-button Google Drive connection for a desktop application, via authorization code with PKCE over a loopback redirect.

## ADDED Requirements

### Requirement: One-button browser consent

The system SHALL open the operator's own browser at Google's consent screen from a single button, with no codes to transcribe and no credentials to enter.

#### Scenario: Operator connects a fresh install
- **WHEN** the operator presses the connect button and approves in the browser
- **THEN** the app holds a refresh token and the account is usable for sync
- **AND** no client secret is present in the build or in the request

#### Scenario: Operator works on a second machine
- **WHEN** the same button is pressed on another machine
- **THEN** that machine grants independently and lands in the same Drive folder

### Requirement: Loopback callback isolation

The system SHALL receive Google's redirect on a listener bound to 127.0.0.1 with an ephemeral port, and SHALL verify `state` before touching the code.

#### Scenario: A foreign code arrives at the callback
- **WHEN** a request reaches the listener whose `state` differs from this run's
- **THEN** it is discarded with a 400 and the flow keeps waiting
- **AND** no token exchange is attempted

#### Scenario: A favicon request arrives
- **WHEN** a browser opens `/favicon.ico` against the listener
- **THEN** it is answered without affecting the pending code

### Requirement: Client-type preflight

The system SHALL discover a wrong OAuth client type before binding a port or opening a browser, because Google answers a malformed authorization request with the client's own type in the error.

#### Scenario: A TV/Limited-Input client is configured
- **WHEN** the operator connects with a client Google only allows to use the device-code flow
- **THEN** the route refuses immediately with the concrete fix ("create a Desktop client")
- **AND** no browser window is opened and no port is bound

#### Scenario: The preflight itself cannot be answered
- **WHEN** Google is unreachable from this machine
- **THEN** the connect proceeds, because an unreachable preflight is not evidence about the client

### Requirement: Non-blocking connect

The system SHALL answer the connect request as soon as the browser is open, since approval happens in another window and can take minutes.

#### Scenario: Operator approves slowly
- **WHEN** consent takes minutes
- **THEN** the exchange, token storage and unlock happen after the request has been answered
- **AND** the outcome is recorded in the status panel and the sync log

#### Scenario: Two connects race
- **WHEN** a second connect arrives while one is still waiting
- **THEN** it is refused with 409, because a second listener would strand the first one's promise

### Requirement: Cancellation releases the port

The system SHALL cancel a pending attempt on request and release everything it held.

#### Scenario: Operator abandons the dialog
- **WHEN** cancel arrives mid-wait
- **THEN** the code promise rejects, the listener closes its port, and the refusal is recorded
- **AND** no unhandled rejection reaches the process
