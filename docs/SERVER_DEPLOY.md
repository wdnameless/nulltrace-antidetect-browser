# Server Deployment Guide (EN)

Deploy the Antidetect Browser on your own **Windows dedicated/VPS** so that:

- profiles live on the server (single source of truth) and never leave it;
- you can manage and *use* profiles from any device through the built-in web
  panel (`/ui`) — the browser itself runs on the server, streamed to you via
  CDP screencast with full mouse/keyboard control;
- your automation (Puppeteer / Playwright / Selenium) connects over the API
  from anywhere.

Everything is free software: Node.js, WireGuard, Traefik, NSSM.

```
Your laptop / tablet / automation service          Windows dedicated server
        │                                                   │
        ├────────── WireGuard tunnel (UDP only) ───────────►│
        ▼                                                   ▼
   http://10.8.0.1/                                  Traefik (Docker)
    ├─ /ui        web panel                          │ http://host.docker.internal:50325
    ├─ /api/v1/*  REST                               ▼
    └─ /cdp/:id   CDP tunnel                Antidetect Service (:50325, loopback)
                                            └─ Chromium per profile (headed,
                                               user-data-dir on server disk)
```

Nothing except the WireGuard UDP port is reachable from the internet.

---

## 1. Install Node.js LTS

```powershell
winget install OpenJS.NodeJS.LTS
# or download https://nodejs.org msi
node -v
```

## 2. Get the application

```powershell
git clone <REPO_URL> C:\antidetect
cd C:\antidetect
npm ci
npm run build:main
npm run ensure-kernel      # downloads fingerprint-chromium kernel
npm run ensure-chromedriver
```

