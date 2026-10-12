---
name: nulltrace-browser
description: Direct round automation, accessibility snapshots, motion control, and multi-tab orchestration for NullTrace browser profiles.
tools:
  - browser.run_round
  - browser.snapshot
  - browser.tabs
---

# NullTrace Browser Automation Skill

This skill documents the shipped agent automation layer for NullTrace browser profiles.
The runtime provides an in-sandbox JavaScript automation surface (`app.browser.*` and `app.motion.*`) executed via atomic code rounds over REST or MCP, backed by a semantic accessibility snapshot engine with stable `@ref` selectors, multi-tab orchestration, and operator handoff gates.

---

## 1. Round Workflow & Action Chaining

Rather than dispatching multiple round-trip tool calls across the wire for every individual browser action, agents execute an entire action chain in a single sandboxed round using `browser.run_round` (MCP) or `POST /api/v1/browser/:id/round` (REST).

### Canonical Action Chain: fill → click → wait → snapshot

```javascript
// Step 1: Fill login credentials using semantic @ref or CSS locators
await app.browser.fill('input[name="username"]', 'operator@nulltrace.local');
await app.motion.type('input[name="password"]', 'CorrectHorseBatteryStaple', { allowTypos: true });

// Step 2: Trigger submission using human-like motion or browser click
const receipt = await app.motion.click('button[type="submit"]', { targetWidth: 48 });

// Step 3: Wait for post-action navigation or element state
await app.browser.waitForURL('dashboard', { timeout: 15000 });
await app.browser.waitForLoadState('networkidle', { timeout: 10000 });

// Step 4: Capture fresh accessibility snapshot with refreshed @ref labels
const snapshot = await app.browser.snapshot({ scope: 'viewport' });

// Return round result to the agent
return {
  receipt,
  snapshot: snapshot.text,
  refs: snapshot.refs
};
```

---

## 2. Complete Shipped API Reference

Round scripts run inside an isolated `node:vm` worker context bound to the profile. All calls are asynchronously dispatched over the internal RPC channel.

### `app.browser.*` Facade

