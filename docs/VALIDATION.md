# Валидация stealth и утечек

Результаты проверок профиля на ядре `fingerprint-chromium` (Chrome 148).

## Верифицировано (автоматически)

| Проверка | Результат | Скрипт |
|---|---|---|
| `navigator.webdriver` | `false` (на стоковом Chrome — `true`) | `verify-stealth.ts` |
| Canvas-фингерпринт уникален на профиль | ✅ (разные hash при разных seed) | `verify-stealth.ts` |
| `hardwareConcurrency` спуфлен по seed | ✅ | `verify-stealth.ts` |
| Смена девайса: macOS → `MacIntel`/Mac UA | ✅ | `verify-device.ts` |
| Смена девайса: iPhone → мобильный UA/touch/`393x852@3x` | ✅ | `verify-device.ts` |
| Прокси с авторизацией (CDP `Fetch.continueWithAuth`) | ✅ | `smoke-proxy.ts` |
| Авто-timezone по IP прокси | ✅ (`Europe/Sofia`) | `smoke-proxy.ts` |
| **Cookie-инжекция** (CDP `Network.setCookies`) | ✅ (cookie виден в браузере) | `verify-geo-cookies.ts` |
| **Geolocation-спуфинг** + авто-grant на каждый origin | ✅ (координаты применяются) | `verify-geo-cookies.ts` |
| **Расширения**: импорт (папка/zip), привязка, загрузка (service worker стартует) | ✅ | `verify-extensions.ts` |
| **Расширения**: content scripts | ✅ **исправлено** — инъекция работает (причина была в `--disable-extensions-except`) | `verify-extensions.ts` |
| **Batch**: batch-create (round-robin прокси), CSV-import, batch-bind, batch-delete | ✅ | `verify-batch.ts` |

## Расширения: content scripts — ИСПРАВЛЕНО

Ранее content scripts не инъектировались при `--load-extension`. **Корневая причина:** флаг `--disable-extensions-except` (передавался вместе с `--load-extension`) блокировал инъекцию content scripts на ядре `fingerprint-chromium`. **Исправление:** оставлен только `--load-extension` (без `--disable-extensions-except`).

Проверено (`verify-extensions.ts`): расширение загружается (service worker виден в `browser.targets()`), content script выполняется — `console.log` и DOM-мутация (`data-sprint-b-ext`) появляются на странице. Стабильно на повторных прогонах.

## WebRTC / UDP-утечки — политика `webrtc_policy`

Политика на профиль (`webrtc_policy: 'default' | 'disable_non_proxied_udp' | 'proxy'`, см. `src/main/launcher/chromium.ts`, `src/main/proxy/udpRelay.ts`, `src/main/api/routes/browser.ts`): по умолчанию ядро глушит WebRTC API (`RTCPeerConnection`, `webkitRTCPeerConnection` — `undefined`, `verify-webrtc.ts`), UDP-утечек нет (ни host/srflx/relay-кандидатов). Режим `proxy` пробрасывает WebRTC/QUIC через SOCKS5-релей (`udpRelay.ts`), `disable_non_proxied_udp` — глушит прямые UDP-пути.

**Компромисс:** полный блок ломает WebRTC-сайты (видеозвонки, часть dApps). Для звонков через прокси выставляйте `webrtc_policy: 'proxy'`.

## Внешние детекторы (best-effort)

- `pixelscan.net/fingerprint-check` и `browserscan.net` **загружаются в нашем браузере** (Cloudflare/анти-бот не блокирует — уже показатель, что браузер не определяется как бот).
- Чистый вердикт «pass/fail» автоматически не снимается: детекторы требуют клика и заполняют результат динамически. Для подтверждения нужен ручной прогон.
- Заявленные результаты ядра `fingerprint-chromium` (от автора): CreepJS ~51.5%, PixelScan (audio) pass, BrowserScan (GPU — возможны оговорки), Cloudflare Turnstile pass.

## Живой прогон на реальных сайтах и бенчмарках (`verify-live.ts`, `verify-benchmarks.ts`)

### Content scripts на реальных сайтах — ✅ PASS
| Сайт | Результат |
|---|---|
| example.com | ✅ content script выполнился |
| wikipedia.org | ✅ content script выполнился |
| httpbin.org/html | ✅ content script выполнился |

