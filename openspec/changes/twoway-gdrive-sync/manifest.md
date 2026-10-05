# Requirements manifest — two-way Google Drive sync

Every row traces to the operator's own words in this session. Silence never cancels a row.

## Rows

**R01.** «Давай все это чинить»
→ All 14 gaps recorded in `.workflow/recon-gdrive-sync-gaps.md` must be closed, not a convenient subset.

**R02.** «И реализуем полноценную синхронизацию профилей сессиями, куками всем остальным в двухстороннем режиме»
→ Two-way, not one-way push/pull. Profiles, browser sessions, cookies and every other portable
  entity must flow in BOTH directions, with per-row merge rather than whole-file overwrite.

**R03.** «чтобы человек мог зайти, подключить свой Google в качестве диск»
→ An operator connects their OWN Google account as storage. One action, device-code OAuth,
  shipped publisher client with per-operator override.

**R04.** «через то, что будет идти вся синхронизация и файлы бы автоматически нашлись по определенной папке»
→ All sync traffic goes through ONE Drive folder, discovered automatically by a defined name, with
  no operator browsing to locate it.

**R05.** «провалидировались, синхронизировались, проверились»
→ The remote folder must be VALIDATED before use (it is a NullTrace folder, not a stranger's data),
  SYNCED in both directions, and VERIFIED after write (integrity check that survives a partial
  upload). Three distinct steps, all required.

## Derived obligations (each R maps to at least one)

| R | Obligation |
|---|---|
| R01 | gap G1..G14 closed |
| R02 | three-way merge with row-hash base, per-row conflict resolution, tombstones for deletes |
| R02 | entity coverage: profiles, account_credentials, scripts, proxies, groups, tags, profile_tags, extensions, profile_extensions, triggers, devices, global_keys, settings |
| R03 | device-code connect → store refresh token → auto-unlock path |
| R04 | folder discovery by `nulltrace data`, legacy adoption, no operator file-picking |
| R05 | pre-use validation, post-write verification, atomic revision commit |

## Rows not claimed

None. Every word of the request maps to a row above.