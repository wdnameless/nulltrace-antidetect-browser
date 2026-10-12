# Recon — agent-round-layer (Wave 1, 2026-10-12)

Facts (verified in code, not assumed):
- `mcp/src/browser.ts`: `BrowserDriver.getActivePage` → `pages[0]` always;
  tools: navigate/click/type/humanType/humanClick/screenshot/evaluateAllowlisted.
  No snapshot, no waits, no tabs.
- `mcp/src/tools.ts` `ToolRouter.callTool` → `executeToolInternal` → BrowserDriver;
  manifest in `mcp/src/toolManifest.ts`; activity via `ActivityReporter.report`.
- `src/main/scripts/scriptEngine.ts`: `WORKER_SOURCE` exposes app facade
  (profileId/profiles/proxy/keys/callModule/http/persona/log) — NO app.browser,
  NO app.motion. `invokeScriptTask({taskUuid,scriptId,profileId,...})`.
- `src/main/api/routes/scripts.ts`: `POST /api/v1/scripts/:id/invoke`
  `{profile_id,args}` → invokeScriptTask.
- `src/main/flows/compiler.ts`: `compileFlowToScript` emits
  `app.browser.navigate/click/type/waitForSelector/extract/screenshot` and
  `app.motion.click/type` with `Simulated …` else-branches.
- Flow execution: `storage.runFlowViaTaskGroup` → `taskQueue` →
  `invokeScriptTask` → WORKER_SOURCE → fallbacks confirmed live path.
- `src/main/launcher/chromium.ts`: `getRunningWs(profileId)`,
  `getCdpEndpoint(profileId)` — CDP seam for snapshot engine.
- Local API: navigate/evaluate exist ONLY as `/api/v1/browser/firefox/*`;
  Chromium has none.
- Tests: `tests/unit/{mcp,scripts,flows,motion}/`; suite via vitest.

Acceptance for this recon: disjoint zones Z1–Z5 frozen in interfaces.md §E;
blocking edges Z1→Z2→Z3, Z4 parallel, Z5 last. Done.