### Бенчмарки антидетекта
| Бенчмарк | Результат |
|---|---|
| **creepjs** | ✅ WebRTC **blocked** (host+stun), **0% headless**, **0% stealth** — не определяется как антидетект/автоматизация |
| **whoer** | disguise **70%** (Moderate), Proxy: No, Blacklist: No |
| **pixelscan** | ✅ **No automated behavior detected**; ⚠️ **"Fingerprint is inconsistent"** (см. ниже) |
| **browserscan** | данные согласованы: Chrome 148, Windows 11, timezone Europe/Sofia (совпадает с IP) |
| **EFF Cover Your Tracks** | тест запустился (кнопка нажата), вердикт в битах не захвачен автоматически |
| **browserleaks** | загрузился, вердикт требует ручного прохода по под-тестам |

### BrowserLeaks под-тесты (`verify-benchmarks2.ts`)
| Тест | Результат |
|---|---|
| **WebRTC Leak Test** | ✅ **No Leak** (Local IP: -, Public IP: -) — подтверждено на реальном тесте |
| **Canvas Fingerprint** | Uniqueness **100%** (seed-спуфинг даёт уникальность на профиль) |
| **WebGL Report** | спуфинг работает (WebGL Report Hash + Image Hash) |
| **TLS Client Test** | TLS 1.3/1.2 enabled, 1.1/1.0 disabled (Good); **JA4** `t13d1516h2_8daaf6152771_d8a2da3f94cd` — TLS-стек НЕ спуфится (ограничение ядра; AdsPower упоминает TLS-контроль) |

### ⚠️ pixelscan: «Fingerprint is inconsistent» — источник найден (Tier 2)
Эмпирический подбор (`tune-fingerprint.ts`) локализовал источник:

| Конфиг | Вердикт pixelscan |
|---|---|
| default | inconsistent |
| `disableSpoofing: canvas` | ✅ **consistent** |
| `disableSpoofing: audio` | inconsistent |
| `disableSpoofing: audio,canvas` | ✅ **consistent** |

**Вывод:** inconsistency даёт **canvas-спуфинг ядра** (audio/GPU/fonts/timezone — не источник; авто-timezone по egress IP уже согласована). Это компромисс seed-подхода `fingerprint-chromium`: canvas-шум обеспечивает **уникальность между профилями** (проверено в `verify-stealth.ts`), но pixelscan считает его нереалистичным.

**Решение:** canvas-спуфинг оставлен **включённым по умолчанию** (уникальность критична для мультиаккаунтинга; pixelscan при этом не детектит автоматизацию). Для максимальной consistency можно выключить canvas per-profile через `POST /api/v1/browser-profile/fingerprint` `{config:{disableSpoofing:'canvas'}}` — но тогда все профили одной машины получат одинаковый canvas.

**Сравнение с AdsPower:** по детекции автоматизации мы на уровне (creepjs 0% stealth, pixelscan no-automation). По согласованности canvas AdsPower сильнее (coherent-пресеты вместо seed-шума) — это ограничение текущего ядра, не решаемое флагами.

## Открытые пункты
- Ручное подтверждение pass на pixelscan/browserscan/creepjs.
- TLS-fingerprint (JA3/JA4) — стек НЕ спуфится (см. `verify-benchmarks2.ts`: JA4 `t13d1516h2_8daaf6152771_d8a2da3f94cd`), ограничение ядра.

## QUIC / WebRTC Fail-Closed Постура (2026-09-29)

По результатам аудита сетевого стека ядра Chromium и SOCKS5 UDP-транспорта зафиксирована честная инженерная позиция:

### Честная формулировка: disable-QUIC, не relay