| Method | Parameters | Return Type | Description | Disk Citation |
|---|---|---|---|---|
| `goto(url, opts?)` | `url: string`, `opts?: { timeout?: number, waitUntil?: string, pageLabel?: string }` | `Promise<{ url: string, status: number \| null }>` | Navigates page to URL. `waitUntil` defaults to `'domcontentloaded'`. | `src/main/scripts/scriptEngine.ts:777` |
| `navigate(url, opts?)` | `url: string`, `opts?: { timeout?: number, waitUntil?: string, pageLabel?: string }` | `Promise<{ url: string, status: number \| null }>` | Alias for `goto`. | `src/main/scripts/scriptEngine.ts:778` |
| `snapshot(opts?)` | `opts?: { scope?: 'viewport' \| 'full_page' \| 'subtree', root?: string, pageLabel?: string }` | `Promise<SnapshotResult>` | Captures semantic role-tree with `@ref` markers. | `src/main/scripts/scriptEngine.ts:779` |
| `click(selector, opts?)` | `selector: string`, `opts?: { timeout?: number, pageLabel?: string }` | `Promise<Receipt>` | Clicks target element. Returns popup/dialog receipt. | `src/main/scripts/scriptEngine.ts:780` |
| `fill(selector, value, opts?)` | `selector: string`, `value: string`, `opts?: { pageLabel?: string }` | `Promise<{ filled: true, typed: true }>` | Clears and sets value via element value setter. | `src/main/scripts/scriptEngine.ts:781` |
| `type(selector, text, opts?)` | `selector: string`, `text: string`, `opts?: { clear?: boolean, pageLabel?: string }` | `Promise<{ filled: true, typed: true }>` | Dispatches keystrokes to target selector. | `src/main/scripts/scriptEngine.ts:782` |
| `waitForSelector(selector, opts?)` | `selector: string`, `opts?: { timeout?: number, pageLabel?: string }` | `Promise<{ ok: true }>` | Polls until selector is found or timeout (default 10s). | `src/main/scripts/scriptEngine.ts:783` |
| `waitForURL(url, opts?)` | `url: string`, `opts?: { timeout?: number, pageLabel?: string }` | `Promise<{ ok: true }>` | Polls until page URL contains target string (default 10s). | `src/main/scripts/scriptEngine.ts:784` |
| `waitForFunction(fn, opts?, arg?)` | `fn: Function \| string`, `opts?: { timeout?: number, pageLabel?: string }`, `arg?: unknown` | `Promise<{ ok: true }>` | Waits for predicate function to evaluate truthy. | `src/main/scripts/scriptEngine.ts:785` |
| `waitForLoadState(state?, opts?)` | `state?: 'load' \| 'networkidle'`, `opts?: { timeout?: number, pageLabel?: string }` | `Promise<{ ok: true }>` | Waits for `'networkidle'` or `document.readyState === "complete"`. | `src/main/scripts/scriptEngine.ts:786` |
| `screenshot(opts?)` | `opts?: { fullPage?: boolean, pageLabel?: string }` | `Promise<{ base64: string, cssScale: true }>` | Captures base64 PNG screenshot scaled to CSS pixels. | `src/main/scripts/scriptEngine.ts:787` |
| `evaluate(fn, arg?, opts?)` | `fn: Function \| string`, `arg?: unknown`, `opts?: { timeout?: number, pageLabel?: string }` | `Promise<unknown>` | Evaluates code in page context; JSON-serialized result. | `src/main/scripts/scriptEngine.ts:788` |
| `tabs()` | *none* | `Promise<Array<{ label: string, url: string, title?: string }>>` | Lists open tabs for current profile. | `src/main/scripts/scriptEngine.ts:789` |
| `newPage()` | *none* | `Promise<{ label: string }>` | Creates and tracks a new page (e.g. `'p2'`). | `src/main/scripts/scriptEngine.ts:790` |
| `close(label?)` | `label?: string` | `Promise<{ ok: true }>` | Closes target page tab (defaults to `'p1'`). | `src/main/scripts/scriptEngine.ts:791` |
| `acceptDialog(text?)` | `text?: string` | `Promise<{ ok: true }>` | Accepts active JavaScript alert/confirm/prompt. | `src/main/scripts/scriptEngine.ts:792` |
| `dismissDialog()` | *none* | `Promise<{ ok: true }>` | Dismisses active JavaScript dialog. | `src/main/scripts/scriptEngine.ts:793` |

### `app.motion.*` Facade (Humanized Physics & Motor Modeling)

`app.motion` routes all actions through the Fitts' law path planning engine (`motionSessions`) with curved pointer glides, jitter, and realistic keystroke intervals:

| Method | Parameters | Return Type | Description | Disk Citation |
|---|---|---|---|---|
| `click(selector, opts?)` | `selector: string`, `opts?: { x?: number, y?: number, targetWidth?: number, clickCount?: number, button?: 'left' \| 'right' \| 'middle', pageLabel?: string }` | `Promise<Receipt>` | Performs a Fitts' law glide from current mouse position to target and dispatches mouse click. Returns receipt. | `src/main/scripts/scriptEngine.ts:796` |
| `type(selector, text, opts?)` | `selector: string`, `text: string`, `opts?: { allowTypos?: boolean, pageLabel?: string }` | `Promise<{ ok: true, typed: true }>` | Focuses target and types text with realistic cadence, pauses, and optional human typos. | `src/main/scripts/scriptEngine.ts:797` |

### Logging & Context Helpers

- `console.log(msg)` / `app.log(msg)`: Stream lines into the round execution result (`outcome.logs`).
- `app.profileId`: Bound ID of the active browser profile.

---

## 3. Selector Grammar & Snapshot Scopes

### Supported Selector Grammar

Selectors passed to `click`, `fill`, `type`, `waitForSelector`, and motion methods support the unified grammar defined in `src/main/automation/selectors.ts:60-153`:

1. **Ref Selectors**: `@21` or `ref=21` — references an element index from the most recent snapshot.
2. **Text Locators**:
   - Substring match: `text=Sign In`
   - Exact match: `text="Sign In"` or `text='Sign In'`
3. **Prefixed Locators (`loc=...`)**:
   - CSS locator: `loc=css:button.primary`
   - Role locator: `loc=role:button` or `loc=role:button[name="Submit"]`
   - Href locator: `loc=href:/auth/login`
