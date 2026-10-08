// Cloud Sync bridge: lets the desktop app connect to a self-hosted server
// instance (see docs/SERVER_DEPLOY.md), manage credentials, inspect login
// sessions and push/pull profile bundles. The renderer talks only to THIS
// local API; all remote calls are made here, so the remote never needs CORS
// for us and credentials stay in the main process.
import { Router, Request, Response } from 'express';
import * as child_process from 'child_process';
import { z } from 'zod';
import * as pm from '../../profiles/profileManager';
import { isRunning } from '../../launcher/chromium';
import { assertPublicHttpUrl } from '../../util/outboundUrl';
import { getSetting, setSetting } from '../../config';
import { beginLoopbackAuthorization } from '../../cloud/oauthLoopback';
import { setCachedAccessToken } from '../../cloud/gdriveAuth';
import { protectSecret, revealSecret } from '../../util/secretStore';
import {
  getGDriveStatus,
  saveGDriveCredentials,
  disconnectGDrive,
  saveGDriveRefreshToken,
  saveGDriveUserEmail,
  getGDriveCredentials,
} from '../../cloud/gdriveAuth';
import {
  getSyncStatus,
  getSessionPassphrase,
  requestSync,
  unlockSession,
  setPendingPassphrase,
  getPendingPassphrase,
  clearPendingPassphrase,
  clearSyncSession,
  changePassphrase,
  verifyRemoteState,
  getSyncLog,
  pullMirrorNow,
  setSyncError,
} from '../../cloud/gdriveSync';
import {
  getOAuthTransport,
  GDRIVE_REQUIRED_SCOPE,
  finalizeTokenExchange,
} from '../../cloud/gdriveClient';
import {
  pushToGDrive,
  inspectGDrivePull,
  pullFromGDrive,
  ConflictResolution,
} from '../../cloud/gdriveTransfer';

const router = Router();

const CONNECT_TIMEOUT_MS = 8000;

