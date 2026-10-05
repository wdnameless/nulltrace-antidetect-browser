import { invalidateTransportCache } from './transportPolicy';
import { createProxyTransport } from './proxyTransport';
// Proxy manager: CRUD, connectivity check (http/https/socks5/ssh) and
// automatic timezone detection from the proxy's egress IP.
import { randomUUID } from 'crypto';
import * as dns from 'node:dns/promises';
import * as http from 'http';
import { getDb } from '../db';
import fetch from 'node-fetch';
import type { SshTunnel } from './sshTunnel';
import { protectSecret } from '../util/secretStore';
import { isPrivateOrLocal } from '../util/ipInfo';

export type ProxyType = 'http' | 'https' | 'socks5' | 'ssh';

export interface ProxyInput {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
}

export interface ProxyRow {
  id: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  private_key: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2 ("DE") from the same lookup. `country` holds the display name. */
  country_code: string | null;
  city: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  created_at: number;
}

export interface ProxyCheckResult {
  ok: boolean;
  ip?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, the value the flag and the short label are derived from. */
  countryCode?: string;
  city?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  latencyMs?: number;
  error?: string;
}

// `countryCode` is the ISO 3166-1 alpha-2 value ("DE"). The display name alone cannot produce a
// flag or a two-letter label, and the provider returns both in this one response — so asking for
// the code costs nothing and removes any need for a name-to-code table.
const CHECK_URL = 'http://ip-api.com/json/?fields=status,message,query,country,countryCode,city,timezone,lat,lon';

function toProxyRow(row: unknown): ProxyRow {
  return row as ProxyRow;
}

