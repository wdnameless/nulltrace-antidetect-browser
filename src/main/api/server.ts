import express, { Express, Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import cors from 'cors';
import { API_HOST, API_PORT, APP_VERSION, DATA_DIR, SERVER_MODE, TRUSTED_HOSTS } from '../config';
import { authMiddleware } from './auth';
import { rateLimitMiddleware } from './rateLimit';
import { createCdpRouter, tryHandleCdpUpgrade } from './cdpTunnel';
import { createViewerUpgradeHandler } from './viewer';
import { createMotionUpgradeHandler } from './motionBridge';
import { createRecorderUpgradeHandler } from '../recorder/bridge';
import { PANEL_HTML } from './uiPanel';
import { getCdpEndpoint } from '../launcher/chromium';
import { getApiKey } from '../config';
import browserRoutes from './routes/browser';
import proxyRoutes from './routes/proxy';
import proxyHealthRoutes from './routes/proxyHealth';
import deviceRoutes from './routes/device';
import emailRoutes from './routes/email';
import cookiesRoutes from './routes/cookies';
import extensionsRoutes from './routes/extensions';
import batchRoutes from './routes/batch';
import logsRoutes from './routes/logs';
import kernelRoutes from './routes/kernel';
import cloudRoutes from './routes/cloud';
import teamsRoutes from './routes/teams';
import syncRoutes from './routes/sync';
import licensingRoutes from './routes/licensing';
import vaultRoutes from './routes/vault';
import diagnosticsRoutes from './routes/diagnostics';
import androidRoutes from './routes/android';
import tagsRoutes from './routes/tags';
import trashRoutes from './routes/trash';
import profilesRoutes from './routes/profiles';
import syncerRoutes from './routes/syncer';
import scriptsRoutes from './routes/scripts';
import keysRoutes from './routes/keys';
import triggersRoutes from './routes/triggers';
import taskGroupsRoutes from './routes/taskGroups';
import flowsRoutes from './routes/flows';
import catalogRoutes from './routes/catalog';
import preflightRoutes from './routes/preflight';
import cookieRobotRoutes from './routes/cookieRobot';
import settingsRoutes from './routes/settings';
import aiRoutes from './routes/ai';
import databasesRoutes from './routes/databases';
import { motionRouter } from './routes/motion';
import { dataDirRouter } from './routes/dataDir';
import { shutdownRouter } from './routes/shutdown';
import { mcpRouter } from './routes/mcp';
import { eventsRouter } from './routes/events';
import {
  classifyRequest,
  describeRequest,
  extractProfileId,
  publishAgentActivity,
} from '../agentActivity';

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function hostAllowed(host: string): boolean {
  if (LOOPBACK_HOST_RE.test(host)) return true;
  if (!SERVER_MODE) return false;
  const bare = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  return TRUSTED_HOSTS.includes(bare);
}

/**
 * Does an Origin header name the same authority this request was addressed to?
 *
 * Compared against the request's own Host rather than a fixed allowlist, so a reverse-proxied
 * entry point (Traefik on a VPN) works with no extra configuration while a page served from
 * anywhere else is refused. An unparseable origin (`null`, from a file:// page) fails closed:
 * we cannot tell where it came from, so the key is not handed over.
 */
function isSameOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

/** Minimal append-only request log for server mode (DATA_DIR/server.log). */
function logRequest(req: Request, res: Response, ms: number): void {
  try {
    const line = `${new Date().toISOString()} ${req.ip || '-'} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms\n`;
    fs.appendFileSync(path.join(DATA_DIR, 'server.log'), line, 'utf8');
  } catch {
    // logging must never break the API
  }
}
export function createApp(): Express {
  const app: Express = express();
  app.use(express.json());

  if (SERVER_MODE) {
    // Behind a reverse proxy on a trusted network: same-origin only (the web
    // panel is served by this service), every call logged to file.
    app.use((req, res, next) => {
      const t0 = Date.now();
      res.on('finish', () => logRequest(req, res, Date.now() - t0));
      next();
    });
  } else {
    app.use(cors());
  }

  // DNS-rebinding protection: only loopback Host headers are accepted locally.
  // In server mode, explicitly trusted hosts (reverse proxy / VPN entry points)
  // are allowed too — configure via ANTIDETECT_TRUSTED_HOSTS.
  app.use((req, res, next) => {
    const host = String(req.headers.host || '');
    if (hostAllowed(host)) {
      next();
      return;
    }
    res.status(403).json({ code: -1, msg: 'forbidden host', data: {} });
  });

  // Health check (no auth). The version is read from package.json rather than hardcoded:
  // it previously reported a literal '0.0.1' that matched no release, so any client asking
  // the service what it was got an answer that could not be trusted.
  //
  // `rateLimitMiddleware` is attached HERE rather than relying on the global `app.use` further
  // down: this route is registered early on purpose, because it is an unauthenticated health
  // check that must answer before the auth gate, so the global middleware never reached it and
  // the 50 req/s limit `rateLimit.ts` declares for '/status' was dead configuration. Attaching it
  // at the route keeps the route's contract (no auth, answers early) while making the declared
  // limit real — the alternative, moving the route behind the global middleware, would have put
  // a health check behind authentication.
  app.get('/status', rateLimitMiddleware, (_req, res) => {
    res.json({ code: 0, msg: 'success', data: { status: 'ok', version: APP_VERSION } });
  });

  const rendererDir = resolveRendererDir(__dirname);

  const brandFaviconPath = [
    path.resolve(process.cwd(), 'assets/brand/favicon.ico'),
    path.resolve(__dirname, '../../../assets/brand/favicon.ico'),
  ].find((p) => fs.existsSync(p));

  // Favicon (unauthenticated)
  app.get('/favicon.ico', (_req, res) => {
    if (brandFaviconPath && fs.existsSync(brandFaviconPath)) {
      res.sendFile(brandFaviconPath);
      return;
    }
    const distFavicon = path.join(rendererDir, 'favicon.ico');
    if (fs.existsSync(distFavicon)) {
      res.sendFile(distFavicon);
      return;
    }
    res.status(204).end();
  });

  // Web panel (legacy /ui html)
  app.get('/ui', (_req, res) => {
    res.type('html').send(PANEL_HTML);
  });

  /**
   * The API key, for a page this backend served.
   *
   * The panel has no password by design. A browser client has no Tauri bridge to inject the
   * key the way the desktop shell does, so without this it could never authenticate and the
   * install-free web panel would be unusable — previously that is exactly what the
   * username/password login existed to paper over.
   *
   * Same-origin is what makes serving it safe, and it is checked, not assumed:
   * `hostAllowed()` above already rejects DNS-rebinding Host headers, but a hostile page can
   * still fetch `http://127.0.0.1:50325` directly — its Host *is* loopback — and read the
   * body, because CORS is permissive outside server mode. Requiring the Origin to equal the
   * Host closes that path and still works behind Traefik/VPN, where the page's origin and the
   * Host it talks to agree.
   */
  app.get('/ui/key', (req: Request, res: Response) => {
    const origin = String(req.headers.origin || '');
    if (origin && !isSameOrigin(origin, String(req.headers.host || ''))) {
      res.status(403).json({ code: -1, msg: 'cross-origin key request refused', data: {} });
      return;
    }
    res.json({ code: 0, msg: 'success', data: { key: getApiKey() } });
  });

  // Static assets from built renderer (unauthenticated)
  if (fs.existsSync(rendererDir)) {
    app.use(express.static(rendererDir, { index: false }));
  } else {
    console.warn('[antidetect] Web renderer build not found at dist/renderer. Static UI will not be served.');
  }

  // SPA route fallback: serve index.html before authMiddleware for non-API/non-UI GET requests
  const isApiOrInternalPath = (urlPath: string): boolean => {
    return (
      urlPath.startsWith('/api/') ||
      urlPath.startsWith('/api') ||
      urlPath.startsWith('/ui/') ||
      urlPath.startsWith('/ui') ||
      urlPath.startsWith('/cdp') ||
      urlPath.startsWith('/browser') ||
      urlPath.startsWith('/status') ||
      urlPath.startsWith('/motion') ||
      urlPath.startsWith('/recorder') ||
      urlPath.startsWith('/fingerprint') ||
      urlPath.startsWith('/proxy') ||
      urlPath.startsWith('/profiles') ||
      urlPath.startsWith('/groups') ||
      urlPath.startsWith('/task-queue') ||
      urlPath.startsWith('/task-groups') ||
      urlPath.startsWith('/flows') ||
      urlPath.startsWith('/catalog') ||
      urlPath.startsWith('/preflight') ||
      urlPath.startsWith('/cookie-robot') ||
      urlPath.startsWith('/settings') ||
      urlPath.startsWith('/trash') ||
      urlPath.startsWith('/scripts') ||
      urlPath.startsWith('/teams') ||
      urlPath.startsWith('/cloud-sync')
    );
  };

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const p = req.path || '';
    if (isApiOrInternalPath(p)) {
      next();
      return;
    }
    const indexPath = path.join(rendererDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    next();
  });
  /*
   * The panel's event stream, BEFORE the Bearer gate.
   *
   * `EventSource` cannot set an `Authorization` header — that is a limitation of the browser API,
   * not a choice — so a stream mounted below `authMiddleware` answers 401 to every client that
   * could legitimately use it. Measured: the identical request returned 401 without the header and
   * streamed `hello` with one.
   *
   * It is not left unauthenticated: the route validates the same key itself, from `?key=`, with a
   * timing-safe comparison (see `events.ts`). Moving it above the gate is what makes the route's
   * own check the one that decides, instead of being pre-empted by a middleware that cannot see a
   * query parameter.
   */
  app.use(eventsRouter);

  // Everything below requires Bearer auth
  app.use(authMiddleware);

  /*
   * Agent-activity observation.
   *
   * Placed after auth so only authenticated callers are classified, and before the routes so it
   * sees a request whatever handler answers it. It records what the request MEANS on the way in,
   * then publishes only once the response is finished and succeeded — an action that was refused
   * or failed is not something to tell the operator about, and publishing first would announce
   * work that never happened.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const source = classifyRequest(req.headers as Record<string, unknown>);
    if (source !== 'agent') {
      next();
      return;
    }
    const described = describeRequest(req.method, req.path);
    if (!described) {
      next();
      return;
    }
    const profileId = extractProfileId(req.body, req.query);
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      publishAgentActivity({
        kind: described.kind,
        summary: profileId ? `${described.verb} ${profileId}` : described.verb,
        source: 'agent',
        profileId,
        route: req.path,
      });
    });
    next();
  });

  // CDP tunnel before rate limiting — automation traffic streams through it
  // continuously and must not be throttled.
  app.use(createCdpRouter(getCdpEndpoint));
  // AdsPower-parity rate limits (1 req/s on list/cookies endpoints).
  app.use(rateLimitMiddleware);
  app.use(browserRoutes);
  app.use(proxyRoutes);
  app.use(proxyHealthRoutes);
  app.use(deviceRoutes);
  app.use('/api/v1/email', emailRoutes);
  app.use(cookiesRoutes);
  app.use(extensionsRoutes);
  app.use(batchRoutes);
app.use(logsRoutes);
app.use(kernelRoutes);
app.use(cloudRoutes);
app.use(teamsRoutes);
app.use(syncRoutes);
app.use(licensingRoutes);
app.use(vaultRoutes);
app.use(diagnosticsRoutes);
app.use(androidRoutes);
app.use(tagsRoutes);
app.use(trashRoutes);
app.use(profilesRoutes);
app.use(syncerRoutes);
app.use(scriptsRoutes);
app.use(keysRoutes);
app.use(triggersRoutes);
app.use(taskGroupsRoutes);
app.use(flowsRoutes);
app.use(catalogRoutes);
app.use(preflightRoutes);
app.use(cookieRobotRoutes);
app.use(settingsRoutes);
app.use(motionRouter);
app.use('/api/v1/mcp', mcpRouter);

  app.use(aiRoutes);
  app.use(databasesRoutes);
  app.use('/api/v1/data', dataDirRouter);
  app.use('/api/v1/shutdown', shutdownRouter);
  // JSON 404 for unknown routes (Express default would return HTML).
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ code: -1, msg: 'not found', data: {} });
  });

  // Central error handler: always answer JSON, never the Express HTML error page.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[antidetect] API error:', err);
    res.status(500).json({ code: -1, msg: err?.message ?? 'internal error', data: {} });
  });
  return app;
}

/**
 * Locate the built renderer directory.
 *
 * `__dirname` moves depending on how this process was started: the service compiles
 * to <root>/dist/src/main/api, so the renderer sits several levels ABOVE it, and in a
 * packaged app those levels live inside app.asar. Enumerating relative paths by hand
 * got the depth wrong, so a packaged build could not find index.html and answered 401
 * on every SPA route instead of serving the UI. Walking upward finds the renderer in
 * both the dev and the packaged layout.
 *
 * Exported so the resolution is tested against real directory layouts rather than by
 * reading this file.
 */
export function resolveRendererDir(fromDir: string): string {
  // A directory only counts if it holds a BUILT index.html. The Vite dev template at
  // src/renderer/index.html also exists and also contains an index.html, but it points at
  // /src/main.tsx, which a browser cannot load (wrong MIME type) and which only the Vite
  // dev server can serve. Picking it produced a blank page. Built output references a
  // real hashed asset bundle under ./assets/, so require that.
  const isBuilt = (d: string): boolean => {
    try {
      const html = fs.readFileSync(path.join(d, 'index.html'), 'utf8');
      return /(?:src|href)="\.\/assets\//.test(html);
    } catch {
      return false;
    }
  };
  // Walk upward from the code's own location FIRST: that follows the actual layout and
  // works identically in dev and inside app.asar. The cwd-based guess goes last, since
  // the process's working directory is unrelated to where the bundle was installed —
  // checking it first let a stray dist/renderer elsewhere on disk win.
  const fallback = path.resolve(process.cwd(), 'dist/renderer');
  const candidates: string[] = [];
  let dir = fromDir;
  for (let depth = 0; depth < 6; depth += 1) {
    // Prefer the built directory before its un-built sibling at the same level.
    candidates.push(path.join(dir, 'dist', 'renderer'));
    candidates.push(path.join(dir, 'renderer'));
    dir = path.dirname(dir);
  }
  candidates.push(fallback);
  const built = candidates.find(isBuilt);
  if (built) return built;
  // Nothing built on disk (e.g. a dev run with no bundle): fall back to a directory that
  // at least holds an index.html, so the caller's own error is the one reported.
  const anyIndex = candidates.find((d) => {
    try {
      return fs.existsSync(path.join(d, 'index.html'));
    } catch {
      return false;
    }
  });
  return anyIndex ?? fallback;
}

export function startApi(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);
  // Single upgrade dispatcher: CDP tunnel and remote viewer share the port.
  const viewerUpgrade = createViewerUpgradeHandler(getApiKey);
  const motionUpgrade = createMotionUpgradeHandler(getApiKey);
  const recorderUpgrade = createRecorderUpgradeHandler(getApiKey);
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    if (url.startsWith('/cdp-view/')) {
      viewerUpgrade(req, socket, head);
      return;
    }
    if (url.startsWith('/motion/')) {
      if (motionUpgrade(req, socket, head)) return;
      socket.destroy();
      return;
    }
    if (url.startsWith('/recorder/')) {
      if (recorderUpgrade(req, socket, head)) return;
      socket.destroy();
      return;
    }
    if (tryHandleCdpUpgrade(req, socket, head, getCdpEndpoint, getApiKey)) return;
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    // A failed bind must reject, not hang. Without this handler `EADDRINUSE` surfaces as an
    // unhandled error event: the process dies, the shell's readiness wait never sees the
    // listening line, and the app shows a UI with no backend behind it. The message says
    // whose port it is so the operator is not left guessing.
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${API_PORT} is already in use. Another NullTrace instance (or another program) holds it. ` +
              `Close it, or start this one with a different API_PORT.`
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(API_PORT, API_HOST, () => {
      console.log(
        `[antidetect] Local API listening on http://${API_HOST}:${API_PORT}` +
          (SERVER_MODE ? ' (server mode)' : '')
      );
      resolve();
    });
  });
}
