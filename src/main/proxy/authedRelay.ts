// Local creds-holding proxy relay for desktop Chromium launches.
//
// Root cause it fixes: Chromium's `--proxy-server` NEVER sends proxy credentials
// itself. The old path answered HTTP 407 via CDP `Fetch.continueWithAuth` on a page
// session — but the 407 for the profile's FIRST navigation fires before any page
// target exists (session restore / start_urls / first goto), so nothing answered
// and Chromium showed the native "proxy needs username/password" dialog.
//
// The relay binds 127.0.0.1 on an ephemeral port, speaks the SAME scheme the
// profile's proxy uses (HTTP CONNECT or SOCKS5), and answers the upstream 407 /
// RFC 1929 auth itself with the stored credentials. The browser points at
// `127.0.0.1:<relayPort>` with NO credentials — there is no 407 left for it to
// see, on any page, at any time. Plain (no-auth) proxies bypass the relay
// entirely: same `--proxy-server` flag as before, zero extra hops.
//
// Special characters in credentials are handled at the byte level (Buffer +
// encodeURIComponent for HTTP, length-prefixed fields for SOCKS5), so usernames
// like `user-country-us-...` and passwords with `@:/?#` survive intact.
import * as net from 'net';

export interface RelayCredentials {
  username: string;
  password: string;
}

export interface AuthedProxyRelay {
  /** Loopback `--proxy-server` value the browser must use (no credentials in it). */
  proxyServer: string;
  port: number;
  /** Close the loopback listener. Idempotent. */
  stop: () => void;
}

function parseUpstream(proxyServer: string): { scheme: 'http' | 'socks5'; host: string; port: number } {
  const normalized =
    proxyServer.startsWith('http') || proxyServer.startsWith('socks') ? proxyServer : `http://${proxyServer}`;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`invalid upstream proxy address: ${proxyServer}`);
  }
  if (!url.hostname) throw new Error(`invalid upstream proxy address: ${proxyServer}`);
  const scheme = url.protocol === 'socks5:' ? 'socks5' : 'http';
  return { scheme, host: url.hostname, port: Number(url.port) || (scheme === 'socks5' ? 1080 : 8080) };
}

/**
 * Watchdog reader: buffers socket data until `done(buf)` says the frame is
 * complete. Single place where data/error/close/timeout listeners are managed,
 * so the two frame readers below cannot drift.
 */
