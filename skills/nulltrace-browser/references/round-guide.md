---
version: "0.6.90"
---

# NullTrace round guide

Run browser tasks as **one sandboxed script per round** via `browser.run_round`
(MCP) or `POST /api/v1/browser/:id/round` (REST). The round runs inside an
isolated `node:vm` worker bound to the profile; only `app.browser.*`,
`app.motion.*`, `app.log`, `app.profileId`, and standard JS globals exist.
No `require` / `process` / `fs` / DOM globals — page JavaScript belongs in
`app.browser.evaluate()`.

Do not chain one-action tool calls (`browser.click`, then `browser.type`,
then `browser.snapshot`, …). One chain = one round.

```javascript
// Canonical chain: fill → motion-click → wait → observe.
await app.browser.fill('input[name="username"]', 'operator@nulltrace.local');
await app.motion.type('input[name="password"]', 'CorrectHorseBatteryStaple');
const receipt = await app.motion.click('button[type="submit"]');
await app.browser.waitForURL('dashboard', { timeout: 15000 });
await app.browser.waitForLoadState('networkidle', { timeout: 10000 });
const snap = await app.browser.snapshot({ scope: 'viewport' });
return { receipt, snapshot: snap.text, refs: snap.refs };
```

## Work efficiently

- Each observation: cheapest state that picks the next action. Snapshot for
  semantic ground truth, screenshot for visual confirmation — never both by
  default.
- End the round with a fresh `snapshot()` so the next round can act directly.
  Without it the next round wastes a call observing first.
- If an action misses, inspect state before retrying. Never blindly repeat,
  never fall back to coordinates while DOM semantics exist.
- Once the page shows the result, stop. Do not re-confirm one result through
  several surfaces.
- Wait for expected state (`waitForURL` / `waitForSelector` / `waitForFunction`),
  not fixed delays. A snapshot captures the current moment; it does not wait.

## `app.browser.*` verbs

| Method | Signature | Returns |
| --- | --- | --- |
| `goto` / `navigate` | `(url, opts?: { timeout, waitUntil?, pageLabel? })` | `{ url, status, learnings? }` |
| `snapshot` | `(opts?: { scope?, root?, pageLabel? })` | `{ text, refs, truncated }` |
| `click` | `(selector, opts?: { timeout?, pageLabel? })` | `Receipt` |
| `fill` | `(selector, value, opts?: { pageLabel? })` | `{ filled, typed, verified?, outcome? }` |
| `type` | `(selector, text, opts?: { clear?, pageLabel? })` | `{ filled, typed, verified?, outcome? }` |
| `paste` | `(selector, text, opts?: { html?, pageLabel? })` | `{ pasted, outcome, verified, fallbackUsed }` |
| `waitForSelector` | `(selector, opts?: { timeout?, pageLabel? })` | `{ ok: true }` |
| `waitForURL` | `(url-substring, opts?: { timeout?, pageLabel? })` | `{ ok: true }` |
| `waitForFunction` | `(fn, opts?, arg?)` | `{ ok: true }` |
| `waitForLoadState` | `(state?: 'load' \| 'networkidle', opts?)` | `{ ok: true }` |
| `screenshot` | `(opts?: { fullPage?, pageLabel? })` | `{ base64, cssScale: true }` |
| `evaluate` | `(fn, arg?, opts?: { timeout? })` | JSON value |
| `tabs` | `()` | `[{ label, url, title? }]` |
| `newPage` | `()` | `{ label }` |
| `close` | `(label?)` | `{ ok: true }` |
| `acceptDialog` | `(text?)` | `{ ok: true }` |
| `dismissDialog` | `()` | `{ ok: true }` |
| `learnings.forUrl` / `list` / `add` / `remove` | see below | see below |

## `app.motion.*` verbs (humanized)

Routes through Fitts-law glide planning with seeded jitter and realistic
keystroke cadence. Prefer over `browser.click` / `browser.type` on
bot-sensitive pages.

| Method | Signature | Returns |
|---|---|---|
| `click` | `(selector, opts?: { x?, y?, targetWidth?, clickCount?, button?, pageLabel? })` | `Receipt` |
| `type` | `(selector, text, opts?: { allowTypos?, pageLabel? })` | `{ ok: true, typed: true }` |

`x`/`y` are CSS pixels for the visual workflow below; omit them to click the
selector's center. `targetWidth` tunes glide speed (default 32).

### Fill verification

`fill` and `type` read the control back after dispatching, because a dispatched
keystroke is not proof the field kept it — SPAs re-render on input, contenteditable
editors ignore synthetic text, read-only controls drop it silently. The envelope
reports what actually landed:

| `outcome` | Meaning | `filled` |
|---|---|---|
| `exact` | the value is there verbatim | `true` |
| `equivalent` | same number, different formatting (`1,000` for `1000`) | `true` |
| `transformed` | accepted, then reshaped by the app (masking, case, spacing) | `true` |
| `appended` | the old value was not cleared; text landed after it | `false` |
| `partial` | only a prefix landed | `false` |
| `unchanged` | nothing landed | `false` |
| `unverified` | the control could not be read back | `true` + `verified: false` |

