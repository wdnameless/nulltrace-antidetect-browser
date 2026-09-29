# Развёртывание на сервере (RU)

Инструкция по развёртыванию Antidetect Browser на своём **Windows-дейдике/VPS**, чтобы:

- профили жили на сервере (единый источник истины) и никуда не копировались;
- управлять профилями и *работать в них* можно было с любого девайса через
  встроенную веб-панель (`/ui`) — сам браузер крутится на сервере и стримится
  к вам через CDP-screencast с полноценным управлением мышью/клавиатурой;
- автоматизации (Puppeteer / Playwright / Selenium) подключались через API
  откуда угодно.

Всё — бесплатный софт: Node.js, WireGuard, Traefik, NSSM.

```
Ноутбук / планшет / сервис автоматизаций        Windows-дейдик
        │                                              │
        ├──── WireGuard-туннель (только UDP) ─────────►│
        ▼                                              ▼
   http://10.8.0.1/                             Traefik (Docker)
    ├─ /ui        веб-панель                    │ http://host.docker.internal:50325
    ├─ /api/v1/*  REST                          ▼
    └─ /cdp/:id   CDP-туннель         Antidetect Service (:50325, loopback)
                                      └─ Chromium на профиль (headed,
                                         user-data-dir на диске сервера)
```

В интернет торчит только UDP-порт WireGuard.

---

## 1. Установка Node.js LTS

```powershell
winget install OpenJS.NodeJS.LTS
node -v
```

## 2. Получение приложения

```powershell
git clone <REPO_URL> C:\antidetect
cd C:\antidetect
npm ci
npm run build:main
npm run ensure-kernel      # скачает ядро fingerprint-chromium
npm run ensure-chromedriver
```

