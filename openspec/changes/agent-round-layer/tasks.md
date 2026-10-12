# Tasks — agent-round-layer

Frontier order: Z1 → Z2 → Z3, with Z4 anytime and Z5 last.
Typecheck + full suite green after every slice.

## 1. Z1 — Snapshot engine + selectors (R01, R05, R12i-partial)

- [x] 1.1 `src/main/automation/selectors.ts`: `parseSelector` + `resolveSelector`
      (grammar from interfaces.md §A; exactly-one or throw; top-doc-first,
      frames after; open shadow roots).
- [x] 1.2 `src/main/automation/snapshot.ts`: `captureSnapshot` via CDP
      Accessibility/DOM (viewport/full_page/subtree), compact role-tree text,
      `@ref` registry per (profile,page); `resolveRef`/`invalidateRefs`.
- [x] 1.3 CSS-pixel screenshots: `clip.scale = 1/devicePixelRatio` helper in the
      same module (R05).
- [x] 1.4 Unit tests `tests/unit/automation/*`: parser table, ambiguity errors,
      registry replace/retain semantics, invalidation on navigation, CSS-scale
      math. No live browser needed (mock CDP session seam).

## 2. Z2 — Round engine + REST (R02, R03, R08-REST, R11i, R12i)

blocked-by: 1.2 (needs `captureSnapshot` signature frozen)

- [x] 2.1 `WORKER_SOURCE`: add `app.browser` + `app.motion` facades over the
      existing worker channel (same pattern as `app.http`); JSON-only args.
- [x] 2.2 Main-side handlers: every `app.browser.*` from interfaces.md §B
      incl. waits; `app.motion.*` route through the Motion engine (R10i);
      `evaluate` timeout-bounded; handoff gate checked (R07 reads Z4 flag).
- [x] 2.3 `POST /api/v1/browser/:id/round` (`src/main/api/routes/round.ts`):
      `{code, timeoutMs?}` → `{console, result, error?}`; standard envelope.
- [x] 2.4 Regression proof for R03: a compiled flow browser node (`navigate` +
      `click`) executes against a stub `app` and asserts NO `Simulated` log
      line; full-suite + typecheck green.
- [x] 2.5 Route registration in the API router (orchestrator-owned mount).

## 3. Z3 — MCP tools (R04, R08-MCP, R09)

blocked-by: 2.2 (needs main-side handler contracts)

- [x] 3.1 `BrowserDriver` additions: label registry (`p1` default), `listTabs`,
      `newPage`, `closePage`, dialog listener → receipt; existing methods
      byte-identical behavior (R09 guard test: old tools' outputs unchanged).
- [x] 3.2 New tools `browser.run_round`, `browser.snapshot` (+ `browser.tabs`
      if cheap) in `toolManifest.ts` + `tools.ts` routing; Tier 1 default.
- [x] 3.3 `ActivityReporter` coverage for new tools; redaction of `code` args
      in audit log (secret-adjacent: may embed credentials).
- [x] 3.4 MCP surface tests `tests/unit/mcp/*`: manifest snapshot, routing,
      handoff-gate passthrough, R09 behavior-freeze on old tools.

## 4. Z4 — Handoff (R07) — parallel anytime

- [x] 4.1 `src/main/api/routes/handoff.ts`: POST/GET from interfaces.md §D;
      in-memory store (restart = `agent`); route registration (orchestrator mount).
- [x] 4.2 Gate enforcement in Z2 handlers + MCP passthrough return
      `{error, error_code: 'USER_IN_CONTROL'}`; tests incl. restart-default.

## 5. Z5 — SKILL.md (R06) — last

blocked-by: 3.2, 4.1 (documents the shipped surface)

- [x] 5.1 `skills/nulltrace-browser/SKILL.md`: round workflow, `app.browser`
      reference, handoff, examples; every signature copied from shipped
      zod/manifest (no invented methods).
- [x] 5.2 README pointer to the skill.

## 6. Verification

- [x] 6.1 Full suite + both typechecks green; `openspec validate` clean.
- [x] 6.2 Live round-trip: start a real profile, run one REST round
      (goto → fill → click → wait → snapshot), one MCP `browser.snapshot`;
      paste outputs as evidence.
- [x] 6.3 Oracle blind acceptance vs manifest R01–R12i.
