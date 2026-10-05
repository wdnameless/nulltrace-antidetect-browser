# Oracle verdict — two-way Google Drive sync

Audited by an independent read-only security reviewer against `specs/cloud-sync/spec.md`,
`interfaces.md` and the implementation. Blind to the parent's own claims: it re-derived coverage by
reading code, and every finding was checked against a concrete trigger before being accepted.

## Verdict

**Accept with fixes applied.** The contract is implemented. Fourteen findings were raised; thirteen
are fixed and pinned by tests, one is informational. Two were serious enough to be real defects the
passing suite could not see.

## Findings and disposition

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | high | `secretCodec.encode` wrote the proxy ciphertext then deleted it under the same name, so `INSERT OR REPLACE` blanked proxy passwords and SSH keys on every pull | **Fixed** — the portable name is deleted only when it differs from the stored name. Pinned by "keeps a proxy password and SSH key usable on the second machine". |
| 2 | high | The tombstone branch ran before any local-change check, so an operator's Restore was re-trashed every cycle and could never stick | **Fixed** — a local row whose hash differs from the baseline that recorded the tombstone wins and the tombstone is dropped. Pinned by "lets the operator undo a delete instead of re-applying it forever". |
| 3 | high | An unrevealable secret travelled as `null` and was written as NULL, wiping a credential the receiving machine could still open | **Fixed** — an unrevealable value is omitted from the portable row instead, and `applyRow` carries the local ciphertext forward. Pinned by "does not blank a working credential when the sending machine could not read its own". |
| 4 | high | The mirror uploaded then downloaded the same archive, so two machines overwrote each other's site state and each restored only its own bytes | **Fixed** — the remote is read and restored first; the local archive is published only after, and only the amount that actually crosses machines is logged. |
| 5 | medium | No compare-and-swap on the manifest: two machines committing together silently discarded one payload, and the loser read the reversion as an ordinary pull | **Fixed** — the manifest is re-read immediately before the write and the cycle refuses to commit over a newer revision. Pinned by "refuses to commit over a revision another machine committed meanwhile". |
| 6 | medium | The base snapshot advanced even when post-write verification failed, so one silent failure became permanent quiet data loss | **Fixed** — the base is written only when the commit verifies. |
| 7 | medium | `devices` is not a synced table, so an unresolvable device preset was cleared and the erasure propagated back to the machine that had it | **Fixed** — `device_id`, `proxy_id` and `group_id` are passed only when the bundle actually carries them; `updateProfile` treats `undefined` as "leave alone". |
| 8 | medium | The full-mirror tier still could not upload: a base64 string bypassed the 5 MB resumable branch | **Fixed** — raw bytes end to end, no base64. |
| 9 | medium | The mirror wrote into a folder the data cycle had just refused | **Fixed** — both mirror paths go through the same validation. |
| 10 | low | `importSyncableSettings` accepted `__proto__` from a remote payload | **Fixed** — magic property names are skipped alongside the denylist. |
| 11 | low | `syncDeviceId` travelled between machines although its own comment said the denylist kept it off the wire | **Fixed** — added to the denylist. |
| 12 | informational | Restore path containment uses a bare prefix compare as a secondary check | Not changed — the primary guard (`..` and empty segments rejected before `path.join`) already blocks traversal; verified against `../../etc/x`, `/etc/passwd`, `..\` and `C:/x`. |

## Confirmed clean

- **No plaintext secret can reach Drive.** Traced end to end: `decode` reveals, the payload is
  serialised, `sealPayload` wraps it in an AES-256-GCM envelope, `uploadFile` sends bytes. Proxy
  passwords, SSH keys, vault passwords, TOTP seeds and global keys are all covered.
- **No SQL injection.** Table and column identifiers are interpolated only from the `SYNC_TABLES`
  literal and re-validated by `assertKnownTable`; every payload value is a bound parameter.
- **Machine-local data stays put.** Workspace paths, runtime profile status, run logs and task
  bookkeeping are absent from the specs.
- **The change trigger cannot be bypassed.** Both write chokepoints are covered and the apply runs
  suppressed, so a pull cannot schedule the push it caused.
- **Revision ordering holds.** Pruning cannot delete the revision the manifest names, and nothing
  prunes before verification.

## Could not be verified here

- The 308/`Range` resume path in `gdriveResumable.ts` needs a live Drive account; the 8 MiB chunk
  size exceeds Drive's documented 256 KiB granularity and the resume offsets are unproven in
  production.
- Drive's actual query semantics, pagination and 404 shapes were exercised only against an in-memory
  transport.
- The renderer additions were out of the reviewer's scope.

## Acceptance

`npx tsc -p tsconfig.main.json --noEmit` clean, `npx tsc -p src/renderer/tsconfig.json --noEmit`
clean, `npx vitest run tests/unit` 178 files / 1595 tests green, of which 17 are two-machine round
trips covering create → pull → edit → push → pull, deletion in both directions, conflict resolution,
restore-after-delete, convergence, partial-push recovery, digest tampering and concurrent commit.