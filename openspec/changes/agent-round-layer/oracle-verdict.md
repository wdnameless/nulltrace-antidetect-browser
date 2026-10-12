# Oracle verdict — agent-round-layer (Wave 4, double acceptance)

Model: `nullform-gateway/gemini-3.8-flash-high` (flash-class → two passes required).
Both passes judged BLIND vs `manifest.md` R01–R12i + the running product only
(no proposal/tasks/interfaces/specs read).

## Pass A (OraclePassA) — ACCEPT
- Full live probes: REST round (goto→snapshot→fill→click→wait, code 0),
  scopes viewport/full_page/subtree(@2)→@4, @ref click mutates DOM,
  handoff user→409 USER_IN_CONTROL / agent→200 resumed,
  MCP tabs/snapshot/run_round all 200, screenshot cssScale + 5840 bytes,
  motion click/type receipts ok, sandbox blocks require/process,
  old surfaces frozen.
- R01–R12i: all PASS. No blockers.

## Pass B (OraclePassB) — ACCEPT (independent, different probes)
- Subtree rooted at @1 isolates child button [ref=2]; dialog receipt
  `{"type":"alert","message":"Oracle Dialog Test 99"}`; tab p2 registered;
  user_in_control blocks mutate but allows tabs read; SKILL.md 8/8 signatures
  match scriptEngine.ts; R03 89/89 unit tests; old surfaces frozen.
- R01–R12i: all PASS. No blockers.

## Reconciliation
Both passes ACCEPT with no conflicting findings. G4 gate satisfied.
Known deviation (pre-existing, not from this change): `tests/unit/portableState.test.ts`
"portable launch" fails on this machine (env path `D:/NULLTRACE` override);
my branch touches none of its files (`git diff 05ab3f0..HEAD` = 0 lines there).
