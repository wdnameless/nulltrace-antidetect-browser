/**
 * Desktop OAuth: authorization code + PKCE over a loopback redirect.
 *
 * This is the flow Google recommends for a desktop application, and the reason it is the right one
 * here is that it needs NO shipped secret. The device-code flow the app used before requires a
 * `client_secret` on every token call, which for a distributed binary means either publishing the
 * secret or failing every login — and a "TVs and Limited Input devices" client cannot use any other
 * flow at all (Google rejects loopback for that client type explicitly). PKCE replaces the secret
 * with a per-attempt key pair the client generates and never transmits: the challenge goes out with
 * the authorization request, the verifier only reaches Google in the exchange, so an intercepted
 * code is useless without it.
 *
 * The redirect lands on `http://127.0.0.1:<ephemeral port>`, which Google accepts for Desktop
 * clients on any port — there is nothing to register per installation, which is what makes the
 * one-button experience possible.
 *
 * Two properties are load-bearing:
 *
 * 1. **`state` is verified before the code is touched.** The loopback port is open to any process on
 *    the machine, so anything that can guess it could deliver a code. An OAuth client that accepts
 *    the first code it sees on its callback is trivially hijacked; here a mismatched `state` is
 *    dropped, the listener keeps waiting, and only the request carrying the value this run generated
 *    can complete the flow.
 *
 * 2. **The listener binds to 127.0.0.1 only.** Binding to 0.0.0.0 would expose the callback to the
 *    local network, and the authorization code is a bearer credential for the operator's Drive.
 */

import { createServer, type Server } from 'http';
import { randomBytes, createHash } from 'crypto';
import { AddressInfo } from 'net';

/** Where Google sends the operator to approve the request. */
const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * A PKCE verifier and its challenge.
 *
 * 32 random bytes base64url-encoded is 43 characters, the minimum RFC 7636 allows, and the whole
 * point is that it is unguessable — a short or predictable verifier reduces PKCE to decoration.
 */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface LoopbackAuthorization {
  /** The URL to open in the operator's browser. */
  url: string;
  /** Resolves with the authorization code once Google redirects back. */
  code: Promise<string>;
  /**
   * The PKCE verifier for this attempt.
   *
   * Never transmitted in the authorization request — only in the token exchange, which is what makes
   * an intercepted code useless to anyone else.
   */
  verifier: string;
  /** Releases the port and rejects `code`. Safe to call after completion. */
  cancel: (reason?: string) => void;
  /** The redirect URI used, needed verbatim in the token exchange. */
  redirectUri: string;
}

export class OAuthLoopbackError extends Error {
  constructor(
    message: string,
    public readonly code: 'CANCELLED' | 'TIMEOUT' | 'DENIED' | 'PORT' | 'STATE' | 'CLIENT_TYPE',
    /** What the operator should do about it, when there is something actionable. */
    public readonly userActionableMessage?: string
  ) {
    super(message);
    this.name = 'OAuthLoopbackError';
  }
}

/** How long the operator has to finish in the browser before the attempt is abandoned. */
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Ask Google whether this client may use a loopback redirect at all.
 *
 * Without this, a client of the wrong TYPE fails in the worst possible way: the browser opens, the
 * operator sees a Google error page with nothing they can act on, and this process then waits for a
 * callback that will never arrive until the five-minute timeout expires. The type is discoverable up
 * front — Google answers a deliberately incomplete authorization request with the client's own type
 * named in the error — so the flow can refuse before opening anything.
 *
 * Only a client-type rejection is fatal. Every other outcome (offline, DNS failure, an unexpected
 * error shape) falls through: a preflight that cannot reach Google must never be the reason a login
 * that would have worked does not happen.
 */
async function assertClientSupportsLoopback(clientId: string): Promise<void> {
  const url = `${AUTHORIZATION_ENDPOINT}?${new URLSearchParams({
    client_id: clientId,
    // Deliberately a port this app does not own: the request is never completed, it only needs an
    // answer that names the client type.
    redirect_uri: 'http://127.0.0.1:1',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
  }).toString()}`;

  /*
   * The preflight is advisory, never a gate: a stalled TLS handshake on a captive portal must not
   * hang the connect button. Eight seconds is an eternity for a header-only answer and cheap enough
   * that a timeout simply means "proceed without the verdict".
   */
  let location: string | null = null;
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    location = res.headers.get('location');
  } catch {
    return;
  }
  if (!location) return;

  const match = /authError=([^&]+)/.exec(location);
  if (!match) return;

  let decoded = '';
  try {
    decoded = Buffer.from(decodeURIComponent(match[1]), 'base64url').toString('utf8');
  } catch {
    return;
  }

  if (/NATIVE_DEVICE|TVs and Limited Input/i.test(decoded)) {
    throw new OAuthLoopbackError(
      'this OAuth client cannot use a browser redirect',
      'CLIENT_TYPE',
      'Your Google OAuth client is a "TVs and Limited Input devices" client, and Google only allows ' +
        'that type to use the device-code flow. Create a client of type "Desktop app" in Google Cloud ' +
        'Console and use its Client ID: a Desktop client needs no secret, and it is the type that ' +
        'opens a consent window in the browser.'
    );
  }
}

