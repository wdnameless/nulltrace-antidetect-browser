# Requirements manifest — agent-round-layer

Wave 0 closed via widget 2026-10-12. Every row traces to the operator's own words.
`i`-suffix = implicit requirement from the agreed ego-lite analysis the operator
approved with «Приступай». Silence never cancels a row.

Verbatim sources in this session:
- «проанализируй этот браузер и скажи что мы можем взять из него нам» (brief, ego-lite)
- «Приступай» (build order on the 6-item adoption analysis)
- Widget: scope «Все 6 пунктов», surface «REST + MCP», skill «Только файл в репо», compat «Строго аддитивно»

| ID | Requirement | Verbatim source | Status |
|---|---|---|---|
| R01 | Semantic page `snapshot()` with stable `@ref` element registry (viewport / full-page / subtree scopes) | «Приступай» + scope «Все 6 пунктов» (п. snapshot+@ref) | in-spec |
| R02 | Code-round: one JS snippet executes a whole action chain (navigate/fill/click/wait/snapshot) in a single pass | «Приступай» + scope «Все 6 пунктов» (п. code-round) | in-spec |
| R03 | Compiled flow browser nodes (`app.browser.*`, `app.motion.*`) execute for real instead of falling back to `Simulated …` | «Приступай» (анализ: «заодно чинит баг … и живые flow-ноды») | in-spec |
| R04 | Tab registry with stable labels (`p1`, `p2`) + action `receipt` (popups/dialogs), dialogs handled not hung | «Приступай» + scope «Все 6 пунктов» (п. вкладки+receipt) | in-spec |
| R05 | Screenshots in CSS pixels (`1/dpr` scale) so image coords match automation coords 1:1 | «Приступай» + scope «Все 6 пунктов» (п. CSS-scale) | in-spec |
| R06 | NullTrace `SKILL.md` for AI agents shipped as a file in the repo (+ README pointer) | skill «Только файл в репо» | in-spec |
| R07 | Agent/user handoff: `user_in_control` state blocks agent mutations; resume by command | «Приступай» + scope «Все 6 пунктов» (п. handoff) | in-spec |
| R08 | Round execution exposed on BOTH surfaces: REST (`POST /api/v1/browser/:id/round`) and MCP (`browser.run_round`) | surface «REST + MCP» | in-spec |
| R09 | Strictly additive: no existing MCP tool or Local API changes observable behavior | compat «Строго аддитивно» | in-spec |
| R10i | `Motion` (Fitts-law + motor seed) stays the primary human input path; `@ref` routes through it | «Приступай» (анализ: «наш Motion … остаётся основным») | in-spec |
| R11i | Round code runs inside the existing `worker_threads` + `node:vm` sandbox, never a bare `AsyncFunction` with OS access | «Приступай» (анализ: «раунды исполняем внутри него») | in-spec |
| R12i | Explicit wait primitives (`waitForSelector`/`waitForURL`/`waitForFunction`/`waitForLoadState`) as part of the round API | «Приступай» + scope «Все 6 пунктов» (п. code-round) | in-spec |

Out of scope (not ordered, not in spec): in-page `fetch()` (scout G7, never
presented); auto-install of SKILL.md into agent CLIs (explicitly declined);
C++ engine bindings (declined in analysis); scheduled sync; billing.
