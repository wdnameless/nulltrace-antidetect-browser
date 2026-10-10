# sync-scope-settings — Tasks

- [ ] 1. Remove self-hosted UI cards from CloudSync.tsx (+ dead handlers/state)
- [ ] 2. Remove self-hosted routes (`/state/connect/disconnect/remote-list/push/pull`) from `cloud.ts`
- [ ] 3. Delete `packages/sync-server`, `deploy/`, SERVER_DEPLOY docs; drop dead `api.ts`/URL/i18n keys + tests
- [ ] 4. Scope backend: category→table map, payload filter, apply skip, denylisted setting, get/set endpoints
- [ ] 5. Scope UI: 6 toggles on CloudSync page + i18n
- [ ] 6. E2E two-machine test (transfer + isolation + convergence)
- [ ] 7. Typecheck, suites, `openspec validate sync-scope-settings --strict`, oracle, release