1. **Отсутствие SOCKS5-QUIC в Chromium**: в кодовой базе Chromium и сетевом стеке BoringSSL отсутствует нативная поддержка проксирования HTTP/3 (QUIC) через SOCKS5 UDP ASSOCIATE (`--proxy-server=socks5://...` маршрутизирует исключительно TCP-трафик). Браузер пытается отправлять QUIC UDP-пакеты напрямую к целевому серверу в обход SOCKS5-прокси.
2. **Утечка реального IP при разрешённом QUIC**: без явного флага `--disable-quic` браузер осуществляет прямой UDP egress с хоста, полностью раскрывая реальный IP-адрес оператора целевым серверам (Cloudflare, Google и др.), поддерживающим HTTP/3.
3. **Отсутствие TUN / MASQUE моста**: создание виртуального сетевого адаптера (Wintun/TUN) или MASQUE UDP-туннеля требует системных драйверов уровня ядра OS или модификации Chromium C++ сетевого стека, что выходит за рамки приложения без root/C++ форка.
4. **Детерминированная fail-closed постура**:
   - Для всех проксированных профилей с политикой `CONSTRAINED` или при отсутствии подтверждённого сквозного UDP-релея жестко применяются флаги:
     - `--disable-quic` — принудительный откат всего web-трафика на TCP (HTTP/1.1 и HTTP/2) через защищённый туннель прокси;
     - `--webrtc-ip-handling-policy=disable_non_proxied_udp` — блокировка прямого локального UDP-интерфейса для WebRTC;
     - `--disable-webrtc` — полное отключение WebRTC-стека для исключения STUN/TURN утечек.
   - SOCKS5 UDP ASSOCIATE и STUN-v4/v6 пробы выполняются на стадии pre-launch (`transportPolicy.ts`, `udpRelay.ts`). Если хотя бы одна стадия не подтверждена или прокси не поддерживает dual-stack UDP, статус переходит в `CONSTRAINED`, гарантируя fail-closed изоляцию.
   - Текущий статус релея профиля (`relay`, `quic-disabled`, `unavailable`) отслеживается в runtime (`udpRelay.ts`) и доступен через endpoint диагностики `/api/v1/diagnostics/:profileId`.

## TLS / JA4 Fingerprint Постура и Ограничение Движка (2026-09-29)

По результатам аудита сетевого стека и повторных замеров через `scripts/probe-tls.ts` зафиксирована честная инженерная позиция относительно TLS-фингерпринта:

### Честная формулировка: TLS-стек НЕ спуфится, ограничение ядра BoringSSL

1. **Статическая привязка BoringSSL в Chromium**: в бинарнике Chromium сетевой стек TLS (BoringSSL) статически скомпилирован. Пакет `ClientHello` (набор и порядок cipher suites, TLS-расширений, поддерживаемых эллиптических кривых и форматов точек, ALPN) генерируется на нативном уровне C++ задолго до исполнения JavaScript страницы или расширения.
2. **Отсутствие CLI-флагов и DevTools API**: Chromium не предоставляет флагов командной строки (`--tls-cipher-suite-blacklist` устарел и не позволяет произвольно конструировать ClientHello) или CDP-методов для произвольной модификации TLS-сигнатуры. Изменение параметров профиля (`seed`, `fingerprint`, `userAgent`) не оказывает никакого влияния на TLS.
3. **Измеренный эталонный JA4**: на реальном ядре `fingerprint-chromium` через `tls.peet.ws` измерен и зафиксирован аутентичный Chromium BoringSSL JA4:
   ```
   t13d1516h2_8daaf6152771_d8a2da3f94cd
   ```
4. **Архитектурный отказ от MITM-терминации**:
   - Технически подмена TLS на клиенте возможна только установкой локального перехватывающего MITM-прокси (TLS termination / ClientHello rewrite).
   - Это требует генерации и принудительной установки самоподписанного корневого CA-сертификата в системное хранилище OS или NSS-базу браузера.
   - MITM-прокси нарушает ключевые инварианты безопасности (расшифровка сквозного TLS-трафика пользователя, риски утечки приватных ключей, деградация пропускной способности, детектирование по аномалиям цепочки сертификатов). Данный путь категорически отвергнут как неприемлемый для продукта.
5. **Мульти-ядерный паритет (Camoufox / Firefox)**:
   - Для сценариев, требующих аутентичного не-Chromium TLS-отпечатка, используется ядро Camoufox (Firefox stack) с его нативным NSS TLS-стеком.
   - Camoufox отдаёт аутентичный Firefox JA4 без попыток синтетической подделки, что исключает детекцию несогласованности криптографического стека.
6. **Повторяемый гейт верификации**:
   - Скрипт `scripts/probe-tls.ts` выполняет автоматизированный замер обоих ядер с таймаут-гардами и обязательным cleanup профилей в блоках `finally`.
   - Детерминированный вердикт (`identical` при сравнении профилей подтверждает неизменяемость стека; `differ` фиксирует нативный стек каждого движка) и код возврата 0/1.
   - Логика парсинга и жизненного цикла покрыта герметичными тестами `tests/unit/proxy/tlsLimitation.test.ts`.