export function createProxy(input: ProxyInput): string {
  const db = getDb();
  const id = 'x_' + randomUUID();
  db.prepare(
    `INSERT INTO proxies (id, type, host, port, username, password, private_key, country, city, timezone, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.type,
    input.host,
    input.port,
    input.username ?? null,
    protectSecret(input.password),
    protectSecret(input.privateKey),
    null,
    null,
    null,
    'unknown',
    Date.now()
  );
  // Every proxy is looked up once, at the queue's pace, so no creation path has to remember to ask
  // and none of them can flood the rate-limited lookup service by asking all at once. The caller
  // that wants the answer synchronously still calls `/api/v1/proxy/check` and gets it immediately;
  // this is what stops a proxy created anywhere ELSE from staying "Not checked yet" forever.
  queueGeoChecks([id]);
  return id;
}

export function getProxy(id: string): ProxyRow | undefined {
  return toProxyRow(getDb().prepare('SELECT * FROM proxies WHERE id = ?').get(id));
}
/**
 * Find a proxy by its endpoint rather than its id.
 *
 * Ids are minted locally, so a proxy that arrived from another machine (or from a bundle export)
 * usually carries an id this machine has never seen. Host/port/type/username is the identity that
 * actually survives a move, and it is what both the bundle importer and cloud sync match on — one
 * query, so the two cannot drift into different answers for the same proxy.
 */
export function findProxyByEndpoint(
  host: string,
  port: number,
  type: string,
  username: string | null
): string | null {
  const row = getDb()
    .prepare(
      `SELECT id FROM proxies
        WHERE host = ? AND port = ? AND type = ?
          AND (username = ? OR (username IS NULL AND ? IS NULL))`
    )
    .get(host, port, type, username, username) as { id: string } | undefined;
  return row?.id ?? null;
}

export function listProxies(): ProxyRow[] {
  return getDb()
    .prepare('SELECT * FROM proxies ORDER BY created_at DESC')
    .all() as ProxyRow[];
}

export function updateProxy(id: string, input: Partial<ProxyInput>): boolean {
  const db = getDb();
  const existing = getProxy(id);
  if (!existing) return false;
  db.prepare(
    `UPDATE proxies SET type = ?, host = ?, port = ?, username = ?, password = ?, private_key = ? WHERE id = ?`
  ).run(
    input.type ?? existing.type,
    input.host ?? existing.host,
    input.port ?? existing.port,
    input.username !== undefined ? input.username ?? null : existing.username,
    input.password !== undefined ? protectSecret(input.password) : existing.password,
    input.privateKey !== undefined ? protectSecret(input.privateKey) : existing.private_key,
    id
  );
  invalidateTransportCache();
  return true;
}

export function deleteProxy(id: string): boolean {
  const db = getDb();
  const used = db.prepare('SELECT COUNT(*) AS c FROM profiles WHERE proxy_id = ?').get(id) as { c: number };
  if (used.c > 0) {
    throw new Error('proxy is assigned to a profile');
  }
  const deleted = db.prepare('DELETE FROM proxies WHERE id = ?').run(id).changes > 0;
  if (deleted) invalidateTransportCache();
  return deleted;
}

/**
 * The ISO code as a stored value, or null when the provider sent something that is not one.
 *
 * Stored rather than trusted downstream: `flagOf` derives a flag from two letters, so a malformed
 * value would render as a broken glyph in every row that carries it, and the column is read by
 * paths that cannot re-ask the provider what it meant.
 */
function normalizeCountryCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

export function setProxyResult(id: string, result: ProxyCheckResult): void {
  getDb().prepare(
      'UPDATE proxies SET status = ?, country = ?, country_code = ?, city = ?, timezone = ?, latitude = ?, longitude = ? WHERE id = ?'
    )
    .run(
      result.ok ? 'ok' : 'fail',
      result.country ?? null,
      result.countryCode ?? null,
      result.city ?? null,
      result.timezone ?? null,
      result.latitude ?? null,
      result.longitude ?? null,
      id
    );
}

/**
 * Record an already-performed check, if the proxy still exists.
 *
 * For callers that obtained the result themselves — preflight runs its own probe and must keep the
 * answer rather than throw away a request it already paid for. Returns whether anything was
 * stored, so a caller cannot report a result as recorded when the row was gone.
 */
export function recordCheckResult(id: string, result: ProxyCheckResult): boolean {
  if (!id || !getProxy(id)) return false;
  setProxyResult(id, result);
  notifyGeoResolved(id);
  return true;
}

/**
 * Check a proxy by making a request through it to ip-api.com.
 * For SSH proxies a temporary local SOCKS5 tunnel is created first.
 */
export async function checkProxy(proxy: ProxyRow): Promise<ProxyCheckResult> {
  const started = Date.now();
  let agent: http.Agent | undefined;
  let tunnel: SshTunnel | undefined;

  try {
    const targetHost = await resolveProxyHost(proxy.host);
    // `targetHost` is passed rather than read inside the builder: resolving a private local answer
    // to its public address is this caller's rule, and checkSingleProxyHealth must not inherit it.
    const transport = await createProxyTransport(proxy, targetHost);
    tunnel = transport.tunnel;
    agent = transport.agent;

    /*
     * Two attempts. A rotating residential gateway occasionally returns a malformed response —
     * measured here as `Parse Error: Missing expected CR after response line`, which succeeded on
     * the very next request and never repeated against the same proxy. A single attempt reported
     * that transient noise as a dead proxy.
     *
     * Only transport-level failures are retried. A well-formed answer that says the proxy is bad,
     * or an auth rejection, is a fact about the proxy and is returned immediately.
     */
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const body = (await httpCheck(CHECK_URL, agent, 15000)) as {
          status?: string;
          query?: string;
          country?: string;
          countryCode?: string;
          city?: string;
          timezone?: string;
          lat?: number;
          lon?: number;
        };
        if (body.status !== 'success') {
          return { ok: false, error: 'proxy check failed' };
        }
        return {
          ok: true,
          ip: body.query,
          country: body.country,
          countryCode: normalizeCountryCode(body.countryCode),
          city: body.city,
          timezone: body.timezone,
          latitude: body.lat,
          longitude: body.lon,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        lastError = (err as Error).message;
        if (attempt === 2 || !isTransientProxyError(lastError)) break;
      }
    }
    return { ok: false, error: lastError };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    if (tunnel) await tunnel.close();
  }
}

/** A failure that a second attempt can plausibly clear, unlike a rejection or a bad credential. */
function isTransientProxyError(message: string): boolean {
  return /Parse Error|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN|other side closed/i.test(message);
}

/**
 * Describe a hostname that resolves somewhere a public proxy cannot be, or null when it is fine.
 *
 * Deliberately says "DNS", not "network": the operator cannot fix a resolver by retrying, and the
 * message has to point at the machine rather than at the provider.
 */
async function resolveProxyHost(host: string): Promise<string> {
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isIpLiteral) return host;
  if (/(^|\.)(localhost|local|lan|internal|home)$/i.test(host)) return host;

  let localAddress: string | null = null;
  try {
    const { address } = await dns.lookup(host);
    if (!isPrivateOrLocal(address)) {
      return host;
    }
    localAddress = address;
  } catch {
    // Local DNS failed
  }

  // Fallback to public DNS when local DNS resolves to private IP or fails
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '8.8.8.8', '77.88.8.8']);
    const addrs = await resolver.resolve4(host);
    if (addrs && addrs.length > 0) return addrs[0];
  } catch {
    // Public DNS failed
  }

  try {
    const res = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      timeout: 3000,
    });
    const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    const a = data.Answer?.find((x) => x.type === 1);
    if (a?.data) return a.data;
  } catch {
    // DoH failed
  }

  return localAddress ?? host;
}

function httpCheck(urlStr: string, agent: http.Agent | undefined, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }
    const req = http.request(
      u,
      {
        agent,
        insecureHTTPParser: true,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'NullTrace/1.0',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 407) {
            return reject(
              new Error('Proxy authentication required (HTTP 407). Check your proxy username and password.')
            );
          }
          if (res.statusCode && res.statusCode >= 400) {
            return reject(
              new Error(`Proxy returned HTTP ${res.statusCode}${data ? ': ' + data.slice(0, 100) : ''}`)
            );
          }
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch {
            reject(new Error(`Invalid JSON from proxy check: ${data.slice(0, 100)}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Proxy connection timed out (${timeoutMs}ms)`));
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.end();
  });
}

export interface GeoFillStatus {
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  current_proxy_id: string | null;
  started_at: number | null;
  pacing_ms: number;
}

const GEO_FILL_PACING_MS = 1500; // 1500ms delay = 40 req/min (strictly under ip-api 45 req/min free limit)

let cancelGeoFillDelay: (() => void) | null = null;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    cancelGeoFillDelay = null;
    resolve();
  }, ms);
  cancelGeoFillDelay = () => {
    clearTimeout(timer);
    cancelGeoFillDelay = null;
    resolve();
  };
  return promise;
}

/*
 * ONE QUEUE FOR EVERY GEO CHECK.
 *
 * There used to be no queue at all: a proxy was checked only if the operator pressed Test on the
 * Proxies page, or if a profile was created through that one page's own check call. A proxy that
 * arrived any other way — an agent creating a profile, the SDKs, a batch create, a CSV import —
 * was written with `country = NULL, status = 'unknown'` and nothing ever asked where it exits. Its
 * row said "Not checked yet" for the rest of its life.
 *
 * The queue is the single owner now, so every door gets the same behaviour and the free lookup
 * service sees one paced stream instead of whatever each caller happens to fire. Pacing is why
 * this cannot simply be "check inside createProxy and await": a 142-line proxy import would open
 * 142 concurrent lookups and get rate-limited, which reads to the operator as "the geo feature is
 * broken" — the defect this queue exists to remove.
 */
const geoPending: string[] = [];
const geoPendingSet = new Set<string>();
let geoWorkerActive = false;
let geoFillStatus: GeoFillStatus = {
  running: false,
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  current_proxy_id: null,
  started_at: null,
  pacing_ms: GEO_FILL_PACING_MS,
};

type GeoResolvedCallback = (proxyId: string) => void;
const geoResolvedCallbacks: GeoResolvedCallback[] = [];

/**
 * Notified when a queued check has STORED its result, so a table can refresh at the moment the
 * geography exists instead of on its next slow poll.
 */
export function onProxyGeoResolved(cb: GeoResolvedCallback): () => void {
  geoResolvedCallbacks.push(cb);
  return () => {
    const idx = geoResolvedCallbacks.indexOf(cb);
    if (idx !== -1) geoResolvedCallbacks.splice(idx, 1);
  };
}

function notifyGeoResolved(proxyId: string): void {
  for (const cb of geoResolvedCallbacks) {
    try {
      cb(proxyId);
    } catch {
      // A subscriber's failure is not the proxy's problem.
    }
  }
}

/**
 * Whether the row already carries what the geo column needs.
 *
 * The CODE is the test, not the name. Rows written before `country_code` existed hold a display
 * name and no code, so they are still unresolved: a geo pass fills the code and the flag starts
 * working on a row that previously could never show one.
 */
function isGeoResolved(proxy: ProxyRow | undefined): boolean {
  return Boolean(proxy && proxy.country_code);
}

export function getGeoFillStatus(): GeoFillStatus {
  return { ...geoFillStatus };
}

/**
 * Ask for these proxies to be looked up, at the queue's pace.
 *
 * Idempotent: an id already waiting is not queued twice, so a profile update that re-sends the
 * same proxy cannot spend a second request on it.
 */
export function queueGeoChecks(ids: readonly string[]): void {
  let added = 0;
  for (const id of ids) {
    if (!id || geoPendingSet.has(id)) continue;
    geoPendingSet.add(id);
    geoPending.push(id);
    added++;
  }
  if (added === 0) return;

  if (geoWorkerActive) {
    // Work accepted while a worker exists still needs the progress display to say so. Without
    // this, a pass that had been stopped — which clears `running` and cancels the delay — accepted
    // new ids that the still-live worker drained while every status query reported "not running".
    geoFillStatus.running = true;
    geoFillStatus.total += added;
  } else {
    // A pass that starts from idle is the one the progress display is about, so its counters
    // begin at zero rather than continuing an earlier pass's totals.
    geoFillStatus = {
      running: true,
      total: added,
      completed: 0,
      succeeded: 0,
      failed: 0,
      current_proxy_id: null,
      started_at: Date.now(),
      pacing_ms: GEO_FILL_PACING_MS,
    };
  }
  void drainGeoQueue();
}

async function drainGeoQueue(): Promise<void> {
  if (geoWorkerActive) return;
  geoWorkerActive = true;
  try {
    while (geoPending.length > 0) {
      const id = geoPending.shift() as string;
      try {
        const current = getProxy(id);
        if (!current || isGeoResolved(current)) {
          // Nothing to ask: the proxy is gone, or its row already answers the column.
          geoFillStatus.completed++;
          continue;
        }

        geoFillStatus.current_proxy_id = id;
        try {
          const res = await checkProxy(current);
          setProxyResult(id, res);
          if (res.ok) geoFillStatus.succeeded++;
          else geoFillStatus.failed++;
          notifyGeoResolved(id);
        } catch {
          geoFillStatus.failed++;
        }
        geoFillStatus.completed++;
      } finally {
        // Released only HERE, not when the id was shifted off. While a request is in flight — up to
        // the 15s timeout, twice on a retry — the id must stay in the set: otherwise a
        // `queueGeoChecks` call in that window queues a SECOND check of the same proxy, and a proxy
        // that then fails gets checked twice against a rate-limited quota and counted twice.
        geoPendingSet.delete(id);
        geoFillStatus.current_proxy_id = null;
      }

      if (geoPending.length > 0) await delay(GEO_FILL_PACING_MS);
    }
  } finally {
    geoWorkerActive = false;
    geoFillStatus.running = false;
    geoFillStatus.current_proxy_id = null;
  }
}

/**
 * Stop the pending work.
 *
 * A check already in flight is NOT cancelled: it has spent a request from a strictly limited
 * quota, and its answer is as true as one taken a moment later. Cancelling it would discard that
 * request and leave the row unknown.
 *
 * `total` is deliberately left as the size of the pass that was attempted. Rewriting it to the
 * completed count made a stopped pass of 100 report "3/3" — it read as a finished job instead of a
 * cancelled one, which is the opposite of what happened to the other 97 proxies.
 */
export function stopGeoFill(): GeoFillStatus {
  geoPending.length = 0;
  geoPendingSet.clear();
  if (cancelGeoFillDelay) {
    cancelGeoFillDelay();
  }
  geoFillStatus.running = false;
  geoFillStatus.current_proxy_id = null;
  return { ...geoFillStatus, running: false };
}

/**
 * Queue every proxy whose geography is missing, at the queue's pace.
 *
 * `force` re-checks rows whose last check FAILED. Without it they are skipped: their failure is a
 * fact about the proxy, and repeating it would spend the whole quota on the dead ones instead of
 * the ones that might answer.
 */
export function startGeoFill(options?: { force?: boolean }): GeoFillStatus {
  const db = getDb();
  const query = options?.force
    ? 'SELECT * FROM proxies WHERE (country_code IS NULL OR country_code = \'\') ORDER BY created_at DESC'
    : 'SELECT * FROM proxies WHERE (country_code IS NULL OR country_code = \'\') AND status != \'fail\' ORDER BY created_at DESC';
  const ids = (db.prepare(query).all() as ProxyRow[]).filter((p) => !isGeoResolved(p)).map((p) => p.id);
  queueGeoChecks(ids);
  return { ...geoFillStatus };
}
