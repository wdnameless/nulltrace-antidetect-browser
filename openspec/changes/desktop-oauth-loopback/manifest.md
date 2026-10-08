# Requirements manifest — desktop OAuth loopback flow

## Rows

**R01.** «Я хочу сделать, чтобы пользователь просто скачал наш браузер, захотел синхронизировать профили через Google диск, нажал одну кнопку, у него бы появилась всплывающее окно браузера, где просят разрешения»
→ One button in the app opens the operator's own browser at Google's consent screen. No code to type, no second device, no Client ID to paste.

**R02.** «он его делает на одном другом клиенте на разных устройствах. И все, и у него работает синхронизация»
→ The same button works identically on every machine. Each grants its own refresh token; all machines land in the same Drive folder with the same passphrase, so the data converges.

**R03.** «и дальше он уже настраивается му[льти]синхронизацию»
→ After connecting, the operator configures multi-device sync from the status panel — log, conflicts, verify — without re-authenticating.

## Derived obligations

| R | Obligation |
|---|---|
| R01 | Authorization code + PKCE + loopback, the flow Google recommends for a desktop application. No shipped secret anywhere in the binary. |
| R01 | A client of the wrong TYPE is refused before the browser opens, with a message naming the fix, because Google rejects TV/Limited-Input clients for loopback at the authorization endpoint. |
| R02 | The refresh token and passphrase unlock are per machine; the Drive folder is shared by name across machines. |
| R03 | Status exposes the outcome (`connected`, `lastError`) and the log records every attempt, so a failed connect is diagnosable from the panel.

## Rows not claimed

None. Every word of the request maps to a row above.
