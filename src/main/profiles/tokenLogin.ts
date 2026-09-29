import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer-core';
import { getProfile, updateProfile } from './profileManager';
import {
  mergeCookiesToDb,
  getProfileCookiesPath,
  getProfileOsKey,
  readCookieDb,
  resolveProfileDir,
  CookieRow,
} from '../io/cookieSqlite';
import * as launcher from '../launcher/chromium';

export type SupportedTokenPlatform = 'discord' | 'twitter' | 'telegram' | 'facebook' | 'custom_cookie' | 'custom_local_storage';

export interface TokenLoginRequest {
  user_id: string;
  platform: SupportedTokenPlatform;
  token: string;
  /** For custom_cookie / custom_local_storage */
  domain?: string;
  key?: string;
  autoOpenUrl?: boolean;
}

export interface TokenLoginResult {
  ok: boolean;
  user_id: string;
  platform: string;
  target_url?: string;
  cookies_injected: number;
  message?: string;
}

/**
 * Transforms platform token into cookies or pre-launch configurations.
 */
export function buildCookiesForToken(
  platform: SupportedTokenPlatform,
  token: string,
  domain?: string,
  key?: string
): { cookies: CookieRow[]; startUrl?: string } {
  const cleanToken = token.trim().replace(/^["']|["']$/g, '');
  const now = Math.floor(Date.now() / 1000);
  const oneYearLater = now + 365 * 24 * 3600;

  switch (platform) {
    case 'twitter':
      return {
        startUrl: 'https://x.com/home',
        cookies: [
          {
            name: 'auth_token',
            value: cleanToken,
            domain: '.twitter.com',
            path: '/',
            expires: oneYearLater,
            httpOnly: true,
            secure: true,
            sameSite: 'None',
          },
          {
            name: 'auth_token',
            value: cleanToken,
            domain: '.x.com',
            path: '/',
            expires: oneYearLater,
            httpOnly: true,
            secure: true,
            sameSite: 'None',
          },
        ],
      };

    case 'facebook': {
      // Token may be c_user:xs or full cookies
      const parts = cleanToken.split(';');
      const cookies: CookieRow[] = [];
      for (const p of parts) {
        const [k, v] = p.split('=').map((s) => s.trim());
        if (k && v) {
          cookies.push({
            name: k,
            value: v,
            domain: '.facebook.com',
            path: '/',
            expires: oneYearLater,
            httpOnly: k === 'xs',
            secure: true,
            sameSite: 'None',
          });
        }
      }
      if (cookies.length === 0 && cleanToken.includes(':')) {
        const [c_user, xs] = cleanToken.split(':');
        cookies.push(
          { name: 'c_user', value: c_user.trim(), domain: '.facebook.com', path: '/', expires: oneYearLater, secure: true },
          { name: 'xs', value: xs.trim(), domain: '.facebook.com', path: '/', expires: oneYearLater, httpOnly: true, secure: true }
        );
      }
      return { startUrl: 'https://www.facebook.com/', cookies };
    }

    case 'discord': {
      // Discord uses localStorage token on discord.com, but cookie session can also be primed
      return {
        startUrl: 'https://discord.com/app',
        cookies: [
          {
            name: 'token',
            value: cleanToken,
            domain: '.discord.com',
            path: '/',
            expires: oneYearLater,
            secure: true,
            sameSite: 'Lax',
          },
        ],
      };
    }

    case 'telegram': {
      return {
        startUrl: 'https://web.telegram.org/a/',
        cookies: [
          {
            name: 'tg_auth',
            value: cleanToken,
            domain: '.telegram.org',
            path: '/',
            expires: oneYearLater,
            secure: true,
            sameSite: 'None',
          },
        ],
      };
    }

    case 'custom_cookie': {
      const cookieDomain = domain || '.example.com';
      const cookieName = key || 'session';
      return {
        startUrl: `https://${cookieDomain.replace(/^\./, '')}`,
        cookies: [
          {
            name: cookieName,
            value: cleanToken,
            domain: cookieDomain.startsWith('.') ? cookieDomain : `.${cookieDomain}`,
            path: '/',
            expires: oneYearLater,
            secure: true,
          },
        ],
      };
    }

    case 'custom_local_storage':
    default:
      return { cookies: [] };
  }
}

/**
 * Injects an authentication token into the profile session.
 * Handles both running browsers (via CDP) and closed browsers (via direct SQLite cookies DB).
 */
export async function injectTokenIntoProfile(req: TokenLoginRequest): Promise<TokenLoginResult> {
  const profile = getProfile(req.user_id);
  if (!profile) {
    return { ok: false, user_id: req.user_id, platform: req.platform, cookies_injected: 0, message: 'profile_not_found' };
  }

  const { cookies, startUrl } = buildCookiesForToken(req.platform, req.token, req.domain, req.key);

  let cookiesInjected = 0;

  // 1. If running, use CDP
  if (launcher.isRunning(req.user_id)) {
    const ws = launcher.getRunningWs(req.user_id);
    if (ws) {
      try {
        const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
        const pages = await browser.pages();
        const page = pages[0] || (await browser.newPage());

        if (cookies.length > 0) {
          await page.setCookie(
            ...cookies.map((c) => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              expires: c.expires,
              httpOnly: c.httpOnly,
              secure: c.secure,
            }))
          );
          cookiesInjected = cookies.length;
        }

        // For Discord/Telegram/Custom, also inject token directly into localStorage on the origin
        if (req.platform === 'discord') {
          await page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await page.evaluate((tok: string) => {
            try {
              // SAFETY: evaluate executes inside browser DOM context where window storage APIs exist
              const g = globalThis as unknown as { localStorage: { setItem(k: string, v: string): void }; sessionStorage: { setItem(k: string, v: string): void } };
              g.localStorage.setItem('token', JSON.stringify(tok));
              g.sessionStorage.setItem('token', JSON.stringify(tok));
            } catch (err) {
              console.warn('[tokenLogin] localStorage injection warning:', err);
            }
          }, req.token.trim().replace(/^["']|["']$/g, ''));
        }

        if (startUrl && req.autoOpenUrl !== false) {
          await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }

        browser.disconnect();
      } catch (err) {
        return {
          ok: false,
          user_id: req.user_id,
          platform: req.platform,
          cookies_injected: cookiesInjected,
          message: 'CDP error: ' + (err as Error).message,
        };
      }
    }
  } else {
    // 2. Offline browser: merge cookies into SQLite cookie store
    if (cookies.length > 0) {
      try {
        const profileDir = resolveProfileDir(req.user_id);
        const cookiesPath = getProfileCookiesPath(profileDir);
        const osKey = getProfileOsKey(profileDir);
        let existingBytes: Buffer | null = null;
        if (fs.existsSync(cookiesPath)) {
          existingBytes = fs.readFileSync(cookiesPath);
        }
        const mergedDbBytes = await mergeCookiesToDb(existingBytes, cookies, osKey);
        fs.mkdirSync(path.dirname(cookiesPath), { recursive: true });
        fs.writeFileSync(cookiesPath, mergedDbBytes);

        try {
          const updatedCookies = await readCookieDb(mergedDbBytes, osKey);
          const { getDb } = await import('../db');
          const db = getDb();
          db.prepare('UPDATE profiles SET cookies_json = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(updatedCookies),
            Date.now(),
            req.user_id
          );
        } catch {
          // best-effort cache in sqlite
        }
        cookiesInjected = cookies.length;
      } catch (err) {
        return {
          ok: false,
          user_id: req.user_id,
          platform: req.platform,
          cookies_injected: 0,
          message: 'Failed to write cookies: ' + (err as Error).message,
        };
      }
    }

    // Update start URLs so browser opens to the logged-in destination
    if (startUrl && req.autoOpenUrl !== false) {
      try {
        const existing = profile.start_urls ? JSON.parse(profile.start_urls) : [];
        if (!existing.includes(startUrl)) {
          updateProfile(req.user_id, { start_urls: [startUrl, ...existing] });
        }
      } catch {
        updateProfile(req.user_id, { start_urls: [startUrl] });
      }
    }
  }

  return {
    ok: true,
    user_id: req.user_id,
    platform: req.platform,
    target_url: startUrl,
    cookies_injected: cookiesInjected,
    message: 'Token login injected successfully',
  };
}
