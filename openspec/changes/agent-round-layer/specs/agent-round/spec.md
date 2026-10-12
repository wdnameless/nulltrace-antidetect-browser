## ADDED Requirements

### Requirement: Semantic page snapshot with stable refs
The product MUST provide a semantic page snapshot (viewport, full-page, and
subtree scopes) where interactive elements carry stable `@ref` identifiers
usable by later automation actions.

#### Scenario: Viewport snapshot lists refs
- **WHEN** a snapshot of a loaded page is requested with default scope
- **THEN** the result MUST be a compact role tree naming interactive elements
- **AND** each named element MUST carry a `@ref` usable in a follow-up action

#### Scenario: Subtree snapshot focuses a frame
- **WHEN** a subtree snapshot is requested with a `root` ref pointing at an iframe
- **THEN** the result MUST cover that frame's subtree
- **AND** the returned refs MUST be actionable inside that frame

#### Scenario: Navigation invalidates refs
- **WHEN** the page navigates after a snapshot
- **THEN** previously issued refs MUST NOT resolve to the new document

### Requirement: Selector grammar resolves exactly one element
Automation selectors MUST support `@ref`, text, `loc=`, xpath, and raw CSS
forms, and MUST resolve to exactly one actionable element or fail loudly.

#### Scenario: Ambiguity is an error
- **WHEN** a selector matches more than one actionable element
- **THEN** the action MUST fail with an ambiguity error, never pick one silently

#### Scenario: Ref resolves through the registry
- **WHEN** an action addresses a ref issued by the latest snapshot
- **THEN** it MUST operate on that exact element

### Requirement: One code round executes a whole action chain
A single round request carrying a JS snippet MUST execute the full chain
(navigate, fill, click, waits, snapshot) in one sandboxed pass and return the
console output plus the final observation.

#### Scenario: Fill-click-wait-snapshot in one round
- **WHEN** a round with fill, click, wait-for-selector, and snapshot is submitted
- **THEN** all steps MUST execute in order within that single request
- **AND** the response MUST carry the final snapshot text

#### Scenario: Round code cannot reach the OS
- **WHEN** round code attempts host or filesystem access
- **THEN** it MUST be denied by the sandbox

### Requirement: Compiled flows drive the real browser
Flow browser nodes MUST execute against the live page through the same engine
as rounds, with no silent simulated fallback.

#### Scenario: No simulated fallback
- **WHEN** a compiled flow with navigate and click nodes runs
- **THEN** the navigation and click MUST reach the browser
- **AND** no `Simulated` fallback line MUST be produced

### Requirement: Tabs, popups, and dialogs are managed
Pages MUST carry stable labels, popups MUST be reported on the action receipt,
and JS dialogs MUST be handleable without hanging the session.

#### Scenario: Popup is reported
- **WHEN** a click opens a new page
- **THEN** the receipt MUST name the new page label

#### Scenario: Dialog does not hang
- **WHEN** a JS dialog opens during automation
- **THEN** it MUST be reported and dismissable/acceptable
- **AND** the session MUST remain usable afterwards

### Requirement: Round execution is reachable on both surfaces
The same round engine MUST be reachable over REST
(`POST /api/v1/browser/:id/round`) and over MCP (`browser.run_round`).

#### Scenario: REST round
- **WHEN** JS round code is posted to `/api/v1/browser/:id/round`
- **THEN** it MUST execute and return console output plus the result

#### Scenario: MCP round
- **WHEN** `browser.run_round` is called with profile id and code
- **THEN** it MUST execute through the same engine with the same result shape

### Requirement: Human input routes through Motion
Human-click and human-type round calls MUST execute through the existing
Motion engine (Fitts-law trajectories, motor seed), not raw CDP input.

#### Scenario: Human click keeps biometrics
- **WHEN** a round calls the human click path on a selector
- **THEN** the pointer MUST travel a Motion-planned trajectory

### Requirement: Agent skill ships with the repo
A `SKILL.md` documenting the round workflow and the shipped surface MUST be
part of the repository and pointed to from the README.

#### Scenario: Skill documents only shipped methods
- **WHEN** the skill is read
- **THEN** every documented method signature MUST exist on the shipped surface

### Requirement: Screenshots use CSS pixels
Screenshots consumed by automation MUST be scaled so that image coordinates
match automation coordinates one-to-one regardless of device pixel ratio.

#### Scenario: HiDPI coordinates match
- **WHEN** a screenshot is taken on a display with devicePixelRatio 2
- **THEN** a coordinate read from the image MUST address the same point the
      automation layer addresses with the same numbers

### Requirement: Agent respects user control
When a profile is handed to the user, mutating agent calls MUST be refused
with a machine-readable code until control returns to the agent.

#### Scenario: Mutations blocked under user control
- **WHEN** control is with the user and an agent round is submitted
- **THEN** it MUST be refused with `USER_IN_CONTROL`

#### Scenario: Restart never wedges automation
- **WHEN** the process restarts
- **THEN** control MUST default to the agent

### Requirement: Existing surfaces keep their behavior
No existing MCP tool or Local API endpoint MUST change its observable behavior.

#### Scenario: Old tools frozen
- **WHEN** the pre-existing MCP tools and routes are exercised after this change
- **THEN** their outputs MUST be identical to before
