# Manifest — Android as profiles

T2 lane: `Android as profiles: remove tab, settings integration,
fingerprints/hw controls, MCP automation`.

## Requirements

| ID | Requirement | Verbatim user quote |
|----|-------------|---------------------|
| R01 | Android tab removed; its core functions (engine install/status) move into Settings | "давай уберем вкладку андроид и вынесем основные функции в настройки" |
| R02 | Emulator launches like normal profiles (Start/Stop from Profiles list) in its own separate window | "сам эмулятор будет запускаться как и обычные профили и отдельным окном" |
| R03 | Fingerprint settings per profile (model/seed/preset fields) | "должны быть настройки фингерпринтов, ядер, оперативы и всего остального как в антиках других которые поддерживают андроид" |
| R04 | Hardware settings per profile: CPU cores, RAM, and the rest (heap, screen, density) | "должны быть настройки фингерпринтов, ядер, оперативы и всего остального как в антиках других которые поддерживают андроид" |
| R05 | Everything verified fast and correct E2E | "проверь что все быстро и корректно работает" |
| R06 | Emulator automatable and controllable via MCP like the CDP browser | "эмулятор можно автоматизировать и управлять им через mcp как в нашим cdp браузером" |

## Wave 0 decisions (widget, 2026-10-23)

- Profiles: Start/Stop directly from the list (no intermediate card).
- Settings: engine only; fingerprint + hardware live in the profile card.
- Hardware: manual fields (cores, RAM, heap, screen, density), not presets.
- MCP: browser parity (tap/swipe/type/key, screencap, start/stop/status, install APK).

## Non-goals

- Play Store image variant; Magisk/Zygisk spoof modules; multi-guest
  clustering beyond one emulator per profile; iOS.