> Если на сервере нет доступа для скачивания ядра — установите приложение
> локально и скопируйте папку проекта целиком (ядро лежит в `data\`).

Проверка: `npm run service` — консоль напечатает API-ключ. Останов — Ctrl+C.

## 3. WireGuard (VPN-транспорт)

Установите WireGuard: https://www.wireguard.com/install/

**Сервер** (`C:\wg\server.conf`):

```ini
[Interface]
PrivateKey = <SERVER_PRIVATE_KEY>
Address = 10.8.0.1/24
ListenPort = 51820

[Peer]                      # блок на каждое устройство/сервис
PublicKey = <CLIENT1_PUBLIC_KEY>
AllowedIPs = 10.8.0.2/32

[Peer]
PublicKey = <CLIENT2_PUBLIC_KEY>
AllowedIPs = 10.8.0.3/32
```

Генерация ключей:

```powershell
& 'C:\Program Files\WireGuard\wg.exe' genkey | Set-Content server.key
& 'C:\Program Files\WireGuard\wg.exe' pubkey < server.key
```

Активация: приложение WireGuard → Import tunnel → Activate.

**Клиентские устройства**: конфиг вида

```ini
[Interface]
PrivateKey = <CLIENT_PRIVATE_KEY>
Address = 10.8.0.2/32

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
Endpoint = <PUBLIC_IP_ДЕЙДИКА>:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```

После этого сервер доступен как `10.8.0.1` со всех пиров — домен не нужен.

## 4. Запуск сервиса в server mode

Переменные окружения (прописать системно для службы):

| Переменная | Значение | Зачем |
|---|---|---|
| `ANTIDETECT_SERVER_MODE` | `1` | доверенные хосты, файловый лог запросов, без CORS |
| `ANTIDETECT_TRUSTED_HOSTS` | `10.8.0.1` | какие Host-заголовки принимать за прокси |
| `API_HOST` | `127.0.0.1` | слушать только loopback |

### Автозапуск через NSSM (рекомендуется)

```powershell
# https://nssm.cc/download → nssm.exe положить в C:\antidetect\
.\nssm.exe install AntidetectService "C:\Program Files\nodejs\node.exe" "C:\antidetect\dist\src\main\index.js"
.\nssm.exe set AntidetectService AppDirectory C:\antidetect
.\nssm.exe set AntidetectService AppEnvironmentExtra ANTIDETECT_SERVER_MODE=1 ANTIDETECT_TRUSTED_HOSTS=10.8.0.1 API_HOST=127.0.0.1
.\nssm.exe set AntidetectService Start SERVICE_AUTO_START
Start-Service AntidetectService
```

NSSM автоматически перезапускает процесс при падении.

### Не дать RDP-сессии умереть (критично!)

Браузер работает в *headed*-режиме — ему нужна активная Windows-сессия даже,
когда никто не подключён по RDP:

```powershell
# Автологон (подставьте свои логин/пароль):
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' DefaultUserName 'Administrator'
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' DefaultPassword '<PASSWORD>'
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '1'

# Не завершать отключённые сессии:
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' MaxDisconnectionTime 0 -Type DWord
```

Перезагрузите сервер один раз — сессия залогинится сама и останется доступной.

## 5. Traefik (обратный прокси)

Если Traefik в Docker уже крутится — добавьте роутер на хостовый сервис.
Сервис слушает loopback хоста; изнутри Docker это `host.docker.internal`:

```yaml
# динамический конфиг (file provider) или эквивалентные labels:
http:
  routers:
    antidetect:
      rule: "Host(`10.8.0.1`)"
      entryPoints: [web]
      service: antidetect-svc
  services:
    antidetect-svc:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:50325"
```

Для Linux-движка Docker добавьте контейнеру:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Traefik пробрасывает WebSocket-upgrade по умолчанию — `/cdp/*` и `/cdp-view/*`
работают из коробки.

*Вариант без Traefik:* пропустите этот шаг совсем — панель и API доступны
напрямую на `http://10.8.0.1:50325/ui`, если задать `API_HOST=10.8.0.1`
(только внутри VPN). Traefik оставляем ради единой точки входа и простого TLS
в будущем.

## 6. Файрвол

Наружу открываем минимум:

```powershell
New-NetFirewallRule -DisplayName "WireGuard" -Direction Inbound -Protocol UDP -LocalPort 51820 -Action Allow
New-NetFirewallRule -DisplayName "Block RDP from WAN" -Direction Inbound -Protocol TCP -LocalPort 3389 -RemoteAddress Internet -Action Block
```

RDP остаётся доступен внутри VPN-сети.

## 7. Как пользоваться

**Панель** (с любого устройства с WG-конфигом): откройте `http://10.8.0.1/ui`,
введите API-ключ (печатается сервисом; лежит в
`C:\Users\<вы>\.antidetect\data\api_key`). Создавайте профили, запускайте,
жмите **View** — браузер стримится прямо в страницу, мышь и клавиатура работают.

**Автоматизация** (пример Playwright):

```js
import { chromium } from 'playwright';

const res = await fetch('http://10.8.0.1/api/v1/browser/start?user_id=<id>', {
  headers: { Authorization: 'Bearer <API_KEY>' },
}).then((r) => r.json());

const wsEndpoint = res.data.ws.puppeteer.replace('127.0.0.1', '10.8.0.1'); // уже туннельный URL
const browser = await chromium.connectOverCDP(wsEndpoint);
const context = browser.contexts()[0];
// ...рассылки, парсинг и т.д.
await fetch('http://10.8.0.1/api/v1/browser/stop?user_id=<id>', {
  headers: { Authorization: 'Bearer <API_KEY>' },
});
```

То же самое работает с любой внешней машины, у которой есть WG-пир.

## 8. Перенос существующих локальных профилей

1. Остановите сервис локально (закройте десктоп-приложение).
2. Скопируйте папку данных (по умолчанию `%USERPROFILE%\.antidetect\data`,
   либо кастомную, выбранную в настройках) на сервер по тому же пути.
3. Запустите сервис там. Профили, cookies, сессии и прокси переедут как есть.

## 9. Чек-лист безопасности

- [ ] В интернет открыт только UDP 51820; RDP/API/панель — только через VPN
- [ ] API-ключ храните как секрет; ротация — удалить `data\api_key` и перезапустить
- [ ] Иногда просматривайте `server.log` (в папке данных) — там каждый запрос
- [ ] Один WG-пир на устройство/сервис; неиспользуемые пиры удаляйте
- [ ] Windows Update включён; пароль автологона достаточно стойкий
- [ ] Бэкапы: периодически зипуйте папку данных при остановленном сервисе

## 10. Траблшутинг

| Симптом | Решение |
|---|---|
| `403 forbidden host` | Добавьте IP/хост точки входа в `ANTIDETECT_TRUSTED_HOSTS` |
| Панель грузится, но вьюер пишет `connection error` | Проверьте, что Traefik пробрасывает upgrade (по умолчанию да), и схема `ws://` соответствует |
| Браузер стартует, но окна не видно / умирает после выхода из RDP | Проверьте автологон + `MaxDisconnectionTime=0`; сессия должна жить |
| `/cdp/*` отвечает `profile is not running` | Сначала запустите профиль (`/browser/start`) |
| Панель просит пароль | Не должна — пароля у панели нет. Если видите запрос сохранённых данных, очистите `localStorage` для страницы: панель сама берёт API-ключ из `GET /ui/key` |
| Ядро не найдено | Выполните `npm run ensure-kernel` на сервере |

---

Связанные доки: [`API_CONTRACT.md`](API_CONTRACT.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (исторический обзор; живая модель данных в `src/main/db/schema.ts`),
Cloud Sync — реализован, не отложен: `src/main/cloud/`, `src/main/teams/syncClient.ts`, `packages/sync-server/`.
