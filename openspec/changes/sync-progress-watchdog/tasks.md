# sync-progress-watchdog — Tasks

- [ ] 1. Shared `fetchWithTimeout` helper + wire through Drive transport, OAuth client, resumable upload (R01)
- [ ] 2. Engine: `phase` + `syncStartedAt` tracking, watchdog `stuck` flag, phase transitions (R02, R03)
- [ ] 3. Status shape: additive `phase|syncStartedAt|stuck` on SyncStatus + GDriveStatusData (R03)
- [ ] 4. UI: poll-during-sync progress line (phase + elapsed) + stuck guidance (R02, R03)
- [ ] 5. UI: Sync now polls to completion, honest notice (R04) + i18n EN/RU
- [ ] 6. Tests: timeout unit test, watchdog test, honest-notice logic test
- [ ] 7. Typecheck, suites, `openspec validate sync-progress-watchdog --strict`, oracle, release
