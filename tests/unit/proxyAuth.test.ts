import { describe, it, expect } from 'vitest';
import http from 'http';
import puppeteer from 'puppeteer-core';
import { installProxyAuth } from '../../src/main/proxy/proxyAuth';
import { getChromiumPath } from '../../src/main/config';

describe('installProxyAuth CDP authentication', () => {
  it('authenticates initial page and newly opened tabs without HTTP 407 dialog', async () => {
    let authRequestsCount = 0;
    const proxyServer = http.createServer((req, res) => {
      const auth = req.headers['proxy-authorization'];
      if (!auth) {
        res.writeHead(407, {
          'Proxy-Authenticate': 'Basic realm="Test Proxy"',
          'Content-Type': 'text/plain',
        });
        res.end('Proxy Auth Required');
        return;
      }
      authRequestsCount++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Authenticated Successfully');
    });

    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxyServer.address() as any).port;

    const executable = getChromiumPath();
    expect(executable, 'Chromium binary must be available').toBeTruthy();

    const browser = await puppeteer.launch({
      executablePath: executable!,
      headless: true,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        `--proxy-server=http://127.0.0.1:${proxyPort}`,
        '--proxy-bypass-list=<-loopback>',
      ],
    });

    const wsEndpoint = browser.wsEndpoint();
    const cleanup = await installProxyAuth(wsEndpoint, {
      username: 'test_user',
      password: 'test_password',
    });

    try {
      // 1. Initial page authentication
      const initialPages = await browser.pages();
      const p1 = initialPages[0];
      await p1.goto('http://example.com/tab1', { timeout: 8000 });
      const text1 = await p1.evaluate(() => document.body?.innerText || '');
      expect(text1).toContain('Authenticated Successfully');

      // 2. Newly created page (e.g. user clicking "+", startUrls, window.open)
      const p2 = await browser.newPage();
      await p2.goto('http://example.com/tab2', { timeout: 8000 });
      const text2 = await p2.evaluate(() => document.body?.innerText || '');
      expect(text2).toContain('Authenticated Successfully');

      expect(authRequestsCount).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
      await browser.close();
      proxyServer.close();
    }
  });
});
