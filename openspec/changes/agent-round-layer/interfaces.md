# Interfaces — agent-round-layer

Deep modules, narrow seams. One engine, two surfaces. Additive only (R09):
no existing signature changes behavior; new names only.

## A. Snapshot engine (new, backend-owned)

Lives beside the launcher (seam: CDP session of a running profile).
Consumers: REST `/round`, MCP tools, future flows. Never imports MCP code.

```ts
// src/main/automation/snapshot.ts (new module)
export type SnapshotScope = 'viewport' | 'full_page' | 'subtree';
export interface SnapshotOptions { scope?: SnapshotScope; root?: string; } // root = '@N'
export interface SnapshotResult {
  text: string;                 // compact role tree, refs like [ref=21]
  refs: string[];               // all refs present in text, for validation
  truncated: boolean;
}
export async function captureSnapshot(profileId: string, page: unknown, opts?: SnapshotOptions): Promise<SnapshotResult>;
// @ref registry: per (profileId, pageLabel) → { frameId, backendNodeId }; full snapshot replaces, subtree retains
export function resolveRef(profileId: string, pageLabel: string, ref: string): { frameId: string; backendNodeId: number } | null;
export function invalidateRefs(profileId: string, pageLabel?: string): void; // call on navigation/raw CDP
```

Selector grammar (shared, one parser): `@21` | `ref=21` | `text=…` |
`text="…"` (exact) | `loc=css:…` | `loc=role:…` | `loc=href:…` |
`xpath=…` | raw CSS. Search order: top document first, then frames; ambiguity = error.

```ts
// src/main/automation/selectors.ts (new module)
export function parseSelector(sel: string): ParsedSelector; // throws on invalid
export async function resolveSelector(page: unknown, sel: string, profileId: string, pageLabel: string): Promise<ResolvedNode>; // exactly-one or throw
```

## B. Round execution (backend-owned, sandboxed)

Engine: existing `invokeScriptTask` path; `WORKER_SOURCE` gains `app.browser`
+ `app.motion` facades that call back into main over the existing worker
channel pattern (same as `app.http`/`app.profiles` today).

```ts
// app.* surface visible to round code (workerData.profileId bound)
app.browser.goto(url, opts?) → { url, status }
app.browser.snapshot(opts?) → SnapshotResult
app.browser.click(sel, opts?) → Receipt
app.browser.fill(sel, value, opts?) → { filled: true }
app.browser.waitForSelector(sel, opts?) / waitForURL / waitForFunction / waitForLoadState → { ok: true }
app.browser.screenshot(opts?) → { base64, cssScale: true }
app.browser.evaluate(fnString, arg?) → unknown            // JSON round-trip, timeout-bounded
app.browser.tabs() / newPage() / close(label?) → labels   // R04
app.browser.acceptDialog(text?) / dismissDialog() → { ok: true }
app.motion.click(sel, opts?) / app.motion.type(sel, text, opts?) → human path (R10i)
interface Receipt { ok: true; popups: Array<{ label: string }>; dialog: null | { type: string; message: string }; }
```

REST (additive route, same envelope `{code,msg,data}`):

```
POST /api/v1/browser/:id/round   body { code: string, timeoutMs?: number }
  → { console: string[], result: unknown, error?: string }
```

MCP (additive tool, Tier 1 default — round code runs in the sandbox, no OS):

```
browser.run_round { profile_id: string, code: string, timeout_ms?: number }
browser.snapshot  { profile_id: string, scope?: ..., root?: ..., page?: "p1" }
```

## C. Tabs + receipts (extends BrowserDriver, additive)

```ts
// mcp/src/browser.ts additions (existing methods untouched)
getPageByLabel(profileId: string, label: string): Promise<Page>  // internal registry, default 'p1'
listTabs(profileId: string): Promise<TabDesc[]>
newPage(profileId: string): Promise<{ label: string }>
closePage(profileId: string, label: string): Promise<{ ok: true }>
```

Dialog listener per profile (armed once per connection): `Page.javascriptDialogOpening`
→ recorded on the pending receipt; `acceptDialog`/`dismissDialog` via CDP.

## D. Handoff (new isolated router + profile flag)

```
POST /api/v1/agent/handoff { profile_id, state: 'user' | 'agent' }
GET  /api/v1/agent/handoff?profile_id=… → { controller: 'user' | 'agent' }
```

When `controller === 'user'`: `browser.run_round`, `browser.snapshot`,
mutating `app.browser.*` resolve `{ error, error_code: 'USER_IN_CONTROL' }`
(R07). Reads (`tabs`, `info`) stay allowed. Default `agent`. In-memory
(per process), not persisted — a restart must never wedge automation.

## E. SKILL.md (docs-only)

`skills/nulltrace-browser/SKILL.md` + README pointer. Documents sections B–D
surface contracts only; generated from `references/api.md`-style source of
truth kept next to the tools (single source: toolManifest + route zod
schemas). No auto-install (declined).

## Owners / zones (disjoint)

| Zone | Files | Owner slice |
|---|---|---|
| Z1 snapshot+selectors | `src/main/automation/*`, `tests/unit/automation/*` | builder A |
| Z2 round engine+REST | `src/main/scripts/scriptEngine.ts`, `src/main/api/routes/round.ts`, `tests/unit/scripts/*` | builder B (after Z1 API frozen) |
| Z3 MCP tools | `mcp/src/*`, `tests/unit/mcp/*` | builder C (after Z1+Z2 contracts) |
| Z4 handoff | `src/main/api/routes/handoff.ts`, `tests/unit/handoff/*` | builder D (parallel anytime) |
| Z5 skill | `skills/nulltrace-browser/*`, `README.md` pointer | builder E (last, from shipped surface) |

Mounting (`server.ts`, `index.ts` route registration) is orchestrator-owned
integration, not a builder zone.