On `filled: false`, click the field (or use `app.motion.type`) and verify again;
do not blindly re-dispatch — a settled rejection means the second type duplicates
or compounds the text. `unverified` is not a failure: proceed and confirm through
the page's own visible state.

### Rich text: `paste`

For editors (ProseMirror, Quill, Slate, Lexical, Google Docs-style surfaces) use
`paste` instead of `type`: it dispatches a `paste` event carrying a real
`DataTransfer`, so the editor takes the text **and** the HTML through its own
paste pipeline in one step. No key stream means no keyflood signature, and the
operator's OS clipboard is never borrowed, so nothing can be left clobbered.

```javascript
await app.browser.paste('@4', 'Name\tStatus', {
  html: '<table><tr><td>Name</td><td>Status</td></tr></table>',
});
```

The envelope mirrors `fill`: `pasted` is false on a verified drop, `outcome`
classifies what landed, and `fallbackUsed: true` means the page had no paste
listener and the text went in through `insertText` instead.

## Domain learnings

Knowledge that survives rounds. `goto` returns matching notes automatically —
read `result.learnings` before exploring a familiar host, and store what you
learned the hard way so the next session skips the rediscovery.

```javascript
// Stored once, after working out how the site really behaves.
await app.browser.learnings.add('*.shop.example', 'Prices appear only after the currency cookie is set; the banner covers the first click.');

// Later sessions get it for free on navigation:
const nav = await app.browser.goto('https://eu.shop.example/cart');
// nav.learnings -> [{ domainPattern, note, createdAt }]
```

| Verb | Signature | Result |
|---|---|---|
| `learnings.forUrl` | `(url)` | matching notes |
| `learnings.list` | `()` | every stored note |
| `learnings.add` | `(domainPattern, note)` | the created note |
| `learnings.remove` | `(id)` | `{ deleted }` |

Patterns are an exact hostname (`example.com`) or a subdomain wildcard
(`*.example.com`); there is no regex, so a stored pattern cannot become code.
Store a fact about the site, not a recipe that re-implements the round API.

## Selectors

`@21` or `ref=21` (latest snapshot) · `text=Save` / `text="Save"` (exact) ·
`loc=css:…` / `loc=role:button[name="…"]` / `loc=href:…` · `xpath=…` · raw CSS.
Exactly one match required; top document first, then frames / open shadow
roots. Refs invalidate on navigation — re-snapshot after the page changes.

## Snapshot scopes

- `viewport` (default): nodes in the visible viewport.
- `full_page`: whole document.
- `subtree` + `root: '@N'`: focus one branch (e.g. an iframe); existing refs
  are kept, new refs continue numbering. Full scopes replace the registry.

Snapshot shape:

```text
- RootWebArea "Dashboard"
  - textbox "Search items" [value=""] [ref=2]
  - button "Filter" [ref=3]
```

## Visual workflow: screenshot + coordinates

Only for canvas, maps, spreadsheets, rich editors — interfaces without DOM
semantics. Screenshots are CSS-pixel scaled: use the observed pixel
coordinates as-is.

```javascript
const shot = await app.browser.screenshot({});
// ... inspect shot.base64 with an image tool, read target (x, y) ...
const receipt = await app.motion.click('body', { x: 420, y: 260, targetWidth: 48 });
return { receipt };
```

Validate one small edit before repeating at scale; verify canvas results with
a screenshot or app-visible state, never DOM text.

## Receipts, popups, dialogs

`click` / `motion.click` return `{ ok: true, popups: [{ label }], dialog }`.
Popups auto-register as `p2`, `p3`, … — continue with
`opts: { pageLabel: 'p2' }`. A receipt covers only the dispatched action, not
the resulting app state. Handle `receipt.dialog` (`{ type, message }`) before
continuing:

```javascript
await app.browser.acceptDialog('prompt response');
// or: await app.browser.dismissDialog();
```

## Tabs

One profile starts with `p1`. `newPage()` adds `p2`, `p3`, …; every verb
takes `opts.pageLabel`. `tabs()` lists, `close('p2')` closes. Reuse pages
with `goto()`; never open a new page per URL.

## Handoff: `USER_IN_CONTROL`

`POST /api/v1/agent/handoff` switches a profile between `'agent'` (default)
and `'user'`. While `'user'`: rounds answer HTTP 409 `USER_IN_CONTROL`, all
mutating verbs reject, only `tabs()` and profile info stay readable. Stop
immediately — no retries, no workarounds. Resume after the operator confirms.

## Round envelope (REST)

`POST /api/v1/browser/:id/round` with `{ code, timeout_ms? }` answers:

```json
{ "code": 0, "msg": "success", "data": { "console": [], "result": {} } }
```

`console` carries `app.log` lines; `result` is the script's JSON return.

## MCP tools around rounds

- `profiles.start` / `profiles.stop` — boot/halt the profile browser first.
- `browser.snapshot`, `browser.tabs` — one-shot reads (they run a round each;
  inside a script call `app.browser.*` directly instead).
- `browser.screenshot` — one-shot CSS-pixel PNG `{ format, base64, sizeBytes }`.
- `browser.human_click` / `browser.human_type` — one-shot motion actions.
- `browser.evaluate_allowlisted` — page JS only via pre-registered templates.

[nulltrace:skill] end of guide