> If `ensure-kernel` cannot download on the server, install the app locally
> first and copy the whole project folder (the kernel lives in `data\`).

Smoke test: `npm run service` — the console prints an API key. Stop with Ctrl+C.

## 3. WireGuard (VPN transport)

Install WireGuard on the server: https://www.wireguard.com/install/

**Server** (`C:\wg\server.conf`):

```ini
[Interface]
PrivateKey = <SERVER_PRIVATE_KEY>
Address = 10.8.0.1/24
ListenPort = 51820

[Peer]                      # one block per client device/service
PublicKey = <CLIENT1_PUBLIC_KEY>
AllowedIPs = 10.8.0.2/32

[Peer]
PublicKey = <CLIENT2_PUBLIC_KEY>
AllowedIPs = 10.8.0.3/32
```

Generate keys in PowerShell:

```powershell
& 'C:\Program Files\WireGuard\wg.exe' genkey | Set-Content server.key
& 'C:\Program Files\WireGuard\wg.exe' pubkey < server.key   # or: Get-Content server.key | & wg.exe pubkey
```

Activate the tunnel: WireGuard app → Import tunnel → Activate.
On Windows also allow incoming UDP 51820 in the firewall (step 6).

**Client devices**: install WireGuard, create a config:

```ini
[Interface]
PrivateKey = <CLIENT_PRIVATE_KEY>
Address = 10.8.0.2/32

[Peer]
PublicKey = <SERVER_PUBLIC_KEY>
Endpoint = <SERVER_PUBLIC_IP>:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```

Now the server is reachable as `10.8.0.1` from every peer — no domain needed.

## 4. Run the service in server mode

Environment variables (set them system-wide for the service account):

| Variable | Value | Purpose |
|---|---|---|
| `ANTIDETECT_SERVER_MODE` | `1` | trusted hosts, file request log, no CORS |
| `ANTIDETECT_TRUSTED_HOSTS` | `10.8.0.1` | Host headers accepted behind the proxy |
| `API_HOST` | `127.0.0.1` | bind loopback only |

### Autostart with NSSM (recommended)

```powershell
# https://nssm.cc/download → copy nssm.exe to C:\antidetect\
.\nssm.exe install AntidetectService "C:\Program Files\nodejs\node.exe" "C:\antidetect\dist\src\main\index.js"
.\nssm.exe set AntidetectService AppDirectory C:\antidetect
.\nssm.exe set AntidetectService AppEnvironmentExtra ANTIDETECT_SERVER_MODE=1 ANTIDETECT_TRUSTED_HOSTS=10.8.0.1 API_HOST=127.0.0.1
.\nssm.exe set AntidetectService Start SERVICE_AUTO_START
Start-Service AntidetectService
```

NSSM restarts the process automatically if it crashes.

### Keep a desktop session alive (critical!)

The browser runs *headed*, which requires an active Windows session even when
nobody is connected via RDP:

```powershell
# Automatic logon (replace user/password):
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' DefaultUserName 'Administrator'
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' DefaultPassword '<PASSWORD>'
Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' AutoAdminLogon '1'

# Do not end disconnected sessions:
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' MaxDisconnectionTime 0 -Type DWord
```

Reboot once — the session auto-logs-on and stays available for Chromium.

## 5. Traefik (reverse proxy)

If you already run Traefik in Docker, add a router pointing at the host
service. The service listens on host loopback; from inside Docker use
`host.docker.internal`:

```yaml
# dynamic config (file provider) or equivalent labels:
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

For Linux-style Docker engines add to the container:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Traefik passes WebSocket upgrades by default — `/cdp/*` and `/cdp-view/*`
work out of the box.

*No-Traefik variant:* skip step 5 entirely — the panel and API are reachable
directly at `http://10.8.0.1:50325/ui` if you set `API_HOST=10.8.0.1`
(inside VPN only). Traefik is kept because it gives you a single entry point
and easy TLS later.

## 6. Firewall

Allow only what is necessary:

```powershell
New-NetFirewallRule -DisplayName "WireGuard" -Direction Inbound -Protocol UDP -LocalPort 51820 -Action Allow
New-NetFirewallRule -DisplayName "Block RDP from WAN" -Direction Inbound -Protocol TCP -LocalPort 3389 -RemoteAddress Internet -Action Block
```

RDP stays available inside the VPN network.

## 7. Use it

**Panel** (any device with the WG config): open `http://10.8.0.1/ui`,
enter the API key (printed by the service / stored in
`C:\Users\<you>\.antidetect\data\api_key`). Create profiles, start them,
click **View** — the browser streams into the page; mouse and keyboard work.

**Automation** example (Playwright):

```js
import { chromium } from 'playwright';

const res = await fetch('http://10.8.0.1/api/v1/browser/start?user_id=<id>', {
  headers: { Authorization: 'Bearer <API_KEY>' },
}).then((r) => r.json());

const wsEndpoint = res.data.ws.puppeteer.replace('127.0.0.1', '10.8.0.1'); // already tunneled URL
const browser = await chromium.connectOverCDP(wsEndpoint);
const context = browser.contexts()[0];
// ... do your thing (mailings, scraping, etc.)
await fetch('http://10.8.0.1/api/v1/browser/stop?user_id=<id>', {
  headers: { Authorization: 'Bearer <API_KEY>' },
});
```

The same works from any external machine that has a WireGuard peer config.

## 8. Migrating existing local profiles

1. Stop the service locally (close the desktop app).
2. Copy the data folder (default `%USERPROFILE%\.antidetect\data`, or the
   custom dir chosen in Settings) to the same path on the server.
3. Start the service there. Profiles, cookies, sessions, proxies arrive intact.

## 9. Security checklist

- [ ] Only UDP 51820 open to the internet; RDP/API/panel reachable via VPN only
- [ ] API key treated as a secret; rotate by deleting `data\api_key` and restarting
- [ ] `server.log` (in the data dir) reviewed occasionally — every request logged
- [ ] One WireGuard peer per device/service; revoke unused peers
- [ ] Windows Update enabled; automatic logon password is strong
- [ ] Backups: periodically zip the data folder while the service is stopped

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `403 forbidden host` | Add your entry point IP/host to `ANTIDETECT_TRUSTED_HOSTS` |
| Panel loads but WS viewer says `connection error` | Ensure Traefik forwards upgrades (default) and you connect via `ws://`, not `https://` mismatch |
| Browser starts but window is invisible / dies after RDP logout | Re-check autologon + `MaxDisconnectionTime=0`; the session must stay active |
| `profile is not running` on `/cdp/*` | Start the profile first (`/browser/start`) |
| Panel asks for a password | It does not — there is no panel password. If you are seeing a stored credential prompt, clear `localStorage` for the page; the panel now authenticates itself with the API key from `GET /ui/key` |
| Kernel not found | Run `npm run ensure-kernel` on the server |

---

Related docs: [`API_CONTRACT.md`](API_CONTRACT.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md) (historical overview; live data model in `src/main/db/schema.ts`),
Cloud Sync — implemented, not deferred: `src/main/cloud/`, `src/main/teams/syncClient.ts`, `packages/sync-server/`.
