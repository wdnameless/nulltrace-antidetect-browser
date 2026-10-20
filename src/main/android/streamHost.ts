import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { AdbClient } from './adb';
import { ScrcpyParser, type ScrcpyCodecMeta } from './scrcpyProtocol';
import { SCRCPY_SERVER_JAR_NAME, SCRCPY_SERVER_VERSION } from './packageManager';
import { DATA_DIR } from '../config';
import { logger } from '../util/logger';

export class StreamHostError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'StreamHostError';
  }
}

/**
 * Minimal surface streamHost needs, satisfied by A4's instance.
 * Declared here so A2 does not import A4 (instance.ts).
 */
export interface AndroidInstanceLike {
  readonly profileId: string;
  readonly serial: string;
  readonly adb: AdbClient;
  readonly screen: { width: number; height: number };
}

export interface AndroidStreamTicket {
  /** One-shot token; the WS upgrade URL must carry it. */
  ticket: string;
  wsUrl: string; // ws://127.0.0.1:<port>/android/stream?ticket=<t>
  width: number;
  height: number;
  expiresAt: number;
}

interface TicketRecord {
  expiresAt: number;
  consumed: boolean;
}

export interface StreamStartOptions {
  port: number;
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
  scrcpyServerPath?: string;
  /** How long to wait for the guest to open the video socket before failing the launch. */
  connectTimeoutMs?: number;
}

/** The abstract socket name scrcpy-server binds when `scid` is not given (`DesktopConnection`). */
const SCRCPY_SOCKET_NAME = 'scrcpy';

/**
 * Resolves the location of the guest-side scrcpy server jar.
 *
 * The engine installer downloads and digest-verifies this jar into the engine directory
 * (`DATA_DIR/android/scrcpy-server.jar`, see ANDROID_ENGINE_ASSETS), so that managed copy is
 * the canonical one and is searched first. The remaining candidates are operator escape
 * hatches — an explicit path, an env override, or a vendored file — kept so a pinned engine
 * can be swapped out without editing code.
 */
