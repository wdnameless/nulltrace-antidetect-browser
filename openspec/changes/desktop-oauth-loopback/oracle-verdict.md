# Oracle verdict — desktop OAuth loopback flow

Read-only review by an independent security reviewer, contracted in full in `history://LoopbackOracle`.
Verified 7/9 reachable spec scenarios by reading code; raised 3 findings.

## Verdict

**Accept with fixes applied.** All three findings were confirmed as real and fixed; tests and
typechecks are green afterwards.

## Findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | high | 409 guard bypassable: the in-flight check ran before `beginLoopbackAuthorization` but the handle was assigned after it resolved, so a double-click bound two listeners and stranded the first promise | **Fixed** — a synchronous `authorizationInFlight` flag, claimed before the first await and released only when the background exchange finally completes. |
| 2 | medium | Cancel clobbered success: an idle cancel recorded a failure over a just-landed success, and cancel after the callback released the guard while the exchange still ran | **Fixed** — cancel records only when the flag says something was in flight; the detached exchange keeps 409 closed through the credential write. |
| 3 | low | Preflight fetch had no timeout: a stalled TLS handshake on a captive portal hung connect instead of failing open | **Fixed** — `AbortSignal.timeout(8000)`; the existing catch already falls through to the normal flow. |

## Confirmed clean

- `state` is required before any code is accepted; a mismatched callback gets a 400 and the flow keeps waiting. The favicon request is ignored.
- The listener binds to 127.0.0.1 only, on an ephemeral port; the result page is dependency- and script-free.
- One-button URL carries PKCE (S256), `access_type=offline`, a per-run `state`, and never a client secret.
- A rejected code promise after the route answered can no longer crash the process.
- The four scenarios the oracle could not verify from its file set (same-folder convergence, log append, build-time secret absence, spec delta) are covered by the parent's own evidence: the folder logic lives in the prior change (`nulltrace data` by name), `noteAuthorizationFailure` writes the log, the URL is the only outbound artifact and carries no secret.

## Acceptance

`npx tsc -p tsconfig.main.json --noEmit` clean, `npx tsc -p src/renderer/tsconfig.json --noEmit`
clean, `npx vitest run tests/unit/cloud tests/unit/gdrive.test.ts` 80/80, of which 11 exercise this
flow over a real listener.
