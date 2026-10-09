# Recon: Cloud Sync bug sweep

## Audit method
Three read-only scout slices (engine/routes/UI) produced 43 raw claims.
Orchestrator re-verified each against the code; 12 confirmed, 31 rejected
(speculative races, already-guarded interleaves, misread code, or intended behavior).

## Confirmed (R01-R12 in manifest.md)
- R01 `gdriveSync.ts:577` start clears lastError (seen live).
- R02 `CloudSync.tsx:300` poll eats stale lastError (seen live).
- R03 `gdriveTransfer.ts:807` vs `CloudSync.tsx:1590` conflict shape crash.
- R04 `gdriveClient.ts:291` NaN token expiry.
- R05 refresh rejection keeps dead grant.
- R06 credential swap keeps old grant.
- R07 disconnect leaves folderId/email.
- R08 mirror utf8 fallback corrupts gzip.
- R09 stop leaves trailing work.
- R10 unlock double-syncs.
- R11 poll leak + no Cancel on progress.
- R12 actions enabled while locked/syncing.

## Rejected (R13)
Merge tombstone logic (commented, tested, no repro), remote-commit races,
transaction wrapping, cancel-interleave rework, device-poll claim (cleanup exists),
`configured=true` (shipped client by design).

## Files to touch
Backend: `gdriveSync.ts`, `gdriveAuth.ts`, `gdriveClient.ts`, `gdriveFullMirror.ts`.
UI: `CloudSync.tsx`, `i18n.tsx`. Tests alongside.

## Acceptance check
- Targeted suites pass; typecheck clean; openspec strict valid.
- Oracle blind audit ACCEPT; v0.6.62+ CI green.