function resolveScrcpyServerPath(customPath?: string): string {
  const candidates: string[] = [];

  if (customPath) {
    candidates.push(customPath);
  }
  if (process.env.SCRCPY_SERVER_PATH) {
    candidates.push(process.env.SCRCPY_SERVER_PATH);
  }

  candidates.push(
    path.join(DATA_DIR, 'android', SCRCPY_SERVER_JAR_NAME),
    path.join(process.cwd(), 'data', 'android', SCRCPY_SERVER_JAR_NAME),
    path.join(process.cwd(), 'vendor', SCRCPY_SERVER_JAR_NAME),
    path.join(process.cwd(), SCRCPY_SERVER_JAR_NAME),
    path.resolve(__dirname, '..', '..', '..', 'vendor', SCRCPY_SERVER_JAR_NAME),
    path.resolve(__dirname, '..', '..', '..', 'data', 'android', SCRCPY_SERVER_JAR_NAME)
  );

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  throw new StreamHostError(
    `scrcpy-server.jar not found. Checked candidate locations:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
    'ERR_ANDROID_SCRCPY_NOT_FOUND'
  );
}

/**
 * Relays an Android emulator screen stream (H.264 / scrcpy) to the frontend canvas
 * over a loopback-bound WebSocket server.
 *
 * Transport, as the pinned server actually implements it (`DesktopConnection.open` +
 * `Server.scrcpy` in scrcpy 2.4):
 * - The server is started with `tunnel_forward=false`, so it DIALS `localabstract:scrcpy`.
 *   `adb reverse` maps that guest socket onto a host listener, which is the direction that
 *   actually carries bytes — `adb forward` + `tunnel_forward=true` never delivers video to
 *   the host (measured on a booted android-34 guest).
 * - The guest opens one connection for video and, with `control=true`, a second one for the
 *   control channel, in that order. First accept = video, second accept = control.
 * - `send_device_meta=false`, so the video stream begins with the 12-byte codec metadata
 *   prefix, exactly as `ScrcpyParser` expects.
 *
 * Security and protocol invariants:
 * - Bind strictly to 127.0.0.1 (never 0.0.0.0).
 * - Upgrades require a valid, unconsumed single-use ticket issued by issueTicket().
 * - Binary WebSocket frames from the guest are forwarded to connected clients untouched.
 * - Client binary frames are scrcpy control messages and are written to the control socket verbatim.
 */
export class AndroidStreamHost {
  private readonly instance: AndroidInstanceLike;
  private _status: 'idle' | 'starting' | 'streaming' | 'error' = 'idle';
  private _port: number = 0;
  private _httpServer: http.Server | null = null;
  private _wss: WebSocketServer | null = null;
  private _bridgeServer: net.Server | null = null;
  private _serverProcess: ChildProcess | null = null;
  private _videoSocket: net.Socket | null = null;
  private _controlSocket: net.Socket | null = null;
  private _reverseActive = false;
  private readonly _tickets = new Map<string, TicketRecord>();
  private readonly _clients = new Set<WebSocket>();
  private readonly _parser = new ScrcpyParser({ expectCodecMeta: true });

  constructor(instance: AndroidInstanceLike) {
    this.instance = instance;
  }

  get status(): 'idle' | 'starting' | 'streaming' | 'error' {
    return this._status;
  }

  get codecMeta(): ScrcpyCodecMeta | null {
    return this._parser.codecMeta;
  }

  /** Issues a one-shot stream ticket valid for 60 seconds. */
  issueTicket(): AndroidStreamTicket {
    const ticket = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 60_000;
    this._tickets.set(ticket, { expiresAt, consumed: false });

    return {
      ticket,
      wsUrl: `ws://127.0.0.1:${this._port}/android/stream?ticket=${ticket}`,
      width: this.instance.screen.width,
      height: this.instance.screen.height,
      expiresAt,
    };
  }

  /**
   * Pushes scrcpy-server.jar, raises the loopback bridge `adb reverse` points at, spawns the
   * guest server, and relays its video/control sockets to WebSocket clients.
   */
  async start(opts: StreamStartOptions): Promise<void> {
    if (this._status === 'starting' || this._status === 'streaming') {
      throw new StreamHostError('Stream host is already running or starting', 'ERR_ANDROID_STREAM_ALREADY_STARTED');
    }

    this._status = 'starting';
    this._port = opts.port;

    try {
      // 1. Resolve and push scrcpy-server.jar
      const jarPath = resolveScrcpyServerPath(opts.scrcpyServerPath);
      logger.info(`[StreamHost] Pushing scrcpy-server.jar to ${this.instance.serial}...`);
      await this.instance.adb.push(jarPath, `/data/local/tmp/${SCRCPY_SERVER_JAR_NAME}`);

      // 2. Loopback bridge the guest will dial through `adb reverse`
      const bridgePort = await this.listenForGuestSockets();

      // 3. Point the guest's abstract socket at that bridge
      await this.instance.adb.reverse(`localabstract:${SCRCPY_SOCKET_NAME}`, bridgePort);
      this._reverseActive = true;

      // 4. Local HTTP + WebSocket server for the renderer (never 0.0.0.0)
      this._httpServer = http.createServer((_req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });

      this._wss = new WebSocketServer({
        noServer: true,
        host: '127.0.0.1',
      });

      this.setupHttpUpgrade();

      const { promise: listenPromise, resolve: resolveListen, reject: rejectListen } = Promise.withResolvers<void>();
      this._httpServer.once('error', (err) => {
        rejectListen(
          new StreamHostError(
            `HTTP server failed to bind on 127.0.0.1:${this._port}: ${err.message}`,
            'ERR_ANDROID_PORT_BIND'
          )
        );
      });
      this._httpServer.listen(this._port, '127.0.0.1', () => {
        resolveListen();
      });
      await listenPromise;

      // 5. Spawn the guest server; it dials the bridge for video then for control
      this.spawnScrcpyServer(opts);
      await this.awaitVideoConnection(opts.connectTimeoutMs ?? 20_000);

      logger.info(`[StreamHost] Android stream host listening on ws://127.0.0.1:${this._port}/android/stream`);
    } catch (err) {
      this._status = 'error';
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Raises the loopback listener `adb reverse` delivers guest connections to, and classifies
   * them the way the server opens them: video first, control second.
   */
  private async listenForGuestSockets(): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>();

    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      if (!this._videoSocket) {
        this._videoSocket = socket;
        socket.on('data', (chunk: Buffer) => {
          this.handleGuestStreamData(chunk);
        });
        socket.on('error', (err) => {
          logger.warn(`[StreamHost] Video socket error: ${err.message}`);
        });
        socket.on('close', () => {
          if (this._status !== 'idle') {
            this._status = 'error';
            this.broadcastStatus({
              type: 'error',
              code: 'ERR_ANDROID_STREAM_CLOSED',
              message: 'The guest closed the video stream',
            });
          }
        });
        return;
      }

      if (!this._controlSocket) {
        this._controlSocket = socket;
        socket.on('error', (err) => {
          logger.warn(`[StreamHost] Control socket error: ${err.message}`);
        });
        return;
      }

      // A third connection is not part of the protocol; close it rather than leak the socket.
      socket.destroy();
    });

    server.once('error', (err) => {
      reject(
        new StreamHostError(
          `Failed to raise the loopback bridge for the guest: ${err.message}`,
          'ERR_ANDROID_BRIDGE_BIND'
        )
      );
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => {
          reject(new StreamHostError('Loopback bridge did not yield a port', 'ERR_ANDROID_BRIDGE_BIND'));
        });
        return;
      }
      this._bridgeServer = server;
      resolve(addr.port);
    });

    return promise;
  }

  /** Resolves once the guest has opened the video socket, or rejects after the deadline. */
  private async awaitVideoConnection(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this._videoSocket) {
      if (Date.now() >= deadline) {
        throw new StreamHostError(
          `scrcpy server did not open the video socket within ${timeoutMs}ms; the guest refused the stream`,
          'ERR_ANDROID_STREAM_TIMEOUT'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Wires HTTP GET upgrade requests for `/android/stream?ticket=<token>`. */
  private setupHttpUpgrade(): void {
    if (!this._httpServer || !this._wss) return;

    this._httpServer.on('upgrade', (req, socket, head) => {
      const parsedUrl = new URL(req.url ?? '', 'http://127.0.0.1');

      if (req.method !== 'GET' || parsedUrl.pathname !== '/android/stream') {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const ticket = parsedUrl.searchParams.get('ticket');
      const record = ticket ? this._tickets.get(ticket) : undefined;
      const isTicketValid = record && !record.consumed && Date.now() <= record.expiresAt;

      if (!isTicketValid) {
        // Upgrade briefly to emit standard text error frame, then close
        this._wss?.handleUpgrade(req, socket, head, (ws) => {
          ws.send(JSON.stringify({ type: 'error', code: 'INVALID_TICKET', message: 'Invalid or expired stream ticket' }));
          ws.close(1008, 'INVALID_TICKET');
        });
        return;
      }

      record.consumed = true;

      this._wss?.handleUpgrade(req, socket, head, (ws) => {
        this.handleClient(ws);
      });
    });
  }

  /**
   * Launches the guest-side server. The argument names are scrcpy 2.4's own `Options.parse`
   * keys — `bit_rate` is not one of them (`video_bit_rate` is), and an unknown key is only
   * warned about, so a typo silently falls back to the default bitrate.
   */
  private spawnScrcpyServer(opts: StreamStartOptions): void {
    const maxSize = opts.maxSize ?? 0;
    const bitRate = opts.bitRate ?? 4_000_000;
    const maxFps = opts.maxFps ?? 60;

    const cmd = [
      `CLASSPATH=/data/local/tmp/${SCRCPY_SERVER_JAR_NAME}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      // Must equal the version of the jar the installer verified — the server refuses to run
      // against a different client version.
      SCRCPY_SERVER_VERSION,
      `max_size=${maxSize}`,
      `video_bit_rate=${bitRate}`,
      `max_fps=${maxFps}`,
      'audio=false',
      // false: the server dials localabstract:scrcpy, which `adb reverse` maps to us.
      'tunnel_forward=false',
      'control=true',
      // We already know the stream is alive once the sockets connect, and a dummy byte would
      // become the first byte of the codec-meta prefix the parser reads.
      'send_dummy_byte=false',
      // The 64-byte device-name field would otherwise precede the codec metadata.
      'send_device_meta=false',
      // Leaving the jar on the guest keeps a relaunch from having to push ~68 KB again.
      'cleanup=false',
    ].join(' ');

    const adbPath = this.instance.adb.adbPath;
    const adbArgs = ['-s', this.instance.serial, 'shell', cmd];

    this._serverProcess = spawn(adbPath, adbArgs, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._serverProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text.length > 0) {
        logger.info(`[StreamHost:scrcpy:stdout] ${text}`);
      }
    });

    this._serverProcess.stderr?.on('data', (errChunk: Buffer) => {
      const text = errChunk.toString('utf-8').trim();
      if (text.length > 0) {
        logger.info(`[StreamHost:scrcpy:stderr] ${text}`);
      }
    });

    this._serverProcess.on('exit', (code, signal) => {
      logger.warn(`[StreamHost] scrcpy server process exited (code=${code}, signal=${signal})`);
      if (this._status === 'starting' || this._status === 'streaming') {
        this._status = 'error';
        this.broadcastStatus({
          type: 'error',
          code: 'ERR_ANDROID_SCRCPY_EXIT',
          message: `scrcpy server exited unexpectedly with code ${code}`,
        });
      }
    });
  }

  /**
   * Processes raw scrcpy video bytes from the guest, tracks the codec metadata, and relays the
   * bytes to connected WebSocket clients untouched.
   */
  private handleGuestStreamData(chunk: Buffer): void {
    if (this._status === 'starting') {
      this._status = 'streaming';
      this.broadcastStatus({ type: 'status', message: 'streaming' });
    }

    try {
      this._parser.feed(chunk);
    } catch (err) {
      logger.warn(`[StreamHost] ScrcpyParser error: ${(err as Error).message}`);
    }

    for (const client of this._clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(chunk, { binary: true });
      }
    }
  }

  /** Manages an active WebSocket client connection. */
  private handleClient(ws: WebSocket): void {
    this._clients.add(ws);

    ws.send(JSON.stringify({ type: 'status', message: this._status }));
    const meta = this._parser.codecMeta;
    if (meta) {
      ws.send(JSON.stringify({ type: 'codec', codecId: meta.codecId, width: meta.width, height: meta.height }));
    }

    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (isBinary && Buffer.isBuffer(data)) {
        // Control messages are already in scrcpy's own format; the guest decodes them.
        this.sendControl(data);
      }
    });

    ws.on('close', () => {
      this._clients.delete(ws);
    });

    ws.on('error', (err) => {
      logger.warn(`[StreamHost] Client WS error: ${err.message}`);
      this._clients.delete(ws);
    });
  }

  /** Broadcasts a text JSON status or error frame to all connected clients. */
  private broadcastStatus(payload: { type: 'status' | 'error'; message: string; code?: string }): void {
    const text = JSON.stringify(payload);
    for (const client of this._clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(text);
      }
    }
  }

  /** Writes a control message to the guest's control channel. */
  sendControl(msg: Buffer): void {
    if (this._controlSocket && !this._controlSocket.destroyed && this._controlSocket.writable) {
      this._controlSocket.write(msg);
    }
  }

  /** Cleanly shuts down the stream host, closing sockets, killing the server process, and removing the reverse mapping. */
  async stop(): Promise<void> {
    if (this._status === 'idle') {
      return;
    }

    this._status = 'idle';
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // 1. Close connected WebSocket clients
    for (const ws of this._clients) {
      try {
        ws.close(1000, 'Stream stopped');
      } catch {
        // Safe ignore
      }
    }
    this._clients.clear();

    // 2. Close WebSocketServer
    if (this._wss) {
      try {
        this._wss.close();
      } catch {
        // Safe ignore
      }
      this._wss = null;
    }

    // 3. Close HTTP server
    if (this._httpServer) {
      try {
        this._httpServer.close();
      } catch {
        // Safe ignore
      }
      this._httpServer = null;
    }

    // 4. Destroy the guest sockets (killing the server closes them on its side too)
    for (const socket of [this._videoSocket, this._controlSocket]) {
      try {
        socket?.destroy();
      } catch {
        // Safe ignore
      }
    }
    this._videoSocket = null;
    this._controlSocket = null;

    // 5. Close the loopback bridge
    if (this._bridgeServer) {
      try {
        this._bridgeServer.close();
      } catch {
        // Safe ignore
      }
      this._bridgeServer = null;
    }

    // 6. Kill server process
    if (this._serverProcess) {
      try {
        this._serverProcess.kill('SIGTERM');
      } catch {
        // Safe ignore
      }
      this._serverProcess = null;
    }

    // 7. Drop the reverse mapping so nothing keeps pointing at a dead bridge
    if (this._reverseActive) {
      try {
        await this.instance.adb.removeReverse(`localabstract:${SCRCPY_SOCKET_NAME}`);
      } catch {
        // Safe ignore removal errors on teardown
      }
      this._reverseActive = false;
    }
  }
}
