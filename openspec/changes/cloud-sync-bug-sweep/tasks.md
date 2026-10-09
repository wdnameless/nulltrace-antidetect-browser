# cloud-sync-bug-sweep — Tasks

- [ ] 1. Backend: R01 (preserve lastError), R04 (expiry fallback), R05 (purge dead grant), R06 (clear grant on credential swap), R07 (disconnect residue), R08 (mirror binary fail-loud), R09 (stop cancels trailing), R10 (single launch sync)
- [ ] 2. UI: R02 (poll ignores stale errors), R03 (conflict shape render), R11 (cancel + unmount cleanup), R12 (state gates) + i18n
- [ ] 3. Regression tests per fix (or stated reason)
- [ ] 4. `npm run typecheck`, targeted suites, `openspec validate cloud-sync-bug-sweep --strict`
- [ ] 5. Oracle blind audit + v0.6.62 release
