// Proxy authentication via CDP Fetch domain.
// The fingerprint-chromium kernel's --proxy-server flag does NOT support
// password authentication, so we attach to the browser's CDP endpoint and
// answer auth challenges with Fetch.continueWithAuth.
import puppeteer, { type Target } from 'puppeteer-core';

export interface ProxyCredentials {
  username: string;
  password: string;
}

/**
 * Attach to a running profile browser and install proxy authentication handlers on all
 * current and future page targets.
 *
 * The fingerprint-chromium kernel's `--proxy-server` flag does not accept embedded credentials,
 * so proxy authentication challenges (HTTP 407) must be answered via CDP.
 *
 * Using `page.authenticate()` hooks into Puppeteer's NetworkManager across the target's lifecycle,
 * and registering `targetcreated` ensures newly created tabs, popups and startUrls receive the
 * credentials automatically before the native Chromium HTTP 407 login prompt can trigger.
 */
export async function installProxyAuth(
  wsEndpoint: string,
  credentials: ProxyCredentials
): Promise<() => void> {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });

  const authenticateTarget = async (target: Target) => {
    if (target.type() !== 'page') return;
    try {
      const page = await target.page();
      if (page) {
        await page.authenticate({
          username: credentials.username,
          password: credentials.password,
        }).catch(() => undefined);
      }
    } catch {
      // Target may have closed before attachment
    }
  };

  for (const target of await browser.targets()) {
    await authenticateTarget(target);
  }

  browser.on('targetcreated', (target) => {
    void authenticateTarget(target);
  });

  return () => {
    browser.removeAllListeners('targetcreated');
    try {
      browser.disconnect();
    } catch {
      // Ignore disconnect errors during teardown
    }
  };
}
