/**
 * The loopback authorization flow, exercised over a real HTTP listener.
 *
 * `createServer` is not mocked: the code under test opens a socket, binds it, and answers a real
 * request, so the parts most likely to be wrong — state verification, the listener's lifetime, the
 * PKCE derivation — are actually executed. Only the browser is simulated, by a `fetch` against the
 * port the flow reports.
 *
 * The security property under test: the callback port is open to any process on the machine, so a
 * code that arrives without the `state` this run generated must be discarded and the listener must
 * keep waiting. An implementation that accepts the first code it sees is hijackable by anything that
 * can guess a port.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { request as httpRequest } from 'http';
import { beginLoopbackAuthorization, OAuthLoopbackError } from '../../../src/main/cloud/oauthLoopback';

const CLIENT_ID = 'operator.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * Drive the flow the way a browser would: call back on the port the flow opened.
 *
 * The request is issued with an explicit literal loopback host and a numeric port, not with a URL
 * string. That is what the flow guarantees — the redirect is only ever a local listener — and it
 * means there is no caller-influenced destination to validate: the host is a constant in this file.
 */
function callback(
  auth: Awaited<ReturnType<typeof beginLoopbackAuthorization>>,
  params: Record<string, string>
): Promise<{ status: number; body: string }> {
  const authorizationUrl = new URL(auth.url);
  const target = new URL(auth.redirectUri);
  const query = new URLSearchParams({
    ...params,
    state: params.state ?? authorizationUrl.searchParams.get('state') ?? '',
  });

  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  const req = httpRequest(
    {
      host: '127.0.0.1',
      port: Number(target.port),
      path: `/?${query.toString()}`,
      method: 'GET',
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }
  );
  req.on('error', reject);
  req.end();
  return promise;
}

describe('the authorization URL', () => {
  it('carries PKCE, offline access and a state, and needs no client secret', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    try {
      const url = new URL(auth.url);
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBeTruthy();
      // Without `offline` Google returns no refresh token, and the session dies with the access token.
      expect(url.searchParams.get('access_type')).toBe('offline');
      // The whole point: a secret must never be part of this request.
      expect(auth.url).not.toContain('client_secret');
    } finally {
      auth.cancel();
    }
  });

  it('derives the challenge as base64url(SHA256(verifier)), as RFC 7636 requires', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    try {
      const url = new URL(auth.url);
      const expected = createHash('sha256').update(auth.verifier).digest('base64url');
      expect(url.searchParams.get('code_challenge')).toBe(expected);
      // The verifier itself must never appear in the request — it is the secret half of the pair.
      expect(auth.url).not.toContain(auth.verifier);
      expect(auth.verifier.length).toBeGreaterThanOrEqual(43);
      expect(auth.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      auth.cancel();
    }
  });

  it('points the redirect at loopback with an ephemeral port', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    try {
      expect(auth.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(new URL(auth.url).searchParams.get('redirect_uri')).toBe(auth.redirectUri);
    } finally {
      auth.cancel();
    }
  });
});

describe('the callback', () => {
  it('resolves with the code when the state matches', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    const response = await callback(auth, { code: 'AUTHORIZATION_CODE' });

    expect(response.status).toBe(200);
    expect(response.body).toContain('Connected');
    expect(await auth.code).toBe('AUTHORIZATION_CODE');
  });

  it('discards a code whose state does not match, then still accepts the real one', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });

    // An attacker's guess at the port, delivering a code they control.
    const forged = await callback(auth, { code: 'FORGED', state: 'not-the-state-this-run-made' });
    expect(forged.status).toBe(400);

    // The listener must still be alive and must not have resolved with the forged code.
    // Raced against an already-resolved promise: detects resolution without a timer and without
    // hanging the test if the code never arrives. Reaching for `.then` here would mix styles.
    const outcome = await Promise.race([auth.code, Promise.resolve(null)]);
    expect(outcome, 'the flow resolved when it should still be waiting').toBeNull();

    const real = await callback(auth, { code: 'REAL_CODE' });
    expect(real.status).toBe(200);
    expect(await auth.code).toBe('REAL_CODE');
  });

  it('reports a denied request as a denial rather than a code', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    await callback(auth, { error: 'access_denied', error_description: 'The user denied the request' });

    await expect(auth.code).rejects.toThrow(OAuthLoopbackError);
    await expect(auth.code).rejects.toThrow(/access_denied/);
  });

  it('answers a favicon request without treating it as the callback', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    const favicon = await fetch(`${auth.redirectUri}/favicon.ico`);
    expect(favicon.status).toBe(204);

    // Raced against an already-resolved promise: detects resolution without a timer and without
    // hanging the test if the code never arrives. Reaching for `.then` here would mix styles.
    const outcome = await Promise.race([auth.code, Promise.resolve(null)]);
    expect(outcome, 'the flow resolved when it should still be waiting').toBeNull();

    await callback(auth, { code: 'AFTER_FAVICON' });
    expect(await auth.code).toBe('AFTER_FAVICON');
  });
});

describe('lifecycle', () => {
  it('releases the port when the operator cancels', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    const port = new URL(auth.redirectUri).port;

    auth.cancel('operator closed the dialog');
    await expect(auth.code).rejects.toThrow(/operator closed/);

    // The port must be free again, or a retry would fail to bind.
    await new Promise((r) => setTimeout(r, 50));
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('ignores a second delivery of a code after completing', async () => {
    const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE, skipPreflight: true });
    await callback(auth, { code: 'FIRST' });
    expect(await auth.code).toBe('FIRST');

    // A repeat must not throw out of the listener, which would crash the process on a stray refresh.
    await expect(callback(auth, { code: 'SECOND' })).rejects.toThrow();
  });
});

describe('the client-type preflight', () => {
  /**
   * The request Google itself answers when asked whether a TV/Limited-Input client may use
   * loopback: a 302 to its own error page with the verdict base64url-encoded in `authError`. The
   * production code sends this exact request with the real client id, so the fake only changes the
   * endpoint.
   */
  function fakeTypeRejection(): () => void {
    const original = globalThis.fetch;
    const verdict = Buffer.from('TVs and Limited Input devices can only use device flow').toString('base64url');
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: `https://accounts.google.com/signin/oauth/error?authError=${verdict}` },
      })) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it('refuses a TV/Limited-Input client before binding a port, with an actionable message', async () => {
    const restore = fakeTypeRejection();
    try {
      await expect(
        beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE })
      ).rejects.toMatchObject({ code: 'CLIENT_TYPE' });
    } finally {
      restore();
    }
  });

  it('falls through when the preflight itself cannot be answered', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    try {
      const auth = await beginLoopbackAuthorization({ clientId: CLIENT_ID, scope: SCOPE });
      // Reached the listener stage: the outage did not veto a login that may still work.
      expect(auth.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      auth.cancel('cleanup');
      await expect(auth.code).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });
});