function readFrame(
  socket: net.Socket,
  done: (buf: Buffer, text: string) => { complete: boolean; value?: string | Buffer },
  timeoutMs = 15000
): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('upstream auth handshake timed out'));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const r = done(buf, buf.toString('latin1'));
      if (r.complete) {
        cleanup();
        resolve(r.value ?? buf.subarray(0, buf.length));
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('upstream closed the auth handshake'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * Read exactly `n` bytes from a socket, buffering across data events.
 * Rejects on error/close/timeout. Timeout guards a proxy that accepts the
 * connection and then goes silent (measured on residential gateways).
 */
function readExactly(socket: net.Socket, n: number, timeoutMs = 15000): Promise<Buffer> {
  return readFrame(
    socket,
    (buf) => (buf.length >= n ? { complete: true, value: buf.subarray(0, n) } : { complete: false }),
    timeoutMs
  ) as Promise<Buffer>;
}

async function readHttpResponseHead(socket: net.Socket, timeoutMs = 15000): Promise<string> {
  // SAFETY: the `done` callback above always resolves a string for this call shape,
  // so the `Buffer | string` union narrows to string here by construction.
  const head = (await readFrame(
    socket,
    (_buf, text) =>
      text.includes('\r\n\r\n')
        ? { complete: true, value: text.slice(0, text.indexOf('\r\n\r\n')) }
        : { complete: false },
    timeoutMs
  )) as unknown as string;
  return head;
}

/** Open the upstream leg and complete scheme auth. Resolves a CONNECTED socket. */
async function dialUpstream(
  upstream: { scheme: 'http' | 'socks5'; host: string; port: number },
  creds: RelayCredentials,
  targetHost: string,
  targetPort: number
): Promise<net.Socket> {
  const socket = net.connect({ host: upstream.host, port: upstream.port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', (err) => reject(err));
  });
  if (upstream.scheme === 'http') {
    const basic = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
    socket.write(
      [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`, `Proxy-Authorization: Basic ${basic}`, '', ''].join('\r\n')
    );
    const head = await readHttpResponseHead(socket);
    const status = Number(head.split('\r\n')[0]?.split(' ')[1] ?? '0');
    if (status === 407) {
      socket.destroy();
      throw new Error('Proxy Authentication Required (407): stored credentials rejected by upstream');
    }
    if (status < 200 || status >= 300) {
      socket.destroy();
      throw new Error(`HTTP proxy returned status ${status}`);
    }
    return socket;
  }
  // SOCKS5: greeting (no-auth) -> RFC 1929 user/pass -> CONNECT.
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const methodReply = await readExactly(socket, 2);
  if (methodReply[0] !== 0x05) {
    socket.destroy();
    throw new Error('SOCKS5 proxy sent a malformed method reply');
  }
  if (methodReply[1] === 0x02) {
    const user = Buffer.from(creds.username, 'utf8');
    const pass = Buffer.from(creds.password, 'utf8');
    if (user.length > 255 || pass.length > 255) {
      socket.destroy();
      throw new Error('SOCKS5 credentials exceed 255 bytes');
    }
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const authReply = await readExactly(socket, 2);
    if (authReply[1] !== 0x00) {
      socket.destroy();
      throw new Error('Proxy Authentication Required: stored credentials rejected by upstream');
    }
  } else if (methodReply[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 proxy refused auth method (${methodReply[1]})`);
  }
  const hostBuf = Buffer.from(targetHost, 'utf8');
  const req = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
    hostBuf,
    Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
  ]);
  socket.write(req);
  const connReply = await readExactly(socket, 4);
  if (connReply[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 CONNECT failed (${connReply[1]})`);
  }
  // Consume BND.ADDR per ATYP so the stream starts at payload bytes.
  const atyp = connReply[3];
  const rest = atyp === 0x01 ? 6 : atyp === 0x04 ? 18 : atyp === 0x03 ? -1 : 0;
  if (rest === -1) {
    const lenBuf = await readExactly(socket, 1);
    await readExactly(socket, lenBuf[0] + 2);
  } else if (rest > 0) {
    await readExactly(socket, rest);
  }
  return socket;
}

/**
 * Start the loopback relay. The returned `proxyServer` keeps the upstream
 * scheme (`http://127.0.0.1:<port>` or `socks5://127.0.0.1:<port>`) so the
 * caller's probe/flag matrix is unaffected — only the host:port changes.
 */
export async function startAuthedProxyRelay(
  upstreamProxyServer: string,
  creds: RelayCredentials
): Promise<AuthedProxyRelay> {
  const upstream = parseUpstream(upstreamProxyServer);
  const server = net.createServer((client) => {
    if (upstream.scheme === 'http') {
      handleHttpClient(client, upstream, creds);
    } else {
      handleSocksClient(client, upstream, creds);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err) => reject(err));
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error('failed to bind authed proxy relay');
  }
  let stopped = false;
  return {
    proxyServer: `${upstream.scheme}://127.0.0.1:${port}`,
    port,
    stop: () => {
      if (stopped) return;
      stopped = true;
      server.close();
    },
  };
}

/** Splice two live sockets bidirectionally; either error tears both down. */
function spliceSockets(a: net.Socket, b: net.Socket): void {
  a.pipe(b);
  b.pipe(a);
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
}

/** HTTP side: CONNECT tunnels + plain absolute-URI requests, both authed upstream. */
function handleHttpClient(
  client: net.Socket,
  upstream: { scheme: 'http' | 'socks5'; host: string; port: number },
  creds: RelayCredentials
): void {
  const openTunnel = (targetHost: string, targetPort: number): void => {
    if (!targetHost) {
      client.destroy();
      return;
    }
    dialUpstream(upstream, creds, targetHost, targetPort).then(
      (up) => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        spliceSockets(client, up);
      },
      () => {
        // Upstream refused (bad creds / unreachable): answer 407 so the failure
        // is visible as a proxy error, never as a silent direct leak.
        client.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="antidetect"\r\n\r\n');
        client.destroy();
      }
    );
  };
  const forwardPlainHttp = (rawTarget: string, headerBlock: string): void => {
    // Absolute-URI origin-form: fetch the target THROUGH the upstream proxy by
    // re-issuing the client's own request line + headers with Proxy-Authorization
    // injected, then splice the response bytes back. The browser never sees a 407.
    let target: URL;
    try {
      target = new URL(rawTarget);
    } catch {
      client.destroy();
      return;
    }
    const lines = headerBlock.split('\r\n');
    const outLines = [`${lines[0] ?? ''}`];
    let hasAuth = false;
    for (const line of lines.slice(1)) {
      if (!line) {
        outLines.push(line);
        break;
      }
      if (/^proxy-authorization:/i.test(line)) {
        hasAuth = true;
        continue;
      }
      outLines.push(line);
    }
    if (!hasAuth) {
      const basic = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
      outLines.splice(1, 0, `Proxy-Authorization: Basic ${basic}`);
    }
    // The loop breaks AFTER pushing the first empty line, but headerBlock ends with
    // '\r\n\r\n' (TWO empties after split) — join must re-add the final CRLF or the
    // upstream http server waits for headers forever (measured: silent TIMEOUT).
    const head = `${outLines.join('\r\n')}\r\n`;
    const tailIdx = headerBlock.indexOf('\r\n\r\n');
    const tail = tailIdx >= 0 ? Buffer.from(headerBlock.slice(tailIdx + 4), 'latin1') : Buffer.alloc(0);
    const splice = (up: net.Socket): void => {
      if (tail.length > 0) up.write(tail);
      spliceSockets(client, up);
    };
    const up = net.connect({ host: upstream.host, port: upstream.port }, () => {
      if (upstream.scheme === 'socks5') {
        // SOCKS upstream cannot take a raw HTTP request: tunnel via CONNECT-equivalent
        // SOCKS handshake is inside dialUpstream; reuse it by wrapping: open a SOCKS
        // CONNECT to the target then replay the request bytes through it.
        up.destroy();
        dialUpstream(upstream, creds, target.hostname, Number(target.port) || 80).then(
          (tun) => {
            tun.write(head);
            if (tail.length > 0) tun.write(tail);
            spliceSockets(client, tun);
          },
          () => client.destroy()
        );
        return;
      }
      up.write(head);
      // The upstream answers OUR request (with OUR injected creds): a 407 here means
      // the STORED creds are wrong. Translate it to a relay-side 407 so the browser
      // surfaces a proxy error instead of hanging on a dead leg.
      let upBuf = '';
      const onUpData = (chunk: Buffer): void => {
        upBuf += chunk.toString('latin1');
        if (!upBuf.includes('\r\n\r\n')) return;
        up.removeListener('data', onUpData);
        const status = upBuf.split('\r\n')[0] ?? '';
        if (/^HTTP\/1\.[01] 407/.test(status)) {
          up.destroy();
          client.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="antidetect"\r\n\r\n');
          client.destroy();
          return;
        }
        client.write(upBuf);
        splice(up);
      };
      up.on('data', onUpData);
      up.on('error', () => client.destroy());
    });
  };
  let buf = '';
  const onData = (chunk: Buffer): void => {
    buf += chunk.toString('latin1');
    if (!buf.includes('\r\n\r\n')) return;
    client.removeListener('data', onData);
    const [requestLine] = buf.split('\r\n');
    const [method, rawTarget] = (requestLine ?? '').split(' ');
    if (method === 'CONNECT') {
      const target = (rawTarget ?? '').split(':');
      openTunnel(target[0] || '', Number(target[1]) || 443);
      return;
    }
    // Plain HTTP (absolute-URI GET/POST/...): forward the request itself upstream,
    // not a tunnel — dialUpstream only speaks CONNECT/SOCKS handshakes.
    if (!rawTarget || !/^https?:\/\//i.test(rawTarget)) {
      client.destroy();
      return;
    }
    forwardPlainHttp(rawTarget, buf);
  };
  client.on('data', onData);
  client.on('error', () => client.destroy());
}

/** SOCKS5 side: accept no-auth CONNECT, open the authed upstream leg, splice. */
function handleSocksClient(
  client: net.Socket,
  upstream: { scheme: 'http' | 'socks5'; host: string; port: number },
  creds: RelayCredentials
): void {
  client.once('data', (greeting: Buffer) => {
    if (greeting.length < 2 || greeting[0] !== 0x05) {
      client.destroy();
      return;
    }
    client.write(Buffer.from([0x05, 0x00]));
    client.once('data', (request: Buffer) => {
      if (request.length < 7 || request[0] !== 0x05 || request[1] !== 0x01) {
        client.destroy();
        return;
      }
      const atyp = request[3];
      let host = '';
      let port = 0;
      if (atyp === 0x01) {
        if (request.length < 10) {
          client.destroy();
          return;
        }
        host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
        port = request.readUInt16BE(8);
      } else if (atyp === 0x03) {
        const nameLen = request[4];
        if (request.length < 5 + nameLen + 2) {
          client.destroy();
          return;
        }
        host = request.slice(5, 5 + nameLen).toString('utf8');
        port = request.readUInt16BE(5 + nameLen);
      } else if (atyp === 0x04) {
        if (request.length < 22) {
          client.destroy();
          return;
        }
        const parts: string[] = [];
        for (let i = 0; i < 8; i++) parts.push(request.readUInt16BE(4 + i * 2).toString(16));
        host = parts.join(':');
        port = request.readUInt16BE(20);
      } else {
        client.destroy();
        return;
      }
      dialUpstream(upstream, creds, host, port).then(
        (up) => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          spliceSockets(client, up);
        },
        () => client.destroy()
      );
    });
  });
  client.on('error', () => client.destroy());
}
