import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'net';
import * as http from 'http';
import { startAuthedProxyRelay } from '../../../src/main/proxy/authedRelay';

// Regression: profile p_488f1d93 (lime.proxyhub.team:8080) showed the native
// "proxy needs username/password" dialog despite stored credentials.
// Root cause: Chromium's --proxy-server never sends credentials; the CDP
// Fetch.continueWithAuth answer only works on a page session that does not
// exist at first navigation. The relay holds creds on the wire instead, so
// the browser never sees a 407 — on ANY page, at ANY time.
describe('authedRelay: creds-holding loopback relay', () => {
  const UP_USER = 'relay-user-country-us-01';
  const UP_PASS = 'p@ss:w/ith#specials';

  let upstream: http.Server;
  let upstreamPort = 0;
  let authedHits = 0;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      // Node http server already strips the absolute-URI to origin-form, but be
      // explicit: match the path suffix so the test does not depend on that.
      if (req.url === '/plain' || req.url?.endsWith('/plain')) {
        const auth = req.headers['proxy-authorization'] || '';
        const expected = 'Basic ' + Buffer.from(`${UP_USER}:${UP_PASS}`).toString('base64');
        if (auth !== expected) {
          res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="up"' });
          res.end('proxy auth required');
          return;
        }
        authedHits++;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('via-upstream');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    upstream.on('connect', (req: http.IncomingMessage, socket: net.Socket) => {
      const auth = req.headers['proxy-authorization'] || '';
      const expected = 'Basic ' + Buffer.from(`${UP_USER}:${UP_PASS}`).toString('base64');
      if (auth !== expected) {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="up"\r\n\r\n');
        socket.destroy();
        return;
      }
      authedHits++;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Stub tunnel: close after handshake (enough to prove auth passed).
      socket.destroy();
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it('proxies plain HTTP through upstream with stored creds (no 407 to the client)', async () => {
    const relay = await startAuthedProxyRelay(`http://127.0.0.1:${upstreamPort}`, {
      username: UP_USER,
      password: UP_PASS,
    });
    try {
      expect(relay.proxyServer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Raw socket, not fetch: fetch speaks origin-form to a proxy port and the
      // relay only accepts absolute-URI proxy requests (what Chromium sends).
      const sock = net.connect({ host: '127.0.0.1', port: relay.port });
      await new Promise<void>((res, rej) => {
        sock.once('connect', () => res());
        sock.once('error', (e) => rej(e));
      });
      const body: string = await new Promise((resolve, reject) => {
        let buf = '';
        sock.on('data', (c: Buffer) => {
          buf += c.toString('latin1');
          if (buf.includes('via-upstream')) resolve(buf);
        });
        sock.on('error', (e) => reject(e));
        sock.write(
          `GET http://127.0.0.1:${upstreamPort}/plain HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`
        );
      });
      expect(body).toContain('200');
      expect(body).toContain('via-upstream');
      expect(authedHits).toBeGreaterThan(0);
      sock.destroy();
    } finally {
      relay.stop();
    }
  });

  it('answers CONNECT tunnels with 200 after upstream auth (special chars intact)', async () => {
    const relay = await startAuthedProxyRelay(`http://127.0.0.1:${upstreamPort}`, {
      username: UP_USER,
      password: UP_PASS,
    });
    try {
      const sock = net.connect({ host: '127.0.0.1', port: relay.port });
      await new Promise<void>((res, rej) => {
        sock.once('connect', () => res());
        sock.once('error', (e) => rej(e));
      });
      const head: string = await new Promise((resolve, reject) => {
        let buf = '';
        sock.on('data', (c: Buffer) => {
          buf += c.toString('latin1');
          if (buf.includes('\r\n\r\n')) resolve(buf);
        });
        sock.on('error', (e) => reject(e));
        sock.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`);
      });
      expect(head.split('\r\n')[0]).toContain('200');
      sock.destroy();
    } finally {
      relay.stop();
    }
  });

  it('wrong stored creds surface as 407, never as silent direct', async () => {
    const relay = await startAuthedProxyRelay(`http://127.0.0.1:${upstreamPort}`, {
      username: UP_USER,
      password: 'wrong-pass',
    });
    try {
      const sock = net.connect({ host: '127.0.0.1', port: relay.port });
      await new Promise<void>((res, rej) => {
        sock.once('connect', () => res());
        sock.once('error', (e) => rej(e));
      });
      const head: string = await new Promise((resolve, reject) => {
        let buf = '';
        sock.on('data', (c: Buffer) => {
          buf += c.toString('latin1');
          if (buf.includes('\r\n\r\n')) resolve(buf);
        });
        sock.on('error', (e) => reject(e));
        sock.write(
          `GET http://127.0.0.1:${upstreamPort}/plain HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nConnection: close\r\n\r\n`
        );
      });
      expect(head.split('\r\n')[0]).toContain('407');
      sock.destroy();
    } finally {
      relay.stop();
    }
  });

  it('stop() is idempotent and the relay keeps the upstream scheme', async () => {
    const relay = await startAuthedProxyRelay(`socks5://127.0.0.1:${upstreamPort}`, {
      username: UP_USER,
      password: UP_PASS,
    });
    expect(relay.proxyServer).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
    relay.stop();
    relay.stop();
  });

  it('rejects an invalid upstream address instead of binding a dead relay', async () => {
    await expect(startAuthedProxyRelay('::::', { username: 'u', password: 'p' })).rejects.toThrow(
      /invalid upstream proxy address/
    );
  });
});
