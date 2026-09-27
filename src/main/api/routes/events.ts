/**
 * Live event stream for the panel.
 *
 * The operator could not see an agent-opened profile in the interface, and the reason was that the
 * only mechanism was a 5-second poll gated on two conditions that both fail exactly when it matters
 * (`Profiles.tsx`: `document.visibilityState === 'visible' && !busy`). With the window in the
 * background — which is the normal case when an agent is doing the work — nothing refreshed at all.
 * This endpoint replaces "ask again every few seconds" with "tell me when it changes", which is the
 * only shape that cannot miss an event and cannot be disabled by a stuck UI flag.
 *
 * SSE rather than WebSocket: this is one-way, it reconnects on its own, and the repository already
 * streams SSE to this same renderer (`/api/tasks/:uuid/logs?stream=true`).
 *
 * WHY THE KEY MAY ARRIVE IN THE QUERY STRING
 *
 * `EventSource` cannot set an `Authorization` header — that is a limitation of the browser API, not
 * a choice. The alternative would be either weakening `authMiddleware` for this route or having the
 * renderer fetch and buffer the stream itself. Neither is worth it: this route therefore validates
 * the same key by hand from `?key=`, and every other route is untouched. The exposure is bounded by
 * the backend being loopback-only by default, and the comparison is timing-safe.
 */

import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { getApiKey } from '../../config';
import { onProfileStatusChange } from '../../profiles/profileManager';
import { onProxyGeoResolved } from '../../proxy/proxyManager';
import { onAgentActivity, publishAgentActivity, MCP_TOOL_LABELS, type AgentActivityEvent } from '../../agentActivity';

export const eventsRouter = Router();

/** Timing-safe comparison of a supplied key against the live one. */
function keyMatches(supplied: string): boolean {
  const expected = getApiKey();
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * The single refusal for every route on this pre-auth router.
 *
 * Both routes here are mounted above `authMiddleware`, so each must refuse in exactly the same
 * shape — a caller cannot be told which of them was stricter, and a future route added to this
 * router has one thing to call rather than a snippet to copy.
 */
function refuseUnauthorized(res: Response): void {
  res.status(401).json({ code: -1, msg: 'unauthorized', data: {} });
}

/**
 * The key for a route that cannot rely on `authMiddleware`, taken from wherever the caller can
 * realistically put it: a Bearer header (normal fetch) or `?key=` (EventSource).
 */
function suppliedKey(req: Request): string {
  const header = String(req.headers.authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const query = String(req.query?.key ?? '');
  if (query) return query;
  return String(req.body?.key ?? '');
}

/**
 * One open stream. Tracked so leaks are visible and a test can assert that a disconnected client
 * released its subscription; the count is `openStreams.size`.
 */
export const openStreams = new Set<Response>();

/**
 * How often a comment line is written.
 *
 * Proxies and browsers close an idle connection, and a stream with no traffic for a minute looks
 * idle even though it is healthy. The keep-alive is a comment (`:` prefix), so it is ignored by
 * `EventSource` and never reaches a listener as an event.
 */
const KEEPALIVE_MS = 25_000;

function write(res: Response, payload: Record<string, unknown>): void {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // A stream that has gone away throws on write; the close handler removes it.
  }
}

eventsRouter.get('/api/v1/events/stream', (req: Request, res: Response) => {
  if (!keyMatches(suppliedKey(req))) {
    refuseUnauthorized(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // A reverse proxy that buffers would hold every event until the buffer filled, which looks
    // exactly like the missed updates this endpoint exists to fix.
    'X-Accel-Buffering': 'no',
  });

  // Tell the client it is connected, so the UI can distinguish "no events" from "not connected".
  write(res, { type: 'hello', at: Date.now() });
  openStreams.add(res);

  const unsubscribeStatus = onProfileStatusChange((profileId, status) => {
    write(res, { type: 'profile-status', profileId, status, at: Date.now() });
  });

  const unsubscribeActivity = onAgentActivity((event: AgentActivityEvent) => {
    write(res, { type: 'agent-activity', event });
  });

  // A queued geo check finishing is the event an operator is waiting on right after creating a
  // proxy or a profile, and the cell it fills is in a table that otherwise refreshes on a 30s
  // floor. Pushed, so the row stops saying "Not checked yet" when the answer actually arrives.
  const unsubscribeGeo = onProxyGeoResolved((proxyId) => {
    write(res, { type: 'proxy-geo', proxyId, at: Date.now() });
  });

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      // Handled by the close listener below.
    }
  }, KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(keepAlive);
    unsubscribeStatus();
    unsubscribeActivity();
    unsubscribeGeo();
    openStreams.delete(res);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
});

/**
 * POST /api/v1/agent-activity { tool, profileId? }
 *
 * How the MCP process reports the actions it performs over CDP.
 *
 * Six MCP tools (`browser.navigate`, `browser.click`, `browser.type`, `browser.screenshot`,
 * `browser.human_type`, `browser.human_click`) drive puppeteer straight to the profile's DevTools
 * endpoint and therefore never appear in this backend's request log — see the module comment in
 * `agentActivity.ts`. Those are precisely the actions the operator wants to see, so the MCP
 * dispatcher reports each successful one here.
 *
 * The tool NAME is sent, not a rendered sentence: the vocabulary lives in `MCP_TOOL_LABELS` on this
 * side, so the two processes cannot drift into two descriptions of the same action, and adding a
 * tool does not require shipping a new MCP build just to name it.
 */
eventsRouter.post('/api/v1/agent-activity', (req: Request, res: Response) => {
  /*
   * Checked here, not by `authMiddleware`.
   *
   * This router is mounted BEFORE the Bearer gate on purpose: `EventSource` cannot set an
   * `Authorization` header, so the SSE stream above must validate its own key or it would answer
   * 401 to every legitimate client. The GET does check; this POST was overlooked when it was added
   * to the same router, so it inherited the pre-auth position without inheriting the check.
   * Measured before this guard: `POST /api/v1/agent-activity` with no Authorization header returned
   * `200 {"code":0,...,"ok":true}` while an auth-gated sibling returned 401 — so any process that
   * could reach the loopback port could publish fabricated agent activity into the operator's live
   * feed, including a profile id of its choosing.
   *
   * A header or body key is accepted (a normal fetch can send the header; a caller that mirrors the
   * MCP dispatcher may pass it in the body, as the stream route takes it in the query).
   */
  if (!keyMatches(suppliedKey(req))) {
    refuseUnauthorized(res);
    return;
  }

  const tool = String(req.body?.tool ?? '').trim();
  if (!tool) {
    res.status(400).json({ code: -1, msg: 'tool is required', data: {} });
    return;
  }
  const label = MCP_TOOL_LABELS[tool];
  const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim() ? req.body.profileId.trim() : undefined;
  /*
   * An unmapped tool is still published, under its raw name. Reporting is a courtesy to the
   * operator, and a tool the panel has no sentence for should still show up rather than vanish —
   * silently dropping it would make the feed lie about what the agent did.
   */
  const verb = label?.verb ?? 'Used';
  const kind = label?.kind ?? tool;
  publishAgentActivity({
    kind,
    summary: profileId ? `${verb} ${profileId} (${tool})` : `${verb} ${tool}`,
    source: 'agent',
    profileId,
    route: tool,
  });
  res.json({ code: 0, msg: 'success', data: { ok: true } });
});

export default eventsRouter;
