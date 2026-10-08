# Interfaces — desktop OAuth loopback flow

## 1. Loopback flow

**Owner: `src/main/cloud/oauthLoopback.ts`** (new)

```ts
export interface LoopbackAuthorization {
  url: string;
  code: Promise<string>;
  verifier: string;
  cancel: (reason?: string) => void;
  redirectUri: string;
}
export class OAuthLoopbackError extends Error {
  constructor(
    message: string,
    public readonly code: 'CANCELLED' | 'TIMEOUT' | 'DENIED' | 'PORT' | 'STATE' | 'CLIENT_TYPE',
    public readonly userActionableMessage?: string
  );
}
export async function beginLoopbackAuthorization(args: {
  clientId: string;
  scope: string;
  createListener?: () => Server;
  skipPreflight?: boolean;
}): Promise<LoopbackAuthorization>;
```

`skipPreflight` exists only for unit tests that exercise the loopback mechanics; production calls always leave it off. The returned `verifier` is the PKCE secret half and must reach Google only inside the token exchange.

## 2. Token exchange

**Owner: `src/main/cloud/gdriveClient.ts`** — `HttpOAuthTransport.exchangeAuthCode` gains an optional fifth parameter `codeVerifier?: string`, appended to the form body as `code_verifier`. The interface gains the same parameter. All existing callers are untouched because it is optional.

## 3. HTTP

**Owner: `src/main/api/routes/cloud.ts`** (additive; the device-code routes are unchanged)

- `POST /api/v1/cloud/gdrive/authorize` — body `{ passphrase }` (min 8). Responds
  `{ awaitingAuthorization: true, redirectUri, url? }`; `url` is only set when the browser could
  not be opened automatically.
- `POST /api/v1/cloud/gdrive/authorize/cancel` — no body. Responds
  `{ awaitingAuthorization: false }`.

At most one attempt is in flight per process (`pendingAuthorization`); a second authorize answers 409. Every detached outcome is recorded via `noteAuthorizationFailure` / `noteAuthorizationSuccess` into the status and the sync log, because the HTTP response that started the flow is already gone.

Also new: `openInBrowser(target)` — shell-free browser opener extracted from the device-code route so both flows spawn the same way. Returns whether an opener started.

## 4. Engine

**Owner: `src/main/cloud/gdriveSync.ts`** — one export added:

```ts
export function setSyncError(message: string | null): void;
```

Writes `lastError` and appends a log row, for outcomes that arrive after their request has been answered.

## 5. Renderer

**Owner: `src/renderer/src/api.ts`** — `cloudGdriveAuthorize(passphrase)`, `cloudGdriveAuthorizeCancel()`.

**Owner: `src/renderer/src/pages/CloudSync.tsx`** — the connect handler opens the flow, switches to a waiting state, polls `/gdrive/status` every 1.5 s, and settles on `connected && unlocked` (success) or `lastError` (failure). The poll handle lives in a ref and is cleared on settle.

## 6. Settings types

**Owner: `src/main/config.ts`** — `getSetting` now returns `SettingValue | undefined` (a JSON union) instead of `unknown`; `setSetting` takes `SettingValue`; `importSyncableSettings` validates with a small `isSettingValue` guard. Narrowing only — 32 existing call sites compile unchanged.
