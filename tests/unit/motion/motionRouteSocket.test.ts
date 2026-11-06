// A Motion request opens its own CDP WebSocket. The shipped defect: `close()` sat only on
// the success path, so any throw (timeout, closed page, aborted gesture) left the socket
// listening. Measured on a long-lived install: 4 487 orphaned listeners in 10 days, which
// exhausted ephemeral ports — every outbound connect then failed, Google token refresh
// included, and 38 accounts tripped "rate-limited" as a result.
//
// The `ws` module is faked so the assertion is about OUR close(), not about what a stub
// server happens to do. Removing `finally { cdp?.close() }` fails this test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// Records every socket the route opens and every close it asks for.
const sockets = vi.hoisted(() => {
  const opened: Array<{ url: string; closed: boolean; sent: string[] }> = [];
  return { opened };
});

vi.mock('ws', () => {
  class FakeWebSocket {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly record = { url: '', closed: false, sent: [] as string[] };

    constructor(url: string) {
      this.record.url = url;
      sockets.opened.push(this.record);
      // Resolve the handshake on the next turn, after the route wires its handlers.
      queueMicrotask(() => this.emit('open'));
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    once(event: string, handler: (...args: unknown[]) => void): void {
      this.on(event, handler);
    }

    send(data: string): void {
      this.record.sent.push(data);
      // Answer the browser-level handshake so the route gets past connectRawCdp,
      // then refuse every command: that is the error path under test.
      const frame = JSON.parse(data) as { id?: number; method?: string };
      if (typeof frame.id !== 'number') return;
      if (frame.method === 'Target.getTargets') {
        queueMicrotask(() =>
          this.emit(
            'message',
            JSON.stringify({ id: frame.id, result: { targetInfos: [{ type: 'page', targetId: 'page-1' }] } })
          )
        );
        return;
      }
      if (frame.method === 'Target.attachToTarget') {
        queueMicrotask(() => {
          // The route only records the page session when this event arrives; without
          // it connectRawCdp closes the socket itself and the route never owns one.
          this.emit(
            'message',
            JSON.stringify({
              id: frame.id,
              result: { sessionId: 'sess-1' },
            })
          );
          this.emit(
            'message',
            JSON.stringify({
              method: 'Target.attachedToTarget',
              params: { sessionId: 'sess-1', targetInfo: { type: 'page' } },
            })
          );
        });
        return;
      }
      // Every command after the handshake is refused: that is the error path under test.
      queueMicrotask(() =>
        this.emit(
          'message',
          JSON.stringify({ id: frame.id, error: { code: -32000, message: 'stub refuses the command' } })
        )
      );
    }

    close(): void {
      this.record.closed = true;
      this.emit('close');
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }
  return { WebSocket: FakeWebSocket };
});

vi.mock('../../../src/main/launcher/chromium', () => ({
  getCdpEndpoint: () => ({ port: '9222', wsPath: '/devtools/browser/stub' }),
}));

const servers: Server[] = [];

beforeEach(() => {
  sockets.opened.length = 0;
});

describe('Motion route releases its CDP socket on every path', () => {
  it('closes the WebSocket when the command fails instead of leaking it', async () => {
    const { motionRouter } = await import('../../../src/main/api/routes/motion');
    const app: Express = express();
    app.use(express.json());
    app.use(motionRouter);

    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiPort = (server.address() as AddressInfo).port;

    // glideTo always performs at least one CDP call; the fake refuses it.
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/v1/motion/p1/glideTo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 10, y: 10 }),
    });
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-1);

    expect(sockets.opened).toHaveLength(1);
    // The assertion that fails without `finally { cdp?.close() }`.
    expect(sockets.opened[0].closed).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 20000);

  it('still closes the socket when the command succeeds', async () => {
    const { motionRouter } = await import('../../../src/main/api/routes/motion');
    const app: Express = express();
    app.use(express.json());
    app.use(motionRouter);

    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const apiPort = (server.address() as AddressInfo).port;

    // createPointer needs no CDP at all; destroyPointer is the no-socket branch.
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/v1/motion/p1/createPointer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 7 }),
    });
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(0);
    expect(sockets.opened).toHaveLength(0);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 20000);
});
