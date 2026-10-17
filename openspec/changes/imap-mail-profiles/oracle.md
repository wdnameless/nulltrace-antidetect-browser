# Oracle verdict — imap-mail-profiles: ACCEPT (2/2 independent blind passes)

Model: nullform-gateway/gemini-3.8-flash-high (flash-class → double acceptance required, both ran).

## Pass A (FuzzyBooby) — ACCEPT
- `npx vitest run tests/unit/email.test.ts tests/unit/email-t1.test.ts tests/unit/email-routes.test.ts tests/unit/mcp/emailTools.test.ts tests/unit/sdk/nodeSdk.test.ts tests/unit/sdk/conformance.test.ts` → 6 files, 59 passed, exit 0
- `npm run typecheck:main && npm run typecheck:renderer` → 0 errors
- `npm run build:mcp` → 0 errors
- MCP runtime probe → 67 total tools, 17 `email.*` enumerated
- R01–R08: all PROVEN (quotes mapped to code + running artifact)

## Pass B (FinalFowl) — ACCEPT
- `npm run typecheck` → main + renderer exit 0
- `npm run openapi:check` → 5 passed
- Same 6-file vitest set → 59 passed, exit 0
- Live Express+DB+SMTP-mock probe: unknown-profile bind/create → 400 `Unknown profile_id`; failed send → provider text `535 5.7.8` + outbox `failed`; cache fallback carries `AUTHENTICATIONFAILED`; codes extracted; account masked (`has_password`, no `password_enc`)
- R01–R08: all PROVEN; NO-scope (no bulk, no pixel) and secrecy gates satisfied

## Reconciliation
Both passes independently ACCEPT. Zero conflicting findings. R01–R08 hold on the running
artifact. Full transcripts: history://FuzzyBooby, history://FinalFowl.
