# Manifest: Cloud Sync crash fix + UX redesign

## User quotes (verbatim)
- "Вроде законнектилась, но это все выглядит очень страшно. Давай сделаем нормальный юзер эксперинс."
- Layout: "Один статус + одна кнопка"
- Danger: "Спрятать + подтверждения"
- Errors: "Человеческий текст + детали"
- Mirror: "Спрятать в Advanced"

## Requirements
| ID | Requirement | Source |
|----|-------------|--------|
| R01 | Sync must not crash with `no such column: launch_args` on databases created before the column existed | crash on screenshot, `schema.ts` missing `ensureColumn` |
| R02 | Connected page shows one status card (status, account, last sync) + one primary Sync now button | layout decision |
| R03 | Verify, Pull/Push, Check-for-updates, Sync Log move into a collapsible Advanced block | layout decision |
| R04 | Disconnect, Change Passphrase, Pull, Push require a confirmation dialog explaining consequences | danger decision |
| R05 | Sync errors render as human text with [Details] disclosure + [Retry], never a raw SQL message | errors decision |
| R06 | Chromium Directory Mirror block moves into Advanced, default collapsed | mirror decision |
| R07 | No existing sync behavior changes: same engine, same triggers, same encryption | scope edge |
| R08 | OUT: self-hosted server section redesign, Teams tab, backend API changes | scope edge |

## Constraints
- Same stack (React renderer, existing `api.ts` calls, existing CSS tokens).
- Must not break: noir hue guard (`noirTokens.test.ts`), i18n EN/RU keys, existing tests.
- Crash fix must be a DB migration (`ensureColumn`), not a sync-code workaround.

## Success criteria
- `Sync now` on a pre-`launch_args` database completes (no `no such column` error).
- Connected page: 1 status card + 1 primary button visible; everything else behind ≤2 disclosures.
- Every destructive action opens a confirm dialog before executing.
- A forced sync failure shows human text + Details + Retry, no raw SQL on screen.
