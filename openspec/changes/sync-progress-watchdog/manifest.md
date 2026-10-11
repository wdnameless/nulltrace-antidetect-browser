# Manifest: sync progress + timeouts + stuck-cycle watchdog

## User quotes (verbatim)
- "нажал sync now но ничего не просиходил, проверь и давай сделаем какой-то прогресс бар чтобы было понятно работает или нет"
- "Не вижу что синхронизация работает, проверь"
- "везде 0.6.65"

## Requirements
| ID | Requirement | Source |
|----|-------------|--------|
| R01 | Every Google fetch (Drive transport, OAuth client, resumable upload) MUST have a timeout so no cycle hangs forever | stuck "Syncing..." on 0.6.65, zero `AbortSignal`/`timeout` in cloud/ |
| R02 | A stuck cycle MUST be detected and reported: watchdog marks `isSyncing` stale after N minutes and surfaces "sync appears stuck" instead of silent spinning | "ничего не происходил" with no log row |
| R03 | Sync progress MUST be visible: status carries the current phase (`idle\|inspecting\|pushing\|pulling\|verifying\|mirror`) + started-at; UI polls and renders phase + elapsed time | "прогресс бар чтобы было понятно работает или нет" |
| R04 | Sync now MUST NOT claim "completed" while the cycle is still running; notice appears only when the polled status shows the cycle finished | screenshot: "Sync completed successfully" + "Syncing..." simultaneously |
| R05 | OUT: changing merge/encryption/protocol; resumable-progress percentages; Teams tab | scope edge |

## Constraints
- Additive status fields only (`phase`, `syncStartedAt`); old renderers ignore them.
- Timeouts must be generous (first sync moves ~1 MB + per-profile imports): hang = minutes, not seconds.
- Must not break: cloud suite, typecheck, noir guard, i18n.

## Success criteria
- A hung network call fails the cycle with a timeout error row instead of spinning forever.
- During a sync the UI shows phase + elapsed seconds, updating while it runs.
- Sync now shows no success notice until the cycle actually completes.
