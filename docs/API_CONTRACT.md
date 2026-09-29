# Local API — контракт (AdsPower-совместимый)

## База и авторизация
- Base URL: `http://localhost:50325` (порт настраивается, по умолчанию 50325).
- Слушает только loopback.
- Auth: заголовок `Authorization: Bearer <API_KEY>` на всех эндпоинтах (кроме `/status`).
- Формат ответа: `{ "code": number, "msg": string, "data": object }`. `code === 0` = успех, иначе ошибка.

## Эндпоинты

### `GET /status`
Проверка живости сервиса. Без auth.
```json
{ "code": 0, "msg": "success", "data": { "status": "ok", "version": "0.0.1" } }
```

### `GET /api/v1/browser/start?user_id=<profileId>`
Запускает профиль и возвращает CDP-эндпоинты. (AdsPower V1; также поддерживаем `POST /api/v2/browser-profile/start` с `{ user_id }`.)

Успех:
```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "ws": {
      "selenium": "127.0.0.1:52341",
      "puppeteer": "ws://127.0.0.1:52341/devtools/browser/8f6e2b1a-...."
    },
    "debug_port": "52341",
    "webdriver": "C:\\...\\chromedriver.exe"
  }
}
```
Ошибка:
```json
{ "code": -1, "msg": "profile not found", "data": {} }
```
Поведение: если профиль уже запущен — вернуть существующие эндпоинты (идемпотентно).

### `GET /api/v1/browser/stop?user_id=<profileId>`
Останавливает профиль (убивает процесс браузера).
```json
{ "code": 0, "msg": "success", "data": {} }
```

### `GET /api/v1/browser/list?page_size=100&page=1`
Список профилей. (Альтернатива: `POST /api/v2/browser-profile/list`.)
```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "list": [
      { "user_id": "p_123", "name": "FB account 1", "status": "closed", "group_id": "g_1" }
    ],
    "page": 1,
    "page_size": 100,
    "total": 1
  }
}
```

### `POST /api/v1/browser-profile/create`
Создаёт профиль. Тело:
```json
{ "name": "FB account 1", "group_id": "g_1", "proxy": { "type": "socks5", "host": "1.2.3.4", "port": 1080, "username": "u", "password": "p" } }
```
Успех:
```json
{ "code": 0, "msg": "success", "data": { "user_id": "p_124" } }
```

### Прокси (Фаза 3)

#### `POST /api/v1/proxy/create`
Создаёт прокси. Тело:
```json
{ "type": "http|https|socks5|ssh", "host": "1.2.3.4", "port": 1080, "username": "u", "password": "p", "privateKey": "-----BEGIN ..." }
```
Успех: `{ "code": 0, "msg": "success", "data": { "proxy_id": "x_..." } }`

#### `GET /api/v1/proxy/list`
Список прокси:
```json
{ "code": 0, "msg": "success", "data": { "list": [ { "proxy_id": "x_1", "type": "socks5", "host": "1.2.3.4", "port": 1080, "username": "u", "country": "Germany", "country_code": "DE", "city": "Falkenstein", "timezone": "Europe/Sofia", "status": "ok" } ], "total": 1 } }
```

`country` — название страны от гео-сервиса ("Germany"); `country_code` — ISO 3166-1 alpha-2 ("DE"),
из которого строятся флаг и двухбуквенная метка в интерфейсе. Колонка PROXY показывает и код, и
название: `🇩🇪 DE · Germany · Falkenstein`. Строка без кода (записанная до появления колонки)
показывает только название — флаг из названия не выводится.

Проверка гео ставится в очередь при **любой** привязке прокси к профилю — и когда прокси создаётся
вместе с профилем, и когда он выбран из списка сохранённых (`proxy_id`), а также при обновлении
профиля. Очередь идемпотентна и пропускает строку, у которой код уже есть, поэтому повторная
привязка того же прокси не тратит лишний запрос.

#### `POST /api/v1/proxy/update`
Тело: `{ "proxy_id": "x_...", ...поля как в create (все опциональны) }`.

#### `POST /api/v1/proxy/delete`
Тело: `{ "proxy_id": "x_..." }`. Ошибка, если прокси привязан к профилю.

#### `POST /api/v1/proxy/check`
Проверяет прокси запросом через него к ip-api.com и сохраняет результат (status/country/country_code/timezone).
Тело: `{ "proxy_id": "x_..." }`
Ответ:
```json
{ "code": 0, "msg": "success", "data": { "ok": true, "ip": "78.90.183.137", "country": "Bulgaria", "countryCode": "BG", "timezone": "Europe/Sofia", "latencyMs": 155 } }
```
Для SSH-прокси временно поднимается локальный SOCKS5-туннель.

