// Phase 3 proxy verification:
//  - local HTTP proxy WITH auth (tests CDP Fetch.continueWithAuth)
//  - proxy check via ip-api.com (IP + auto timezone)
//  - profile bound to proxy, browser launched through it
//  - SOCKS5 check via our own socks5 server
// Run: $env:API_PORT="50332"; npx tsx scripts/smoke-proxy.ts
import * as http from 'http';
import puppeteer from 'puppeteer-core';
import { startService } from '../src/main/index';
import { getApiKey, API_HOST, API_PORT } from '../src/main/config';
import { createSocks5Server } from '../src/main/proxy/socks5Server';

const PROXY_USER = 'testuser';
const PROXY_PASS = 'testpass';

function startTestHttpProxy(): Promise<{ server: http.Server; port: number; count: () => number }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    // Stats endpoint is queried directly (no proxy auth) — handle it first.
    if (req.url?.startsWith('/__proxy_stats')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count }));
      return;
    }
    const auth = req.headers['proxy-authorization'] || '';
    const expected = 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    if (auth !== expected) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
      res.end('proxy auth required');
      return;
    }
    count++;
    const target = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    headers.host = target.host;
    const fwd = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (fres) => {
        res.writeHead(fres.statusCode || 502, fres.headers);
        fres.pipe(res);
      }
    );
    fwd.on('error', () => {
      res.writeHead(502);
      res.end('forward failed');
    });
    req.pipe(fwd);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, count: () => count });
    });
    // CONNECT tunnels (pre-launch probe + HTTPS pages) never reach the http
    // request handler — answer them here so the probe and the browser both pass.
    server.on('connect', (req: http.IncomingMessage, socket: import('net').Socket) => {
      if (req.url === '/__proxy_stats') return;
      const auth = req.headers['proxy-authorization'] || '';
      const expected = 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
      if (auth !== expected) {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
        socket.destroy();
        return;
      }
      count++;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  });
}

async function main(): Promise<void> {
  console.log('Starting test HTTP proxy with auth...');
  const testProxy = await startTestHttpProxy();
  console.log('Test proxy on 127.0.0.1:' + testProxy.port);

  await startService();
  const base = `http://${API_HOST}:${API_PORT}`;
  const headers = { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' };

  // 1. Create proxy record (http + auth)
  const created = await fetch(`${base}/api/v1/proxy/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'http',
      host: '127.0.0.1',
      port: testProxy.port,
      username: PROXY_USER,
      password: PROXY_PASS,
    }),
  }).then((r) => r.json());
  const proxyId: string = created?.data?.proxy_id;
  console.log('Proxy created:', proxyId);

  // 2. Check proxy (through ip-api.com) -> IP + auto timezone
  const check = await fetch(`${base}/api/v1/proxy/check`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ proxy_id: proxyId }),
  }).then((r) => r.json());
  console.log('CHECK:', JSON.stringify(check.data));
  if (check?.data?.ok !== true) throw new Error('proxy check failed: ' + JSON.stringify(check.data));

  // 3. Create profile + bind proxy
  const prof = await fetch(`${base}/api/v1/browser-profile/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'proxy-test' }),
  }).then((r) => r.json());
  const profileId: string = prof?.data?.user_id;
  const bind = await fetch(`${base}/api/v1/browser-profile/update`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_id: profileId, proxy_id: proxyId }),
  }).then((r) => r.json());
  console.log('BIND:', JSON.stringify(bind));

  // 4. Start browser through the proxy (CDP Fetch auth installed by launcher)
  const started = await fetch(`${base}/api/v1/browser/start?user_id=${profileId}`, { headers }).then((r) =>
    r.json()
  );
  if (started?.code !== 0) throw new Error('start failed: ' + started?.msg);
  console.log('Browser started, CDP:', started.data.ws.puppeteer);

  const browser = await puppeteer.connect({ browserWSEndpoint: started.data.ws.puppeteer, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());

  // 5. Load ip-api through the proxy (auth challenge handled via CDP Fetch)
  await page.goto('http://ip-api.com/json/?fields=query,status', { waitUntil: 'domcontentloaded' });
  const ipInfo = await page.evaluate(() => document.body.innerText);
  console.log('Browser sees (via proxy):', ipInfo);

  browser.disconnect();
  await fetch(`${base}/api/v1/browser/stop?user_id=${profileId}`, { headers });

  // 6. Query proxy stats DIRECTLY (not through the proxy) to prove the browser's traffic traversed it
  const stats = await fetch(`http://127.0.0.1:${testProxy.port}/__proxy_stats`).then((r) => r.text());
  console.log('Proxy stats (direct query):', stats);

  // 7. SOCKS5 check via our own socks5 server
  const socks = await createSocks5Server();
  const socksCreated = await fetch(`${base}/api/v1/proxy/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'socks5', host: '127.0.0.1', port: socks.port }),
  }).then((r) => r.json());
  const socksCheck = await fetch(`${base}/api/v1/proxy/check`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ proxy_id: socksCreated?.data?.proxy_id }),
  }).then((r) => r.json());
  console.log('SOCKS5 CHECK:', JSON.stringify(socksCheck.data));
  await socks.close();

  const statsParsed = JSON.parse(stats) as { count: number };
  const ipParsed = JSON.parse(ipInfo) as { query?: string; status?: string };

  console.log('\n=== VERDICT ===');
  console.log('proxy check (http+auth):', check.data.ok ? 'PASS' : 'FAIL');
  console.log('timezone auto-detect:', check.data.timezone ? `PASS (${check.data.timezone})` : 'FAIL');
  console.log(
    'browser through proxy (auth via CDP Fetch):',
    statsParsed.count >= 1 ? 'PASS' : 'FAIL',
    `(proxy saw ${statsParsed.count} requests)`
  );
  console.log('browser egress IP:', ipParsed.query, '| status:', ipParsed.status);
  console.log('socks5 check:', socksCheck.data.ok ? 'PASS' : 'FAIL');

  const ok =
    check.data.ok === true &&
    !!check.data.timezone &&
    statsParsed.count >= 1 &&
    ipParsed.status === 'success' &&
    socksCheck.data.ok === true;

  if (ok) {
    testProxy.server.close();
    console.log('\nPROXY PHASE OK');
    process.exit(0);
  } else {
    testProxy.server.close();
    console.log('\nPROXY PHASE INCOMPLETE');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('PROXY TEST FAILED', err);
  process.exit(1);
});