interface CloudState {
  url: string;
  token: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function getCloud(): CloudState {
  return {
    url: str(getSetting('cloudUrl')).replace(/\/+$/, ''),
    token: revealSecret(str(getSetting('cloudToken'))) ?? '',
  };
}

function saveToken(token: string): void {
  setSetting('cloudToken', protectSecret(token) ?? '');
}

function normalizeUrl(input: string): string {
  let u = String(input || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  token?: string
): Promise<{ status: number; json: Record<string, unknown> | undefined; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, signal: ctrl.signal });
    let json: Record<string, unknown> | undefined;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // non-JSON body
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: undefined, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Ping the remote and summarize its state. */
async function probeRemote(url: string, token?: string): Promise<Record<string, unknown>> {
  if (!url) return { connected: false, error: 'not configured' };
  const status = await fetchJson(`${url}/status`);
  if (status.status !== 200) {
    return { connected: false, url, error: status.error ?? `HTTP ${status.status}` };
  }
  const version =
    status.json && typeof status.json.data === 'object' && status.json.data !== null
      ? ((status.json.data as Record<string, unknown>).version as string | undefined)
      : undefined;
  // Verify the token when we have one. This is the same check that gates push/pull, so a
  // remote that answers here will also accept the sync calls.
  let authorized: boolean | undefined;
  if (token) {
    const check = await fetchJson(`${url}/api/v1/browser/list?page=1&page_size=1`, {}, token);
    authorized = check.status === 200;
  }
  return { connected: true, url, version, authorized };
}

router.get('/api/v1/cloud/state', async (_req, res) => {
  const cloud = getCloud();
  const remote = cloud.url ? await probeRemote(cloud.url, cloud.token || undefined) : { connected: false };
  res.json({
    code: 0,
    msg: 'success',
    data: { configured: Boolean(cloud.url), url: cloud.url, hasToken: Boolean(cloud.token), ...remote },
  });
});

router.post('/api/v1/cloud/connect', async (req: Request, res: Response) => {
  const url = normalizeUrl(String(req.body?.url || ''));
  if (!url) {
    res.json({ code: -1, msg: 'url is required', data: {} });
    return;
  }
  /*
   * The URL is not merely probed, it is PERSISTED as `cloudUrl` and used afterwards by
   * /cloud/state, /remote-list, /push and /pull — so an unvalidated value here is a standing
   * request primitive against whatever address was supplied, not a one-shot read. `normalizeUrl`
   * only trims a trailing slash and prefixes `http://` when the scheme is missing, so it accepted
   * loopback, link-local and intranet hosts. Measured before this guard: connecting to
   * `http://127.0.0.1:50325` returned that local server's own /status payload, proving the dial.
   */
  const policy = await assertPublicHttpUrl(url);
  if (!policy.ok) {
    res.json({ code: -1, msg: policy.error ?? 'url not permitted', data: {} });
    return;
  }
  // The remote key is supplied by the operator. The local instance used to obtain one by
  // calling the remote's username/password login; that endpoint is gone with the panel
  // password, and a cross-origin key fetch is refused by design. So the operator pastes the
  // key — it is in the remote's own panel (`GET /ui/key` on that machine, same-origin) or in
  // its startup log line `[antidetect] ready. API key: ...`.
  const providedKey = str(req.body?.key).trim();
  const probe = await probeRemote(url, providedKey || undefined);
  if (!probe.connected) {
    res.json({ code: -1, msg: `server unreachable (${probe.error ?? 'unknown'})`, data: probe });
    return;
  }
  setSetting('cloudUrl', url);
  if (providedKey) saveToken(providedKey);
  if (providedKey && probe.authorized === false) {
    res.json({ code: -1, msg: 'the server rejected that API key', data: { ...probe, url } });
    return;
  }
  res.json({
    code: 0,
    msg: 'success',
    data: { configured: true, url, hasToken: Boolean(getCloud().token), ...probe },
  });
});

router.post('/api/v1/cloud/disconnect', (_req, res) => {
  setSetting('cloudUrl', '');
  setSetting('cloudToken', '');
  res.json({ code: 0, msg: 'success', data: {} });
});

/** List profiles that exist on the remote server. */
router.get('/api/v1/cloud/remote-list', async (_req, res) => {
  const cloud = getCloud();
  if (!cloud.url || !cloud.token) {
    res.json({ code: -1, msg: 'not connected', data: {} });
    return;
  }
  const r = await fetchJson(`${cloud.url}/api/v1/browser/list?page=1&page_size=500`, {}, cloud.token);
  if (r.status === 200 && r.json?.code === 0) {
    res.json(r.json);
    return;
  }
  res.json({ code: -1, msg: (r.json && (r.json.msg as string)) || `HTTP ${r.status}`, data: {} });
});

interface SyncResultRow {
  user_id: string;
  name: string;
  ok: boolean;
  new_id?: string;
  skipped?: string;
  error?: string;
}

/** Push local profiles to the remote server (export bundle -> import). */
router.post('/api/v1/cloud/push', async (req: Request, res: Response) => {
  const cloud = getCloud();
  if (!cloud.url || !cloud.token) {
    res.json({ code: -1, msg: 'not connected', data: {} });
    return;
  }
  const requested = Array.isArray(req.body?.user_ids) ? (req.body.user_ids as string[]) : null;
  const locals = pm.listProfiles(1, 1000).list.filter((p) => !isRunning(p.user_id));
  const targets = requested ? locals.filter((p) => requested.includes(p.user_id)) : locals;

  const results: SyncResultRow[] = [];
  for (const p of targets.slice(0, 500)) {
    try {
      const bundle = pm.exportProfileBundle(p.user_id);
      if (!bundle) {
        results.push({ user_id: p.user_id, name: p.name ?? '', ok: false, error: 'export failed' });
        continue;
      }
      const r = await fetchJson(
        `${cloud.url}/api/v1/browser-profile/import-bundle`,
        { method: 'POST', body: JSON.stringify({ bundle }) },
        cloud.token
      );
      const data = r.json?.data as Record<string, unknown> | undefined;
      const ok = r.status === 200 && r.json?.code === 0 && typeof data?.user_id === 'string';
      results.push({
        user_id: p.user_id,
        name: p.name ?? '',
        ok,
        new_id: ok ? String(data?.user_id) : undefined,
        error: ok ? undefined : ((r.json?.msg as string) ?? `HTTP ${r.status}`),
      });
    } catch (err) {
      results.push({ user_id: p.user_id, name: p.name ?? '', ok: false, error: (err as Error).message });
    }
  }
  res.json({
    code: 0,
    msg: 'success',
    data: { pushed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results },
  });
});

/** Pull profiles from the remote server into this machine. */
router.post('/api/v1/cloud/pull', async (req: Request, res: Response) => {
  const cloud = getCloud();
  if (!cloud.url || !cloud.token) {
    res.json({ code: -1, msg: 'not connected', data: {} });
    return;
  }
  const requested = Array.isArray(req.body?.user_ids) ? (req.body.user_ids as string[]) : null;
  const listRes = await fetchJson(`${cloud.url}/api/v1/browser/list?page=1&page_size=500`, {}, cloud.token);
  const data = listRes.json?.data as Record<string, unknown> | undefined;
  const remoteList = (data?.list as Array<Record<string, unknown>> | undefined) ?? [];
  if (!Array.isArray(remoteList)) {
    res.json({ code: -1, msg: 'cannot list remote profiles', data: {} });
    return;
  }

  const results: SyncResultRow[] = [];
  for (const item of remoteList) {
    const rid = String(item.user_id ?? '');
    if (!rid || (requested && !requested.includes(rid))) continue;
    try {
      const exp = await fetchJson(
        `${cloud.url}/api/v1/browser-profile/export?user_id=${encodeURIComponent(rid)}`,
        {},
        cloud.token
      );
      const expData = exp.json?.data as Record<string, unknown> | undefined;
      const bundle = expData?.bundle as pm.ProfileBundle | undefined;
      if (!bundle) {
        results.push({ user_id: rid, name: String(item.name ?? ''), ok: false, error: 'remote export failed' });
        continue;
      }
      const newId = pm.importProfileBundle(bundle);
      results.push({ user_id: rid, name: String(item.name ?? ''), ok: true, new_id: newId });
    } catch (err) {
      results.push({ user_id: rid, name: String(item.name ?? ''), ok: false, error: (err as Error).message });
    }
  }
  res.json({
    code: 0,
    msg: 'success',
    data: { pulled: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results },
  });
});

// ============================================================================
// Google Drive Sync Endpoints (nulltrace-gdrive)
// ============================================================================

/** Get GDrive status (safe status object, never leaks tokens or secrets) */
router.get('/api/v1/cloud/gdrive/status', (_req: Request, res: Response) => {
  res.json({
    code: 0,
    msg: 'success',
    data: {
      ...getGDriveStatus(),
      ...getSyncStatus(),
      // Read through the mirror module so the switch and the engine agree on where the flag lives.
      // The UI needs this on load: without it the toggle rendered "off" for an operator who had
      // enabled it, and the next click silently turned it back on instead of off.
      mirrorEnabled: readMirrorEnabled(),
    },
  });
});

/**
 * Whether the opt-in directory mirror is on.
 *
 * Delegates to the mirror module when it is available, and falls back to the same setting key it
 * uses. The two used to disagree (`gdrive_mirror_enabled` vs `gdriveFullMirrorEnabled`), so a
 * toggle written by the route was invisible to the module that reads it.
 */
function readMirrorEnabled(): boolean {
  try {
    // Synchronous require keeps this a plain GET with no await; the module has no side effects at
    // load time beyond reading a setting.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../cloud/gdriveFullMirror') as { isMirrorEnabled?: () => boolean };
    if (typeof mod.isMirrorEnabled === 'function') return mod.isMirrorEnabled();
  } catch {
    // fall through to the setting key below
  }
  return getSetting('gdriveFullMirrorEnabled') === true;
}

/**
 * Minimum passphrase length, enforced on the SERVER.
 *
 * The UI already asks for 8 characters, but a UI-only rule is not a rule: the API is what an
 * operator's agent, a script, or a stale client actually calls. The passphrase is the only thing
 * protecting the uploaded payload — a one-character phrase turns AES-256-GCM into decoration,
 * because the ciphertext travels with everything needed to brute-force it. Verified: `abc` was
 * accepted and unlocked the session before this bound existed.
 */
const SYNC_PASSPHRASE_MIN_LENGTH = 8;

const connectSchema = z.object({
  passphrase: z
    .string()
    .min(SYNC_PASSPHRASE_MIN_LENGTH, `Passphrase must be at least ${SYNC_PASSPHRASE_MIN_LENGTH} characters`),
});

/** Connect to Google Drive in one step: runs device-code auth if needed, then unlocks */
router.post('/api/v1/cloud/gdrive/connect', async (req: Request, res: Response) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      code: 400,
      msg: parsed.error.errors[0]?.message || 'Passphrase is required',
    });
    return;
  }

  const { passphrase } = parsed.data;
  const { getGDriveCredentials, getGDriveRefreshToken, getGDriveUserEmail } = await import('../../cloud/gdriveAuth');
  const creds = getGDriveCredentials();
  if (!creds || !creds.clientId) {
    res.status(400).json({
      code: 400,
      msg: 'Google OAuth Client ID must be configured first',
    });
    return;
  }

  const isAlreadyConnected = Boolean(getGDriveRefreshToken());

  if (isAlreadyConnected) {
    const unlocked = await unlockSession(passphrase);
    if (!unlocked) {
      res.status(400).json({
        code: 'BAD_PASSPHRASE',
        msg: 'Incorrect passphrase',
      });
      return;
    }
    const email = getGDriveUserEmail() ?? undefined;
    res.json({
      code: 0,
      msg: 'Connected successfully',
      data: { email },
      email,
    });
    return;
  }

  // Not yet authorized: run device-code flow
  setPendingPassphrase(passphrase);
  try {
    const transport = getOAuthTransport();
    const deviceResp = await transport.requestDeviceCode(creds.clientId, GDRIVE_REQUIRED_SCOPE);

    // Check for instant approval (e.g. test mock transport)
    const pollCheck = await transport.pollDeviceToken(creds.clientId, creds.clientSecret, deviceResp.device_code);
    if (pollCheck.status === 'success' && pollCheck.data) {
      const finalInfo = await finalizeTokenExchange(pollCheck.data);
      const unlocked = await unlockSession(passphrase);
      clearPendingPassphrase();
      if (!unlocked) {
        res.status(400).json({
          code: 'BAD_PASSPHRASE',
          msg: 'Incorrect passphrase',
        });
        return;
      }
      res.json({
        code: 0,
        msg: 'Connected successfully',
        data: { email: finalInfo.email },
        email: finalInfo.email,
      });
      return;
    }

    // Launch platform browser for device-code authorization
    openInBrowser(String(deviceResp.verification_url || ''));

    res.json({
      code: 0,
      msg: 'Device authorization required',
      data: {
        userCode: deviceResp.user_code,
        verificationUrl: deviceResp.verification_url,
        deviceCode: deviceResp.device_code,
        expiresIn: deviceResp.expires_in,
        interval: deviceResp.interval,
      },
    });
  } catch (err: unknown) {
    res.status(500).json({
      code: 500,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
});

const unlockSchema = z.object({
  passphrase: z
    .string()
    .min(SYNC_PASSPHRASE_MIN_LENGTH, `Passphrase must be at least ${SYNC_PASSPHRASE_MIN_LENGTH} characters`),
});

/**
 * Which opener this platform has, and the argument that carries the URL.
 *
 * Shell-free is the point: `child_process.exec` passes the string to a shell, and the device-flow
 * URL comes from a remote server's JSON response. A URL containing a quote or `&` ended the quoted
 * argument and appended its own command, so a hostile or compromised remote could run a program here
 * during login. `cmd.exe /c start "" <url>` with an argv array is still unsafe and was measured to
 * be — `cmd.exe` re-parses its own command line and `http://example.com/&echo INJECTED&` printed
 * `INJECTED`. `rundll32 url.dll,FileProtocolHandler` receives the URL as one opaque argument with
 * nothing executed.
 */
function browserOpener(target: string): [string, string[]] {
  if (process.platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', target]];
  if (process.platform === 'darwin') return ['open', [target]];
  return ['xdg-open', [target]];
}

/**
 * Open a URL in the operator's default browser.
 *
 * The scheme check is the second half of the safety story: an opener hands `file://` or a custom
 * protocol to a registered handler, so only a web URL is opened at all. Failure is never fatal — the
 * UI shows the URL and the code regardless, so the operator can always finish by hand.
 */
function openInBrowser(target: string): boolean {
  if (!/^https?:\/\//i.test(target)) return false;
  try {
    const [cmd, args] = browserOpener(target);
    const child = child_process.spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* non-fatal */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Unlock sync engine for this session using operator's passphrase */
router.post('/api/v1/cloud/gdrive/unlock', async (req: Request, res: Response) => {
  const parsed = unlockSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      code: 400,
      msg: parsed.error.errors[0]?.message || 'Passphrase is required',
    });
    return;
  }

  const ok = await unlockSession(parsed.data.passphrase);
  if (!ok) {
    res.status(400).json({
      code: 'BAD_PASSPHRASE',
      msg: 'Incorrect passphrase',
    });
    return;
  }

  res.json({
    code: 0,
    msg: 'Unlocked successfully',
    data: { ok: true },
    ok: true,
  });
});

const loopbackConnectSchema = z.object({
  passphrase: z
    .string()
    .min(SYNC_PASSPHRASE_MIN_LENGTH, `Passphrase must be at least ${SYNC_PASSPHRASE_MIN_LENGTH} characters`),
});

/**
 * Read the connected account's address, and remember it.
 *
 * Best effort by design: a profile that syncs without a display name is fine, and the status screen
 * saying "Google Drive" instead of an address is not worth failing a successful connection over.
 */
async function finalizeAccountInfo(accessToken: string): Promise<string | undefined> {
  try {
    const info = await getOAuthTransport().fetchUserInfo(accessToken);
    if (info.email) saveGDriveUserEmail(info.email);
    return info.email;
  } catch {
    return undefined;
  }
}

/**
 * Record how a detached authorization ended.
 *
 * By the time an attempt resolves, the HTTP response that started it is long gone, so this is the
 * only channel the operator has. It writes to the sync log and to `lastError`, which the status
 * panel and the log panel both read.
 */
function noteAuthorizationFailure(reason: string): void {
  setSyncError(reason);
}

function noteAuthorizationSuccess(email: string | undefined): void {
  setSyncError(null);
  setSetting('gdriveLastAccount', email ?? '');
}

/**
 * The authorization attempt currently in flight, if any.
 *
 * Held at module scope because the flow is two requests: this one opens the browser and returns, and
 * the operator's approval arrives at the loopback listener up to five minutes later. Only one
 * attempt can be live — a second one would leave the first listener holding a port and its `code`
 * promise rejected with nobody listening.
 */
let pendingAuthorization: { cancel: (reason?: string) => void } | null = null;
/**
 * Held from the first guard check until the background exchange finally completes.
 *
 * `pendingAuthorization` alone cannot cover the gap: it is null until the flow object exists, so a
 * double-click lands both requests inside the `beginLoopbackAuthorization` await and both pass the
 * 409 guard. This flag is claimed synchronously before any await and keeps the 409 closed through
 * the exchange itself, because a cancel arriving after the callback is a valid cancellation of the
 * credential write, not a no-op — the second authorize that it would admit is the interleave.
 */  
let authorizationInFlight = false;

/**
 * One-button connect: authorization code + PKCE over a loopback redirect.
 *
 * This is the flow that needs no shipped secret. The device-code flow the app used before requires
 * `client_secret` on every token call, which for a distributed binary means either publishing the
 * secret or failing every login — and the shipped client is a "TVs and Limited Input devices" type,
 * for which Google rejects loopback outright. A Desktop client accepts an ephemeral loopback port,
 * so there is nothing to register per installation and nothing secret in the build.
 *
 * Returns as soon as the browser is open. The exchange happens in the background and the renderer
 * learns the outcome by polling `/gdrive/status`, because holding this request open for the operator
 * to finish in another window would time out their own HTTP client.
 */
router.post('/api/v1/cloud/gdrive/authorize', async (req: Request, res: Response) => {
  const parsed = loopbackConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      code: 400,
      msg: parsed.error.errors[0]?.message || 'Passphrase is required',
    });
    return;
  }

  const creds = getGDriveCredentials();
  if (!creds?.clientId) {
    res.status(400).json({ code: 400, msg: 'Google OAuth Client ID must be configured first' });
    return;
  }

  if (authorizationInFlight) {
    res.status(409).json({
      code: 409,
      msg: 'An authorization is already in progress. Finish it in the browser, or cancel and retry.',
    });
    return;
  }
  authorizationInFlight = true;

  const passphrase = parsed.data.passphrase;
  const transport = getOAuthTransport();

  try {
    const flow = await beginLoopbackAuthorization({
      clientId: creds.clientId,
      scope: GDRIVE_REQUIRED_SCOPE,
    });
    pendingAuthorization = flow;

    const opened = openInBrowser(flow.url);

    /*
     * The exchange runs detached from this request. Every outcome has to be recorded somewhere the
     * operator can see, because by the time it happens the HTTP response is long gone: success
     * unlocks the session and starts the engine, and a failure lands in `lastError` and the sync log.
     */
    void (async () => {
      try {
        const code = await flow.code;
        const tokens = await transport.exchangeAuthCode(
          creds.clientId,
          creds.clientSecret,
          code,
          flow.redirectUri,
          flow.verifier
        );
        if (!tokens.refresh_token) {
          // Google omits the refresh token when the grant already exists and `prompt=consent` was
          // not honoured. Without it the session dies when the access token expires, so this is a
          // failure rather than something to paper over.
          noteAuthorizationFailure(
            'Google did not return a refresh token. Remove the app from your Google account permissions and connect again.'
          );
          return;
        }
        saveGDriveRefreshToken(tokens.refresh_token);
        setCachedAccessToken(tokens.access_token, tokens.expires_in);
        const email = await finalizeAccountInfo(tokens.access_token);
        if (!(await unlockSession(passphrase))) {
          noteAuthorizationFailure('Connected, but the passphrase was rejected.');
          return;
        }
        clearPendingPassphrase();
        noteAuthorizationSuccess(email);
      } catch (err) {
        noteAuthorizationFailure(err instanceof Error ? err.message : String(err));
      } finally {
        authorizationInFlight = false;
        pendingAuthorization = null;
      }
    })();

    res.json({
      code: 0,
      msg: 'Authorization required',
      data: {
        awaitingAuthorization: true,
        redirectUri: flow.redirectUri,
        // The renderer shows this when the browser could not be opened automatically, so the operator
        // can paste it and finish by hand.
        url: opened ? undefined : flow.url,
      },
    });
  } catch (err) {
    authorizationInFlight = false;
    pendingAuthorization = null;
    // A client-type rejection carries the one message the operator can actually act on — the plain
    // `message` is the technical diagnosis. Without this branch the renderer shows a sentence that a
    // lay reading parses as "the browser is broken".
    const message =
      err instanceof Error && 'userActionableMessage' in err
        ? String((err as { userActionableMessage: unknown }).userActionableMessage ?? err.message)
        : err instanceof Error
          ? err.message
          : String(err);
    noteAuthorizationFailure(message);
    res.status(500).json({ code: 500, msg: message });
  }
});