**Каждый новый прокси проверяется автоматически.** Очередь живёт в `proxyManager` и вызывается
из всех путей создания — `POST /api/v1/proxy/create`, импорт списка, создание и обновление
профиля, `batch-create`, импорт CSV/XLSX и bundle. Проверки идут последовательно с паузой 1500 мс,
чтобы укладываться в лимит бесплатного гео-сервиса (45 запросов/мин), поэтому результат приходит
не мгновенно. Готовность каждого прокси приходит в UI событием `proxy-geo` по SSE
(`GET /api/v1/events/stream`); прогрессом всей очереди управляют
`POST /api/v1/proxy/geo-fill/start|stop` и `GET /api/v1/proxy/geo-fill/status`.
Прокси, чья проверка не удалась, повторно не опрашивается, пока не вызван `start` с `force`.

#### `POST /api/v1/browser-profile/update`
Привязка прокси к профилю (или отвязка). Тело: `{ "user_id": "p_...", "proxy_id": "x_..." | null }`.

### Заметки по прокси
- HTTP/HTTPS/SOCKS5: `--proxy-server` ядра; **авторизация по паролю — через CDP `Fetch.continueWithAuth`** (ядро не поддерживает inline-креды).
- SSH: локальный SOCKS5-туннель (ssh2 + собственный SOCKS5-сервер RFC 1928).
- Авто-timezone: при запуске профиля `--timezone` берётся из timezone прокси, если у профиля не задана явно.

### Устройства (Фаза 4)

#### `GET /api/v1/device/list`
Список пресетов устройств (встроенные: Windows 10/11, macOS, Android Pixel 8, iPhone 15):
```json
{ "code": 0, "msg": "success", "data": { "list": [ { "device_id": "dev_macos", "name": "macOS", "platform": "mac", "config": { "platform": "macos", "platformVersion": "15.2.0", "brand": "Chrome", "hardwareConcurrency": 8, "lang": "en-US" } } ], "total": 5 } }
```

#### `POST /api/v1/device/create`
Тело: `{ "name": "My Device", "platform": "win|mac|linux|ios|android", "config": { ... } }`.
Успех: `{ "code": 0, "msg": "success", "data": { "device_id": "dev_..." } }`

#### `POST /api/v1/device/update` / `POST /api/v1/device/delete`
Тело update: `{ "device_id": "dev_...", ...поля как в create (опциональны) }`. Тело delete: `{ "device_id": "dev_..." }`.

#### Привязка устройства к профилю
`POST /api/v1/browser-profile/update` с `{ "user_id": "p_...", "device_id": "dev_macos" | null }` (можно вместе с `proxy_id`).

### Заметки по устройствам
- **Десктопные пресеты** (win/mac/linux): применяются ядром — `--fingerprint-platform`, `--fingerprint-platform-version`, `--fingerprint-brand`, `--fingerprint-hardware-concurrency`, `--lang`, `--timezone`.
- **Мобильные пресеты** (ios/android): CDP-эмуляция — `Emulation.setDeviceMetricsOverride` (screen/DPR), `setTouchEmulationEnabled`, `setUserAgentOverride`. Ядро остаётся `windows` (UA мобильный — главный сигнал).
- Приоритет: явные параметры профиля/фингерпринта перекрывают пресет устройства.

### Firefox (Camoufox) — управляемая модель (Juggler)

Firefox-профили (`browser_type: 'firefox'`) не отдают CDP ws (Juggler не открывает порт CLI-флагом). Управление — через API-методы:

#### `POST /api/v1/browser-profile/create` с `browser_type: 'firefox'`
```json
{ "name": "ff-1", "browser_type": "firefox" }
```
→ `{ "code": 0, "data": { "user_id": "p_..." } }`

#### `GET /api/v1/browser/start?user_id=<id>` (firefox)
→ `{ "code": 0, "data": { "browser_type": "firefox", "url": "about:blank" } }` (вместо ws)

#### `POST /api/v1/browser/firefox/navigate`
Тело: `{ "user_id": "p_...", "url": "https://example.com" }`
→ `{ "code": 0, "data": { "url": "...", "title": "..." } }`

#### `POST /api/v1/browser/firefox/evaluate`
Тело: `{ "user_id": "p_...", "expression": "navigator.userAgent" }`
→ `{ "code": 0, "data": { "result": "..." } }`

#### `GET /api/v1/browser/firefox/title?user_id=<id>`
→ `{ "code": 0, "data": { "title": "..." } }`

#### `GET /api/v1/browser/stop?user_id=<id>` (firefox)
→ `{ "code": 0, "data": {} }`

### Rate limits
Эндпоинты списка — 20 req/s, cookies import/export — 5 req/s (см. `src/main/api/rateLimit.ts`). Остальные — 20 req/s, `/status` — 50 req/s, превышение → HTTP 429.

## Примеры подключения автоматизаций

### Puppeteer (Node.js)
```js
import puppeteer from 'puppeteer-core';
const res = await fetch('http://localhost:50325/api/v1/browser/start?user_id=p_123', {
  headers: { Authorization: 'Bearer ' + API_KEY },
}).then(r => r.json());
const browser = await puppeteer.connect({ browserWSEndpoint: res.data.ws.puppeteer, defaultViewport: null });
const [page] = await browser.pages();
await page.goto('https://whoer.net');
```

