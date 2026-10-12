## Why

AI agents driving NullTrace profiles today pay one LLM round-trip per action:
each MCP `browser.*` call does exactly one thing and returns raw output with no
page context. ego-lite proved the better shape — code-based rounds where one JS
snippet executes a whole chain (fill → click → wait → snapshot) and the page is
observed through a compact semantic snapshot with stable element refs. This
change brings that shape to NullTrace: less tokens per task, fewer rounds,
better success rate.

Two facts from reconnaissance shape the work:

1. **The MCP automation surface is thin and page-blind.** `mcp/src/browser.ts`
   always operates on `pages[0]`, has no snapshot, no waits, no tab registry,
   and screenshots in raw device pixels (coordinates don't match automation
   coords on HiDPI).
2. **The script sandbox is page-blind too.** `flows/compiler.ts` emits
   `app.browser.*` / `app.motion.*` calls, but `WORKER_SOURCE` in
   `src/main/scripts/scriptEngine.ts` never provides them — every compiled flow
   browser node silently degrades to `Simulated …` / HTTP fallbacks.

## What Changes

- **Snapshot engine**: semantic page snapshot (viewport / full-page / subtree
  scopes) with a stable `@ref` registry, additive to the existing MCP tools.
- **Code-round execution**: one JS snippet runs inside the existing
  `worker_threads` + `node:vm` sandbox with an `app.browser` facade
  (goto/click/fill/waits/snapshot/screenshot/evaluate), exposed on both REST
  (`POST /api/v1/browser/:id/round`) and MCP (`browser.run_round`). This also
  makes compiled flow browser nodes real.
- **Tabs + receipts**: stable page labels (`p1`, `p2`), popup tracking,
  JS-dialog handling (no more hung CDP sessions).
- **CSS-pixel screenshots** so coordinates match 1:1.
- **Agent/user handoff**: `user_in_control` blocks agent mutations until resume.
- **`SKILL.md`** for agent CLIs, shipped as a repo file.

## Capabilities

- Agent round execution over one engine, two surfaces (REST + MCP).
- Explicitly NOT changing: existing MCP tool behavior, Local API behavior,
  the Motion engine (stays primary for human input), sandbox isolation model.
- Out of scope: in-page `fetch()`, SKILL.md auto-install, engine C++ bindings.

## Non-goals

- Replacing puppeteer/CDP plumbing or the sandbox security model.
- Touching fingerprints, sync, teams, licensing, or UI design.
