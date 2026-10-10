# sync-scope-settings — Proposal

## Why
Two facts from the operator: (1) "не вижу чтобы профили переносились между устройствами" —
profiles do not visibly arrive on the second machine while both panels sit at
"Syncing... / Last Synced: Never"; (2) "убери selfhosted sync мы им больше не пользуемся".
Plus the standing request: per-category sync scope (profiles, proxies, settings, ...),
6 categories, all ON by default, per-machine.

## What changes
1. **Self-hosted removal (R01–R02):** server + deploy cards gone from CloudSync; routes
   `/state/connect/disconnect/remote-list/push/pull` deleted; `packages/sync-server`,
   `deploy/`, SERVER_DEPLOY docs, dead URL/i18n keys removed.
2. **Scope settings (R03–R04):** 6 per-machine toggles stored in settings.json (denylisted
   from sync itself). Disabled categories are excluded from the outgoing payload AND skipped
   on apply, without breaking merge convergence for the rest.
3. **Proof (R05–R06):** a two-machine E2E test (two DBs + shared Drive mock) proving
   profiles/proxies/settings travel; the same harness doubles as the hang/crash detector
   for the "profiles never arrive" symptom.

## Alternatives considered
- Account-wide scope: rejected in Wave 0 (operator wants per-machine).
- Scope as table-level toggles (11 tables): rejected in Wave 0 as scary; 6 friendly categories.
- Keeping self-hosted backend dead: rejected ("Вырезать всё").
