/**
 * Opening external URLs from the renderer.
 *
 * Every external link in the app goes through here rather than calling `window.open` at the call
 * site, for three reasons that were all real defects before:
 *
 * 1. **A Tauri webview ignores `target="_blank"` and `window.open`.** The app's bridge exposes
 *    `openExternal` (`src-tauri/src/bridge.js`), which routes through the system handler; a plain
 *    `window.open` silently does nothing, which is exactly how the Docs button appeared broken.
 * 2. **The destination is checked against an allowlist.** A scheme check alone still lets an
 *    attacker-controlled host through; requiring a trusted host means a future call site cannot
 *    turn an in-app control into a redirect to somewhere hostile.
 * 3. **One chokepoint.** The check lives here, so it cannot be bypassed by a call site that forgets
 *    it — and every caller passes a literal rather than user input.
 */

/**
 * Hosts this app is allowed to open externally.
 *
 * Deliberately a short, explicit list rather than a pattern: `*.github.com` would cover this
 * repository, but it would also cover every other repository on GitHub, so the exact host is
 * pinned. Add an entry here when a new vendor host is genuinely needed.
 */
const TRUSTED_HOSTS: readonly string[] = [
  'github.com',
  'www.nulltrace.app',
  'nulltrace.app',
  'nulltrace.website',
  'www.nulltrace.website',
];

/** The repository slug, written once so a rename cannot leave a stale URL behind. */
const REPO_SLUG = 'wdnameless/nulltrace-antidetect-browser';

/** Where the Pro upgrade leads. Operator: replace with your storefront or checkout URL. */
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
export const PRO_STORE_URL = `${REPO_URL}/discussions`;
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;

/**
 * The privacy policy behind the in-product "Learn more" link. Must stay byte-identical to the
 * URL on the OAuth consent screen — Google's brand verification rejects a mismatch.
 */
export const PRIVACY_POLICY_URL = 'https://nulltrace.website/privacy.html';

/**
 * True when `url` is an `https` URL on a trusted host.
 *
 * Exported so a caller can decide not to render a control at all, rather than rendering one that
 * silently does nothing when clicked.
 */
export function isTrustedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && TRUSTED_HOSTS.includes(parsed.hostname);
  } catch {
    // A relative path or malformed string is not an external URL.
    return false;
  }
}

/**
 * Open an external URL, or do nothing if it is not a trusted destination.
 * Returns whether the URL was accepted, so a caller can surface a problem instead of a dead click.
 */
export function openExternalUrl(url: string): boolean {
  if (!isTrustedExternalUrl(url)) return false;

  if (typeof window !== 'undefined' && window.antidetect?.openExternal) {
    void window.antidetect.openExternal(url);
    return true;
  }

  // Browser/dev fallback. The app itself runs in a Tauri webview where the branch above is taken.
  // An anchor click rather than `window.open`: the destination has already been checked against the
  // allowlist above, and an explicit anchor makes the `noopener`/`noreferrer` guarantees part of the
  // markup rather than a string argument a future edit could drop.
  if (typeof document !== 'undefined') {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.click();
    return true;
  }

  return false;
}
