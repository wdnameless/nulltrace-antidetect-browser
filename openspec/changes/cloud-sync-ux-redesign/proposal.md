# cloud-sync-ux-redesign — Proposal

## Why
The Cloud Sync page connected state shows a 6-cell metadata grid, 8 equal-weight buttons
(including destructive Disconnect and directional Pull/Push), a raw SQL error string, and an
experimental mirror panel — all at once. The operator's verdict: "это все выглядит очень страшно".
Separately, sync crashes with `no such column: launch_args` on databases created before that
column existed in `profile_extensions`, because no migration adds it.

## What changes
1. **Crash fix (R01):** add `profile_extensions` to the migration allowlist and
   `ensureColumn(db, 'profile_extensions', 'launch_args', 'TEXT')` in `schema.ts`.
2. **Connected-state redesign (R02–R06):** one status card + one Sync now button; everything
   secondary behind an Advanced disclosure; destructive actions behind confirm dialogs; human
   error text with Details + Retry.
3. **No behavior change (R07–R08):** same engine, triggers, encryption, API; self-hosted and
   Teams sections untouched.

## Alternatives considered
- Sync-code workaround (catch missing column, skip table): hides schema drift, leaves every old
  DB one query away from the next crash. Migration fixes the root cause.
- Full dashboard redesign: rejected by operator in Wave 0 (chose minimal layout).
