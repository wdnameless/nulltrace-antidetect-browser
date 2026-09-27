import { lookup } from 'dns/promises';
import { isPrivateOrLocal } from './ipInfo';

/**
 * Why this exists
 *
 * Two routes take a URL from the caller and fetch it SERVER-SIDE: `GET /api/v1/catalog/code`
 * (script catalog) and `POST /api/v1/cloud/connect` (remote server). Both validated only the
 * scheme — `/^https?:\/\//i` — so any address the machine can reach was reachable through them.
 *
 * That is not a theoretical SSRF on this product. The same backend serves `GET /ui/key`, which
 * returns the automation API key and whose same-origin guard is skipped when no `Origin` header is
 * sent — and a server-side `fetch` sends none. Measured before this guard existed:
 *
 *   GET /api/v1/catalog/code?url=http://127.0.0.1:50325/ui/key
 *   -> 200, body containing {"key":"e8d2509b-..."}
 *
 * So the SSRF was a credential-disclosure primitive, reachable without knowing the key. The same
 * shape reaches 169.254.169.254 (cloud metadata) and any intranet host.
 */

/** Hosts that never make sense for these features and are refused by name before any DNS work. */
const REFUSED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

export interface UrlPolicyResult {
  ok: boolean;
  /** Operator-facing reason, safe to return to the caller and to log. */
  error?: string;
  /** The parsed URL, present only when `ok`. */
  url?: URL;
}

/**
 * Whether a caller-supplied URL may be dialed by this process.
 *
 * Checks, in order: parseable, http/https only, no embedded credentials, a hostname that is not a
 * refused literal, and — the part a string check cannot do — that EVERY address the name resolves
 * to is public. Resolving is what closes the gap `isPrivateOrLocal` alone leaves: `localhost`,
 * `127.0.0.1.nip.io` and any DNS name pointed at an internal address all pass a textual scan and
 * only fail once resolved.
 *
 * DNS-rebinding is NOT fully solved by checking here: a name can resolve public now and private at
 * dial time. Closing that properly means pinning the resolved IP into the request, which node-fetch
 * does not expose; this guard removes the reachable-address class (loopback, RFC1918, link-local,
 * CGNAT, IPv6 ULA) and leaves the far narrower rebinding window. Recorded as a deliberate ceiling:
 * `ponytail: rebinding window remains; pin the IP when a fetch stack that allows it is adopted.`
 */
export async function assertPublicHttpUrl(raw: string): Promise<UrlPolicyResult> {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'url is required' };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `url scheme '${url.protocol}' is not allowed (http or https only)` };
  }

  // Credentials in the URL would be sent to whatever host answers, and leak into logs.
  if (url.username || url.password) {
    return { ok: false, error: 'url must not embed credentials' };
  }

  // `url.hostname` strips the brackets from an IPv6 literal.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) return { ok: false, error: 'url has no host' };

  if (REFUSED_HOSTNAMES.has(hostname)) {
    return { ok: false, error: `url host '${hostname}' is not a permitted destination` };
  }

  // A bare IP never needs DNS and is judged directly.
  if (isPrivateOrLocal(hostname)) {
    return { ok: false, error: `url host '${hostname}' is a private or local address` };
  }

  // Resolve and judge every answer: a name with one public and one private address is still a path
  // to the private one, and order is not guaranteed.
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    if (!answers.length) {
      return { ok: false, error: `url host '${hostname}' did not resolve` };
    }
    for (const answer of answers) {
      if (isPrivateOrLocal(answer.address)) {
        return {
          ok: false,
          error: `url host '${hostname}' resolves to a private or local address (${answer.address})`,
        };
      }
    }
  } catch {
    return { ok: false, error: `url host '${hostname}' could not be resolved` };
  }

  return { ok: true, url };
}