/** Abandon an authorization the operator no longer wants to finish. */
router.post('/api/v1/cloud/gdrive/authorize/cancel', (_req: Request, res: Response) => {
  // The flag — not the flow handle — decides whether anything was in flight: a cancel landing after
  // the callback but during the exchange must still cancel the credential write, yet the handle may
  // already be gone. And an idle cancel must not write a failure over a success that just landed.
  if (authorizationInFlight) {
    authorizationInFlight = false;
    pendingAuthorization?.cancel('cancelled by the operator');
    pendingAuthorization = null;
    noteAuthorizationFailure('Authorization cancelled');
  }
  res.json({ code: 0, msg: 'Cancelled', data: { awaitingAuthorization: false } });
});

/** Trigger on-demand sync push/pull */
router.post('/api/v1/cloud/gdrive/sync-now', async (_req: Request, res: Response) => {
  try {
    await requestSync('manual');
    res.json({
      code: 0,
      msg: 'success',
      data: getSyncStatus(),
    });
  } catch (err: unknown) {
    res.status(500).json({
      code: 500,
      msg: err instanceof Error ? err.message : String(err),
      data: getSyncStatus(),
    });
  }
});

const mirrorEnableSchema = z.object({
  enabled: z.boolean(),
});

/** Enable or disable full Chromium directory mirror (Zone C) */
router.post('/api/v1/cloud/gdrive/mirror/enable', async (req: Request, res: Response) => {
  const parsed = mirrorEnableSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      code: 400,
      msg: parsed.error.errors[0]?.message || 'Invalid body: enabled boolean is required',
    });
    return;
  }

  const { enabled } = parsed.data;
  try {
    const mirrorModule = await import('../../cloud/gdriveFullMirror');
    mirrorModule.setMirrorEnabled(enabled);
    res.json({
      code: 0,
      msg: 'success',
      data: { enabled, mirrorEnabled: enabled },
      enabled,
    });
  } catch (err: unknown) {
    res.status(500).json({
      code: 500,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Run the opt-in directory mirror: collect, seal, upload.
 *
 * Returns the bytes that actually reached Drive. An earlier version built the archive and reported
 * its size without uploading anything, so the operator was told the mirror ran while the Drive
 * folder stayed empty — a false success.
 */
router.post('/api/v1/cloud/gdrive/mirror/run', async (req: Request, res: Response) => {
  const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
  const siteStateOnly = req.body?.siteStateOnly !== false;

  const unlocked = getSessionPassphrase() ?? '';
  const effective = passphrase || unlocked;
  if (!effective) {
    res.status(400).json({
      code: 'PASSPHRASE_REQUIRED',
      msg: 'Unlock the sync passphrase before running the directory mirror.',
      data: {},
    });
    return;
  }

  try {
    const mirrorModule = await import('../../cloud/gdriveFullMirror');
    const result = await mirrorModule.uploadMirrorArchive(effective, null, siteStateOnly);
    res.json({
      code: 0,
      msg: 'success',
      data: { bytes: result.bytes, fileCount: result.fileCount, skipped: result.skipped },
      bytes: result.bytes,
    });
  } catch (err: unknown) {
    res.status(500).json({
      code: 500,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
});


/** Save operator's OAuth client credentials (stored in DPAPI secret store) */
router.post('/api/v1/cloud/gdrive/credentials', (req: Request, res: Response) => {
  const { clientId, clientSecret } = req.body || {};
  try {
    saveGDriveCredentials({ clientId, clientSecret });
    res.json({
      code: 0,
      msg: 'Credentials saved securely',
      data: getGDriveStatus(),
    });
  } catch (err) {
    res.status(400).json({
      code: 400,
      msg: (err as Error).message,
    });
  }
});

/** Initiate Device Code flow for authorization */
router.post('/api/v1/cloud/gdrive/auth/device-code', async (_req: Request, res: Response) => {
  const status = getGDriveStatus();
  if (!status.configured) {
    res.status(400).json({
      code: 400,
      msg: 'Google OAuth Client ID must be configured first',
    });
    return;
  }

  const { getGDriveCredentials } = await import('../../cloud/gdriveAuth');
  const creds = getGDriveCredentials();
  if (!creds) {
    res.status(400).json({ code: 400, msg: 'No credentials found' });
    return;
  }

  try {
    const transport = getOAuthTransport();
    const deviceResp = await transport.requestDeviceCode(creds.clientId, GDRIVE_REQUIRED_SCOPE);
    res.json({
      code: 0,
      msg: 'success',
      data: {
        userCode: deviceResp.user_code,
        verificationUrl: deviceResp.verification_url,
        deviceCode: deviceResp.device_code,
        expiresIn: deviceResp.expires_in,
        interval: deviceResp.interval,
      },
    });
  } catch (err) {
    res.status(500).json({
      code: 500,
      msg: (err as Error).message,
    });
  }
});

/** Poll Device Code flow */
router.post('/api/v1/cloud/gdrive/auth/poll', async (req: Request, res: Response) => {
  const { deviceCode } = req.body || {};
  if (!deviceCode) {
    res.status(400).json({ code: 400, msg: 'deviceCode is required' });
    return;
  }

  const { getGDriveCredentials } = await import('../../cloud/gdriveAuth');
  const creds = getGDriveCredentials();
  if (!creds) {
    res.status(400).json({ code: 400, msg: 'Credentials not configured' });
    return;
  }

  try {
    const transport = getOAuthTransport();
    const result = await transport.pollDeviceToken(creds.clientId, creds.clientSecret, deviceCode);
    if (result.status === 'pending' || result.status === 'slow_down') {
      res.json({ code: 0, msg: result.status, data: { status: result.status } });
      return;
    }

    if (result.status === 'success' && result.data) {
      const finalInfo = await finalizeTokenExchange(result.data);
      const pending = getPendingPassphrase();
      if (pending) {
        await unlockSession(pending);
        clearPendingPassphrase();
      }
      res.json({
        code: 0,
        msg: 'Connected successfully',
        data: {
          status: 'success',
          email: finalInfo.email,
          gdriveStatus: getGDriveStatus(),
        },
      });
      return;
    }

    res.status(400).json({ code: 400, msg: 'Polling failed' });
  } catch (err) {
    res.status(400).json({
      code: 400,
      msg: (err as Error).message,
    });
  }
});

/** Disconnect GDrive (clears refresh token) */
router.post('/api/v1/cloud/gdrive/disconnect', (_req: Request, res: Response) => {
  disconnectGDrive();
  clearSyncSession();
  res.json({
    code: 0,
    msg: 'Disconnected from Google Drive',
    data: getGDriveStatus(),
  });
});

/** Push profiles, scripts, and settings to Google Drive */
router.post('/api/v1/cloud/gdrive/push', async (_req: Request, res: Response) => {
  const status = getGDriveStatus();
  if (!status.connected) {
    res.status(400).json({ code: 400, msg: 'Not connected to Google Drive' });
    return;
  }

  try {
    const result = await pushToGDrive();
    res.json({
      code: 0,
      msg: 'Pushed to Google Drive successfully',
      data: result,
    });
  } catch (err) {
    res.status(500).json({
      code: 500,
      msg: (err as Error).message,
    });
  }
});

/** Inspect remote Drive state without pulling */
router.get('/api/v1/cloud/gdrive/inspect-pull', async (_req: Request, res: Response) => {
  const status = getGDriveStatus();
  if (!status.connected) {
    res.status(400).json({ code: 400, msg: 'Not connected to Google Drive' });
    return;
  }

  try {
    const inspection = await inspectGDrivePull();
    res.json({
      code: 0,
      msg: 'success',
      data: inspection,
    });
  } catch (err) {
    res.status(500).json({
      code: 500,
      msg: (err as Error).message,
    });
  }
});

/** Pull profiles, scripts, and settings from Google Drive */
router.post('/api/v1/cloud/gdrive/pull', async (req: Request, res: Response) => {
  const status = getGDriveStatus();
  if (!status.connected) {
    res.status(400).json({ code: 400, msg: 'Not connected to Google Drive' });
    return;
  }

  const { conflictResolution } = (req.body || {}) as { conflictResolution?: ConflictResolution };
  try {
    const result = await pullFromGDrive({ conflictResolution });
    res.json({
      code: 0,
      msg: 'Pulled from Google Drive successfully',
      data: result,
    });
  } catch (err) {
    res.status(400).json({
      code: 400,
      msg: (err as Error).message,
    });
  }
});

// ============================================================================
// Two-way sync: log, verification, passphrase rotation, mirror restore
// ============================================================================

/** Recent sync runs, newest first. Diagnostics for "why is my sync not working". */
router.get('/api/v1/cloud/gdrive/log', (_req: Request, res: Response) => {
  res.json({ code: 0, msg: 'success', data: { entries: getSyncLog(100) } });
});

const passphraseChangeSchema = z.object({
  current: z.string().min(1, 'The current passphrase is required'),
  next: z
    .string()
    .min(SYNC_PASSPHRASE_MIN_LENGTH, `Passphrase must be at least ${SYNC_PASSPHRASE_MIN_LENGTH} characters`),
});

/**
 * Rotate the sync passphrase.
 *
 * The current one is verified first: anyone who can reach this page could otherwise take the Drive
 * folder over simply by naming a new key.
 */
router.post('/api/v1/cloud/gdrive/passphrase', async (req: Request, res: Response) => {
  const parsed = passphraseChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 400, msg: parsed.error.errors[0]?.message || 'Invalid passphrase' });
    return;
  }
  const { current, next } = parsed.data;
  const result = await changePassphrase(current, next);
  if (!result.changed) {
    res.status(400).json({ code: 400, msg: result.reason || 'Passphrase was not changed' });
    return;
  }
  res.json({ code: 0, msg: 'Passphrase changed', data: { changed: true } });
});

/** Re-download the committed revision and check its digest against the manifest. */
router.post('/api/v1/cloud/gdrive/verify', async (_req: Request, res: Response) => {
  const result = await verifyRemoteState();
  res.status(result.ok ? 200 : 400).json({
    code: result.ok ? 0 : 400,
    msg: result.ok ? 'Remote state verified' : result.reason,
    data: { ok: result.ok, revision: result.revision, reason: result.reason },
  });
});

/** Restore the opt-in profile-directory mirror from Drive. */
router.post('/api/v1/cloud/gdrive/mirror/pull', async (_req: Request, res: Response) => {
  try {
    const result = await pullMirrorNow();
    res.json({ code: 0, msg: 'Mirror restored', data: result });
  } catch (err) {
    res.status(400).json({ code: 400, msg: (err as Error).message });
  }
});
export default router;
