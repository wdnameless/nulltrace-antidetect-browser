# sync-scope-settings — Interfaces

## Owner map
| Area | Owner | Files |
|------|-------|-------|
| Self-hosted removal | fixer | `CloudSync.tsx`, `cloud.ts` routes, `api.ts`, `externalUrl.ts`, `i18n.tsx`, `packages/sync-server/*`, `deploy/*`, docs, tests |
| Scope + E2E | fixer | `syncEntities.ts` (+filter), `gdriveTransfer.ts` (apply skip), `gdriveSync.ts` (setting), `cloud.ts` (scope endpoints), `CloudSync.tsx`, `i18n.tsx`, new E2E test |

Sequenced (shared files): removal FIRST, scope+E2E SECOND.

## Category → table map (every SYNC_TABLE covered exactly once)
| Category | Tables |
|----------|--------|
| profiles | `profiles`, `profile_tags`, `profile_extensions` (bundle carries fingerprint/cookies/group-ref) |
| proxies | `proxies` |
| vault | `account_credentials` |
| scripts | `scripts`, `triggers`, `global_keys` (script key-value store — a script without its keys is broken on arrival) |
| library | `tags`, `groups`, `extensions` |
| settings | settings payload (`exportSyncableSettings`, no table) |

## Boundaries
- Setting key `gdriveScope` (shape: `{profiles,proxies,vault,scripts,library,settings}: boolean`, default all true). MUST join `SETTINGS_SYNC_DENYLIST`.
- Endpoints: `GET /api/v1/cloud/gdrive/scope`, `POST /api/v1/cloud/gdrive/scope` (`{category,on}` or full object). Follow existing zod+`{code,msg,data}` conventions.
- Payload: no version bump; excluded tables are simply absent from `tables` (merge already treats absent remote tables as null; absent local tables dump as `{}`).
- E2E harness: two `initDb` instances (separate DATA_DIR via env), one in-memory Drive transport (`setGDriveTransport`), real `runSyncCycle` both directions.
