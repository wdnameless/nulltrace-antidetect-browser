# cloud-sync-bug-sweep — Proposal

## Why
A three-slice audit of the Cloud Sync surface produced 43 raw claims; 12 were confirmed
against the code (the rest rejected as speculative or already-guarded). The confirmed set
includes a React crash on conflicts, status lies (`connected` with a dead token), error
clobbering that hid real failures live, and missing UI gates. This change fixes exactly
the confirmed set.

## What changes
- Backend (`gdriveSync`, `gdriveAuth`, `gdriveClient`, `gdriveFullMirror`): R01, R04–R10.
- UI (`CloudSync.tsx` + i18n): R02, R03, R11, R12.
- Regression tests per fix where unit-testable.
- Release v0.6.62 ships the crash fix + redesign + this sweep.

## Non-goals (R13)
Remote-commit race rework, tombstone/merge redesign, transaction wrapping of the apply phase,
cancel-interleave rework — all rejected without a repro.