4. **XPath Locators**: `xpath=//button[contains(@class, "btn-login")]`
5. **Raw CSS Selectors**: `#user-id`, `.btn-primary`, `input[type="text"]`

Search order: Top document is evaluated first; frames and open shadow roots are inspected next. Ambiguity where multiple candidate elements match throws an error.

### Semantic Accessibility Snapshots

The snapshot engine (`src/main/automation/snapshot.ts:340-634`) generates a compact AX role tree formatted as:
```text
- RootWebArea "Dashboard"
  - heading "Overview"
  - navigation
    - link "Settings" [ref=1]
  - main
    - textbox "Search items" [value=""] [ref=2]
    - button "Filter" [ref=3]
```

### Snapshot Scopes

- `'viewport'` (default): Renders only nodes currently bounded within the active layout viewport dimensions.
- `'full_page'`: Traverses and renders the full accessibility tree of the entire document.
- `'subtree'`: Focuses inspection on a specific root ref element via `root: '@N'` or `root: 'ref=N'`.

### `@ref` Stability & Lifecycle Rules

- **Interactive Assignment**: `@ref` identifiers are assigned sequentially only to interactive elements (`button`, `link`, `textbox`, `searchbox`, `combobox`, `listbox`, `checkbox`, `radio`, `switch`, `menuitem`, `tab`, `slider`, `option`, `input`) within the chosen scope.
- **Scope Replacement vs. Retention**:
  - A full snapshot (`viewport` or `full_page`) replaces the registry for `(profileId, pageLabel)`.
  - A `subtree` snapshot retains existing refs in the registry and assigns incremental numbers starting after the highest existing ref (`nextRefIndex = maxNum + 1`).
- **Registry Invalidation**: Navigating to a new page or resetting the session invalidates cached refs for that page.

---

## 4. Multi-Tab Management & Dialog Receipts

### Tab Labels (`p1`, `p2`, ...)

- Every profile starts with an initial primary tab labeled `'p1'`.
- Additional tabs created via `app.browser.newPage()` or spawned through window popups receive sequential labels (`p2`, `p3`, ...).
- Methods accept `opts.pageLabel` (e.g. `{ pageLabel: 'p2' }`) to target specific tabs.
- `app.browser.tabs()` returns all active tabs with their labels, current URLs, and titles.
- `app.browser.close('p2')` terminates a specific tab.

### Action Receipts & Popup Tracking

Mutating operations (`app.browser.click`, `app.motion.click`) return a `Receipt`:

```typescript
interface Receipt {
  ok: true;
  popups: Array<{ label: string }>;
  dialog: null | { type: string; message: string };
}
```

- When an action triggers a popup (`window.open`), the new tab is automatically registered (e.g. `'p2'`) and listed in `receipt.popups`.
- Popups are drained upon receipt generation so subsequent actions only report newly opened tabs.

### Dialog Handling (`alert`, `confirm`, `prompt`)

- JavaScript dialogs are intercepted asynchronously and stored on the session rather than hanging browser execution.
- If a dialog is open, `receipt.dialog` reports `{ type, message }`.
- Resolve dialogs using:
  ```javascript
  await app.browser.acceptDialog('optional prompt response text');
  // or
  await app.browser.dismissDialog();
  ```

---

## 5. Operator Handoff & `USER_IN_CONTROL` Behavior

NullTrace implements a concurrency gate (`src/main/api/routes/handoff.ts`) allowing human operators to take manual control of a profile without automation interference.

### Controller States

- `'agent'` (default): Full automation allowed.
- `'user'`: Profile is under manual operator control.

### Gate Enforcement

When a profile is marked `'user'`:
- `POST /api/v1/browser/:id/round` immediately responds with HTTP 409:
  ```json
  {
    "code": -1,
    "msg": "USER_IN_CONTROL",
    "error": "USER_IN_CONTROL",
    "error_code": "USER_IN_CONTROL",
    "data": { "console": [], "result": null, "error": "USER_IN_CONTROL", "error_code": "USER_IN_CONTROL" }
  }
  ```
