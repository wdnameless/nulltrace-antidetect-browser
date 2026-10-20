// Cookie injection via page.setCookie (one call per cookie).
import puppeteer from 'puppeteer-core';
import type { CookieData } from 'puppeteer-core';

export interface InjectableCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
}

/**
 * Build setCookie params for one stored cookie, or null when it cannot be set
 * (missing name/domain). A single malformed cookie must never abort the whole
 * session restore — the old code sent every cookie in one Network.setCookies call,
 * so one bad entry failed the batch and the profile arrived logged out silently.
 */
export function toSetCookieParams(cookie: InjectableCookie): CookieData | null {
  const name = typeof cookie.name === 'string' ? cookie.name : '';
  const domain = typeof cookie.domain === 'string' ? cookie.domain : '';
  if (!name || !domain) return null;
  const value = typeof cookie.value === 'string' ? cookie.value : String(cookie.value ?? '');
  // A cookie with an empty value must never be injected — doing so clobbers authenticated sessions in Chromium.
  if (!value || value.trim().length === 0) return null;
  const params: CookieData = { name, value, domain };
  if (typeof cookie.path === 'string' && cookie.path) params.path = cookie.path;
  if (typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.expires > 0) {
    params.expires = Math.floor(cookie.expires);
  }
  if (cookie.httpOnly === true) params.httpOnly = true;
  if (cookie.secure === true) params.secure = true;
  if (typeof cookie.sameSite === 'string') {
    const s = cookie.sameSite.toLowerCase();
    if (s === 'strict' || s === 'lax' || s === 'none') {
      params.sameSite = (s[0].toUpperCase() + s.slice(1)) as CookieData['sameSite'];
    }
  }
  return params;
}

export async function injectCookies(
  wsEndpoint: string,
  cookies: Array<Record<string, unknown>>
): Promise<{ injected: number; skipped: number }> {
  const result = { injected: 0, skipped: 0 };
  if (!cookies.length) return result;
  const validCookies = cookies.filter(
    (c) => c && typeof c.value === 'string' && c.value.trim().length > 0
  );
  if (!validCookies.length) return result;
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  try {
    for (const cookie of validCookies) {
      const params = toSetCookieParams(cookie);
      if (!params) {
        result.skipped++;
        continue;
      }
      try {
        // Browser-level API: the page-level one is deprecated and needs a page handle.
        await browser.setCookie(params);
        result.injected++;
      } catch {
        result.skipped++;
      }
    }
  } finally {
    browser.disconnect();
  }
  return result;
}
