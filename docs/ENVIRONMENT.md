# Окружение и запуск

## Текущее окружение
- Node.js v24.17.0, npm 11.
- Windows; нет C++ build tools (VS2022 без Windows SDK) — **больше не требуется**: в проекте нет нативных модулей (БД на sql.js/WASM, см. ADR-007).

## Запуск
- **Десктоп-приложение (Tauri v2):** `npm install && npm run tauri:dev` (соберёт main + renderer и запустит). Сервис: `npm run service` → API на `http://localhost:50325` (ключ печатается в консоль).
- **Сборка установщика/портатива:** `npm run tauri:build` (+ `scripts/build-portable.mjs`) → NSIS/portable в `src-tauri/target/release/bundle/`.
- **Ядро браузера:** `npm run install-chromium` (или `npm run ensure-kernel`) скачает Chrome for Testing; приоритет — патченый `fingerprint-chromium` из `data/chromium/`, затем системный Chrome.

## ADR-007 (решено в Фазе 5)
Нативный `better-sqlite3` заменён на `sql.js` (WASM) с адаптером под API better-sqlite3 (`prepare/run/get/all/exec`). Бэкенд работает и в Node (standalone), и в Tauri sidecar без пересборки. Упаковка Tauri v2 стандартная, build tools не нужны.

**Верификация:** собранное приложение запускается, бэкенд стартует как sidecar, Local API отвечает; установщик NSIS собран (`npm run tauri:build`).

## Данные
- Профили / БД / API-ключ: `~/.antidetect/` (в packaged-приложении и dev/standalone, см. `src/main/config.ts:settingsBase/resolveDataDir`; portable — `<portableBaseDir>/data`; при первом запуске — диалог выбора папки `src/renderer/src/FirstRunDataDir.tsx`, переопределяется `ANTIDETECT_DATA_DIR`/`ANTIDETECT_SETTINGS_DIR`).
- Ядро `fingerprint-chromium`: `data/chromium/fingerprint-chromium/`.
## Известные ограничения
- Порт Local API фиксирован (50325 по умолчанию, переопределяется `API_PORT`); при занятом порте бэкенд не стартует — освободите порт.
- Приложение не подписано кодом (SmartScreen может предупредить при установке).