- Mutating round RPC methods (`browser.goto`, `browser.click`, `browser.fill`, `browser.type`, `browser.newPage`, `browser.close`, `browser.acceptDialog`, `browser.dismissDialog`, `motion.click`, `motion.type`, `browser.snapshot`) reject with `{ error_code: 'USER_IN_CONTROL' }`.
- Read-only operations (`app.browser.tabs()`, profile info) remain available.
- State is held in-process memory; a process restart automatically resets all profile states back to `'agent'`.

### Managing Handoff State

- **Check State**: `GET /api/v1/agent/handoff?profile_id=<id>`
- **Set State**: `POST /api/v1/agent/handoff` with body:
  ```json
  {
    "profile_id": "prof_123",
    "state": "agent"
  }
  ```

---

## 6. Runnable Examples

### Example 1: REST API Round via `curl`

Execute a round against a running profile on the Local API (`http://127.0.0.1:50325`):

```bash
curl -X POST http://127.0.0.1:50325/api/v1/browser/prof_123/round \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-api-key" \
  -d '{
    "timeout_ms": 30000,
    "code": "await app.browser.goto(\"https://example.com\"); await app.browser.waitForSelector(\"h1\"); const snap = await app.browser.snapshot({ scope: \"viewport\" }); return { headingVisible: true, snapText: snap.text };"
  }'
```

**Expected Envelope Response (`src/main/api/routes/round.ts:85-92`):**
```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "console": [],
    "result": {
      "headingVisible": true,
      "snapText": "- RootWebArea \"Example Domain\"\n  - heading \"Example Domain\"\n  - link \"More information...\" [ref=1]"
    }
  }
}
```

### Example 2: MCP Tool `browser.run_round`

Invoking via Model Context Protocol (`toolManifest.ts:162-175`, `tools.ts:244-279`):

```json
{
  "name": "browser.run_round",
  "arguments": {
    "profile_id": "prof_123",
    "timeout_ms": 25000,
    "code": "await app.browser.goto('https://example.com/login');\nawait app.browser.fill('@1', 'analyst');\nawait app.motion.type('@2', 'SecretPass2026!');\nconst receipt = await app.motion.click('@3');\nawait app.browser.waitForLoadState('networkidle');\nconst snap = await app.browser.snapshot({ scope: 'viewport' });\nreturn { receipt, snapshot: snap.text, refs: snap.refs };"
  }
}
```

**MCP Return Value:**
```json
{
  "receipt": {
    "ok": true,
    "popups": [],
    "dialog": null
  },
  "snapshot": "- RootWebArea \"Application Portal\"\n  - heading \"Welcome\"\n  - button \"Sign out\" [ref=1]",
  "refs": ["@1"]
}
```

---

## 7. Shipped Contract Citations

Every method and signature documented in this skill is verified directly from disk:

| Component / Method Group | Source File & Lines |
|---|---|
| Round REST Route & Schema | `src/main/api/routes/round.ts:8-106` |
| Handoff Route & Concurrency Gate | `src/main/api/routes/handoff.ts:8-97` |
| MCP Tool Manifest (`browser.run_round`, `browser.snapshot`, `browser.tabs`) | `mcp/src/toolManifest.ts:162-201` |
| MCP Tool Dispatch & Handoff Passthrough | `mcp/src/tools.ts:244-330` |
| Worker Sandbox `app.browser.*` Facade | `src/main/scripts/scriptEngine.ts:777-793` |
| Worker Sandbox `app.motion.*` Facade | `src/main/scripts/scriptEngine.ts:796-797` |
| Main Host RPC Dispatcher & Handlers | `src/main/scripts/scriptEngine.ts:166-523` |
| Action Receipt Builder & Event Listeners | `src/main/scripts/scriptEngine.ts:121-155, 188-195` |
| Selector Grammar Parser (`parseSelector`) | `src/main/automation/selectors.ts:60-153` |
| Selector Resolver (`resolveSelector`) | `src/main/automation/selectors.ts:413-547` |
| Accessibility Tree & Snapshot Engine | `src/main/automation/snapshot.ts:340-634` |
| Snapshot Scopes & Ref Registry | `src/main/automation/snapshot.ts:98-142, 427-458, 546-577` |
