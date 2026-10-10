# Manifest: remove self-hosted + sync scope settings + E2E proof

## User quotes (verbatim)
- "Подключил синхронизацию но не вижу чтобы профили переносились между устройствами. Давай сделаем настройки синхронизации, где юзер удобно сможет выбирать что именно нужно синхронизировать (профили, настройки, прокси и тд)"
- "убери selfhosted sync мы им больше не польуземся и проверь что синхронизация корректно работает"
- Wave 0: "6 категорий" / "Всё включено" / "Свои на каждой машине" / "Пришлю лог следующим сообщением"
- Removal: "Вырезать всё"; Verify: "E2E тест двумя машинами"

## Requirements
| ID | Requirement | Source |
|----|-------------|--------|
| R01 | Self-hosted UI removed: server card + deploy card gone from CloudSync page | "убери selfhosted sync" |
| R02 | Self-hosted backend removed: `/state/connect/disconnect/remote-list/push/pull` routes, `packages/sync-server`, `deploy/`, SERVER_DEPLOY docs, dead i18n/URL constants | "Вырезать всё" |
| R03 | Sync scope settings: 6 per-machine toggles (Profiles, Proxies, Vault, Scripts, Tags+Groups+Extensions, App settings), default all ON | "6 категорий", "Всё включено", "Свои на каждой машине" |
| R04 | Disabled categories are excluded from push payload AND skipped on pull apply, both directions, without breaking merge convergence | scope correctness |
| R05 | E2E test: two DBs + shared Drive mock prove profiles/proxies/settings travel machine-to-machine | "E2E тест двумя машинами" |
| R06 | Diagnose why profiles don't transfer (user's live symptom): root-cause via Sync Log or engine self-diagnosis, fixed or explained | "не вижу чтобы профили переносились" |
| R07 | OUT: changing encryption, merge algorithm, OAuth; touching Teams tab | scope edge |

## Constraints
- Scope setting is per-machine: stored in settings.json, MUST be on SETTINGS_SYNC_DENYLIST (never travels).
- Category mapping must cover every SYNC_TABLE + settings; no table orphaned or double-counted.
- No wire/payload version change unless old builds must ignore unknown fields (they must).
- Must not break: cloud suite, typecheck, noir guard.

## Success criteria
- CloudSync page shows zero self-hosted traces; `grep self-hosted|sync-server|bootstrap.ps1 src/` empty (except Inter font comment).
- Toggling a category OFF excludes its tables from the next payload; E2E proves per-category isolation.
- E2E two-machine test green; user confirms profiles arrive on second machine.