### Playwright (Node/Python)
```js
const { chromium } = require('playwright');
const browser = await chromium.connectOverCDP(res.data.ws.puppeteer);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://whoer.net');
```
```python
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(data["ws"]["puppeteer"])
    page = browser.contexts[0].pages[0]
    page.goto("https://whoer.net")
```

### Selenium
```python
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
opts = Options()
opts.add_experimental_option("debuggerAddress", data["ws"]["selenium"])
driver = webdriver.Chrome(data["webdriver"], options=opts)
driver.get("https://whoer.net")
```

## Заметки реализации
- `ws.puppeteer` строится из `DevToolsActivePort`: `ws://127.0.0.1:<port><ws-path>`.
- `ws.selenium` = `127.0.0.1:<port>` (для `debuggerAddress`).
- `webdriver` — путь к chromedriver соответствующей версии (для Selenium); в MVP может указывать на системный/скачанный драйвер.
- Запущенные профили трекаются в памяти (Map profileId → {pid, port, ws}); статус пишется в БД.

## Bulk-операции и пакеты (v0.2.18–19)

#### `POST /api/v1/browser-profile/bulk-start` `{ user_ids: string[] }`
Один запрос на запуск N профилей. Ответ: `{ succeeded: [{user_id, ws?, debug_port?}], failed: [{user_id, error}], total }`.
#### `POST /api/v1/browser-profile/bulk-stop` / `bulk-delete` / `bulk-group` `{ user_ids, group_id? }`
Аналогично, с отчётом по каждому профилю.

#### `GET /api/v1/browser-profile/export?user_id=` → `{ bundle }`
Пакет профиля: fingerprint (seed+config), proxy с кредами, cookies, timezone, start_urls, mobile_model_id, device.
#### `POST /api/v1/browser-profile/import-bundle` `{ bundle }` → `{ user_id }`
Создаёт новый профиль из пакета (перенос между машинами; пресет перелинковывается по стабильному id).

#### `POST /api/v1/browser-profile/duplicate` `{ user_id, name? }` → `{ user_id }`
Копия профиля с новым id/seed.

## Cookies: форматы (v0.2.20)

- Импорт: `POST /api/v1/browser-profile/cookies/import` `{ user_id, cookies[] }` (CDP JSON) **или** `{ user_id, format: 'netscape', text }` (cookies.txt).
- Экспорт: `GET /api/v1/browser-profile/cookies/export?user_id=` (JSON, live/stored) **или** `&format=netscape` → готовый cookies.txt (text/plain).

## Служебные (v0.2.19–20)

#### `GET /api/v1/logs/list` / `GET /api/v1/logs/get?name=&tail=`
Файлы `data/logs/app-YYYY-MM-DD.log` (ротация 14 дней). `name` — только `app-*.log` (path traversal защищён).
#### `GET /api/v1/kernel/info` / `GET /api/v1/kernel/check-update`
Версия установленного ядра; сравнение с последним релизом fingerprint-chromium (GitHub API).
#### `GET /api/v1/device/mobile-presets`
Пул 30 Android-моделей (id, name, model, androidVersion, gpu).
#### `GET /api/v1/browser-profile/languages`
Список языков браузера, которые может нести отпечаток профиля — **единственный источник правды**
для селекта «Browser language». Выводится из `localePool` семейств каталога
(`WINDOWS_FINGERPRINT_CATALOG` + `EXTENDED_FINGERPRINT_CATALOG`), поэтому UI не может разойтись с
бэкендом.

Захардкоженный в модалке список из 7 языков отставал от каталога на 14 локалей, а `<select>`, чей
`value` не совпадает ни с одной опцией, показывает **первую** опцию — то есть «Auto». Сохранение
профиля с такой локалью писало пустое значение поверх настоящего, и браузер откатывался на локаль
машины. На реальной базе это затрагивало 15 профилей из 74.
Ответ: `{ "code": 0, "msg": "success", "data": { "list": ["de-DE", "en-AU", …, "zh-CN"] } }`

## Rate limits (актуально)

| Пути | Лимит |
|---|---|
| Списки (`/browser/list`, `/proxy/list`, `/group/list`, `/device/*`, `/extension/list`, `/logs/*` …) | 20 req/s |
| `/browser/start`, `/browser/stop`, cookies import/export | 10 / 5 req/s |
| `/status` | 50 req/s |
| Остальное | 20 req/s |

Превышение → HTTP 429 `{ code: -1, msg: 'rate limit exceeded', data: { retry_after_ms } }`. UI-клиент повторяет автоматически (до 3 попыток с backoff).

## Безопасность

- Bearer-ключ: сравнение timing-safe; хранится в `<data>/api_key`.
- Host-заголовок: принимается только loopback (защита от DNS-rebinding).
- Пароли прокси и SSH-ключи шифруются при записи (Tauri DPAPI `enc:` через `src-tauri/src/secrets.rs` + файловый AES-256-GCM `aes:` с ключом `DATA_DIR/secret.key`; `plain:` — только legacy-чтение, запись без шифра отклоняется — см. `src/main/util/secretStore.ts`). В `/proxy/list` секреты не отдаются.