/**
 * Start a loopback listener and build the authorization URL for it.
 *
 * Resolves once the server is listening, so the caller can open the browser knowing the callback is
 * already accepting — opening first and listening after loses the redirect when the operator
 * approves quickly, which is common when the account is already signed in.
 */
export async function beginLoopbackAuthorization(args: {
  clientId: string;
  scope: string;
  /** Injected for tests; defaults to a real listener on an ephemeral port. */
  createListener?: () => Server;
  /**
   * Set by tests that exercise the loopback mechanics rather than the preflight: the check reaches
   * out to Google, and a unit test must never depend on the network. Production calls always leave
   * this off.
   */
  skipPreflight?: boolean;
}): Promise<LoopbackAuthorization> {
  // Before a port is bound or a browser is opened: a wrong client TYPE must be refused here, where the
  // operator can still be told something actionable, rather than after they have stared at a Google
  // error page for five minutes.
  if (!args.skipPreflight) {
    await assertClientSupportsLoopback(args.clientId);
  }

  const state = randomBytes(16).toString('base64url');
  const { verifier, challenge } = createPkcePair();

  const server = args.createListener ? args.createListener() : createServer();

  let settled = false;
  const { promise: code, resolve: resolveCode, reject: rejectCode } = Promise.withResolvers<string>();
  /*
   * A rejection nobody is listening for kills the process.
   *
   * The route that starts this flow answers the renderer immediately and the browser callback arrives
   * up to five minutes later, so by the time the operator cancels — or the attempt times out, or
   * Google reports a denial — the only thing holding `code` may be this closure. Node treats a
   * rejection with no handler as fatal, which would turn "operator closed the dialog" into a crash.
   *
   * This observer marks the rejection as handled. Awaiters still see it: attaching a catch to a
   * promise creates a derived promise and leaves the original rejecting for everyone else.
   */
  code.catch(() => {});

  const cleanup = (): void => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
    // `close` stops new connections but does not drop a keep-alive socket, and a lingering socket
    // would hold the port until the process exits.
    server.closeAllConnections?.();
  };

  const finishWithError = (err: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectCode(err);
  };

  server.on('request', (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }

    // A browser asks for /favicon.ico unprompted; answering it with the "waiting" page would leave
    // a stray tab open and, worse, could be mistaken for the callback in a log.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    const returnedState = url.searchParams.get('state');
    if (returnedState !== state) {
      /*
       * Not ours. Anything on the machine can reach this port, so a code delivered without the state
       * this run generated is discarded and the listener keeps waiting rather than completing a
       * login for whoever sent it.
       */
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('This authorization response did not come from the request this app made.');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('Authorization was not granted', String(url.searchParams.get('error_description') ?? error)));
      finishWithError(new OAuthLoopbackError(`authorization denied: ${error}`, 'DENIED'));
      return;
    }

    const returned = url.searchParams.get('code');
    if (!returned) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No authorization code in the response.');
      return;
    }

    if (settled) {
      // A second delivery of the same code: acknowledge it and change nothing.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(resultPage('Already connected', 'You can close this tab.'));
      return;
    }

    settled = true;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(resultPage('Connected', 'You can close this tab and return to the app.'));
    cleanup();
    resolveCode(returned);
  });

  const timeout = setTimeout(() => {
    finishWithError(new OAuthLoopbackError('timed out waiting for authorization', 'TIMEOUT'));
  }, AUTHORIZATION_TIMEOUT_MS);
  timeout.unref?.();

  const { promise: listening, resolve: onListening, reject: onListenError } =
    Promise.withResolvers<void>();
  server.once('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(timeout);
    onListenError(
      new OAuthLoopbackError(
        `could not open a local callback port: ${err.code ?? err.message}`,
        'PORT'
      )
    );
  });
  server.listen(0, '127.0.0.1', onListening);

  await listening;

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    clearTimeout(timeout);
    finishWithError(new OAuthLoopbackError('callback listener has no port', 'PORT'));
    throw new OAuthLoopbackError('callback listener has no port', 'PORT');
  }

  const redirectUri = `http://127.0.0.1:${address.port}`;
  // Assembled with URLSearchParams rather than `new URL`: the endpoint is a fixed constant, and
  // `new URL` exists to parse input that might be malformed. Parsing a literal we control only
  // creates a throw site that cannot fire.
  const url = `${AUTHORIZATION_ENDPOINT}?${new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: args.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // Without these Google returns no refresh token on a repeat authorization, and a second connect
    // on a machine would produce a session that dies when the access token expires.
    access_type: 'offline',
    prompt: 'consent',
  }).toString()}`;

  return {
    url,
    code,
    verifier,
    redirectUri,
    cancel: (reason = 'cancelled') => {
      clearTimeout(timeout);
      finishWithError(new OAuthLoopbackError(reason, 'CANCELLED'));
    },
  };
}

/** The page the operator sees in the browser tab. Self-contained: no external assets, no scripts. */
function resultPage(title: string, detail: string): string {
  const htmlEscape = (s: string): string =>
    s.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#111; color:#eee;
         font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif }
  main { max-width:32rem; padding:2rem 2.5rem; text-align:center }
  h1 { margin:0 0 .5rem; font-size:1.25rem; font-weight:600 }
  p { margin:0; color:#9aa }
</style></head>
<body><main><h1>${htmlEscape(title)}</h1><p>${htmlEscape(detail)}</p></main></body></html>`;
}