# Tasks — two-way Google Drive sync

Order: entity layer → merge → transport → cycle → engine → HTTP → renderer → audit.
Suite green throughout: `npx vitest run tests/unit` → 178 files / 1599 tests.

## 1. Entity layer
- [x] `src/main/cloud/syncEntities.ts` — portable table specs, secret codecs, profile bundle dump/apply
- [x] Deterministic `stableStringify` + `hashRow` so two machines hash the same content identically
- [x] Profile apply writes EVERY bundle field, not the five the old pull wrote
- [x] Delete carries `deleted_at` so a deletion propagates instead of resurrecting

## 2. Merge
- [x] `src/main/cloud/syncMerge.ts` — three-way merge over row hashes with a base snapshot
- [x] Tombstones carried in the payload so an offline machine sees them
- [x] Base snapshot persisted atomically at `<DATA_DIR>/gdrive-sync-base.json`

## 3. Transport
- [x] `src/main/cloud/retry.ts` — `withRetry` for 429/5xx/network with `Retry-After` + jitter
- [x] `src/main/cloud/gdriveResumable.ts` — chunked resumable upload for payloads over 5 MB
- [x] Folder discovery: stored id → canonical name → legacy name → create; dead id is cleared
- [x] Folder validation refuses foreign data and foreign manifests

## 4. Cycle
- [x] `src/main/cloud/gdriveTransfer.ts` — one bidirectional cycle; push/pull are wrappers over it
- [x] Revision commit: state file first under a fresh name, manifest second
- [x] Compare-and-swap on the manifest before committing
- [x] Post-write verification; base snapshot advanced only when it verifies
- [x] Old revisions pruned after verification

## 5. Engine
- [x] `src/main/cloud/gdriveSync.ts` — subscribes to both write chokepoints, 3 s debounce
- [x] Collapsing worker with trailing trigger; backoff after failures
- [x] Sync log; passphrase rotation; verify endpoint; two-way mirror

## 6. HTTP + renderer
- [x] `cloud.ts` — `/gdrive/log`, `/gdrive/passphrase`, `/gdrive/verify`, `/gdrive/mirror/pull`
- [x] `api.ts` + `CloudSync.tsx` — log panel, verify, passphrase dialog, conflict and folder display

## 7. Audit
- [x] Independent review: 14 findings, 13 fixed and pinned by tests, 1 informational left unchanged
- [x] 17 two-machine round trips in `tests/unit/cloud/twowaySync.test.ts`