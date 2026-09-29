// Network Diagnostics (Sprint 2.2): sanity checks for a RUNNING profile.
//
// Collected through the profile's own CDP endpoint so every probe goes through
// the profile proxy:
//   - external IP + geo (ip-api through the browser proxy, reuses the same
//     upstream as proxyManager.checkProxy)
//   - browser timezone vs IP timezone match
//   - WebRTC leak probe: RTCPeerConnection ICE candidates in the MAIN world
//   - user-agent vs platform consistency (navigator.userAgentData vs UA string)
//   - DNS-leak hint: honestly null — a reliable two-resolver comparison is not
//     measurable from the browser context without extra infrastructure.
import puppeteer from 'puppeteer-core';
import fetch from 'node-fetch';
import * as http from 'http';
import { getRunningWs, isRunning } from '../launcher/chromium';
import { getUdpRelayState, type UdpRelayState } from '../proxy/udpRelay';

export type CheckStatus = 'ok' | 'warn';

export interface DiagnosticsReport {
  profile_id: string;
  ip: string | null;
  geo: { country?: string; city?: string; timezone?: string; lat?: number; lon?: number } | null;
  timezone: string | null;
  ip_timezone: string | null;
  timezone_match: CheckStatus | null;
  webrtc: CheckStatus | null;
  webrtc_addresses: string[];
  consistency: CheckStatus | null;
  consistency_detail: string | null;
  dns_leak: null;
  collected_at: number;
  relay_state?: UdpRelayState;
}

const GEO_URL = 'http://ip-api.com/json/?fields=status,query,country,city,timezone,lat,lon';

interface IceCandidate {
  candidate: string;
}

/**
 * Fetch ip-api through a SOCKS/HTTP proxy. Returns null when unreachable —
 * diagnostics never hard-fail on a single probe.
 */
async function fetchGeoThroughProxy(profileId: string): Promise<{ body: Record<string, unknown> | null; ip: string | null }> {
  const px = getProxyForProfile(profileId);
  try {
    let agent: http.Agent | undefined;
    if (px) {
      const { SocksProxyAgent } = await import('socks-proxy-agent');
      const { HttpProxyAgent } = await import('http-proxy-agent');
      const auth = px.username ? `${encodeURIComponent(px.username)}:${encodeURIComponent(px.password ?? '')}@` : '';
      agent = px.type === 'socks5'
        ? new SocksProxyAgent(`socks5://${auth}${px.host}:${px.port}`) as unknown as http.Agent
        : new HttpProxyAgent(`http://${auth}${px.host}:${px.port}`) as unknown as http.Agent;
    }
    const res = await fetch(GEO_URL, { agent, timeout: 8000 });
    const body = (await res.json()) as Record<string, unknown>;
    if (body.status !== 'success') return { body: null, ip: null };
    return { body, ip: typeof body.query === 'string' ? body.query : null };
  } catch {
    return { body: null, ip: null };
  }
}

function getProxyForProfile(profileId: string): { type: string; host: string; port: number; username?: string; password?: string } | null {
  try {
    // Lazy import avoids a module-load cycle with profileManager.
    const pm = require('../profiles/profileManager') as typeof import('../profiles/profileManager');
    const details = pm.getProfileDetails(profileId);
    if (details?.proxy) {
      const pxRow = details.proxy;
      const db = require('../db').getDb() as { prepare(sql: string): { get(...p: unknown[]): unknown } };
      const row = db.prepare('SELECT username, password FROM proxies WHERE id = ?').get(pxRow.id) as
        | { username: string | null; password: string | null }
        | undefined;
      const { revealSecret } = require('../util/secretStore') as typeof import('../util/secretStore');
      return {
        type: pxRow.type,
        host: pxRow.host,
        port: pxRow.port,
        username: pxRow.username ?? undefined,
        password: row ? revealSecret(row.password) : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** WebRTC probe: create an RTCPeerConnection in the page and harvest host/srflx candidates. */
async function probeWebRTC(wsEndpoint: string): Promise<{ status: CheckStatus | null; addresses: string[] }> {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  try {
    const targets = await browser.targets();
    const pageTarget = targets.find((t) => t.type() === 'page');
    if (!pageTarget) return { status: null, addresses: [] };
    const session = await pageTarget.createCDPSession();
    const expr = `(async () => {
      const ips = new Set();
      try {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.createDataChannel('probe');
        const done = new Promise((resolve) => {
          const t = setTimeout(resolve, 2500);
          pc.addEventListener('icecandidate', (ev) => {
            if (ev.candidate && ev.candidate.candidate) {
              const m = ev.candidate.candidate.match(/(\\d{1,3}(\\.\\d{1,3}){3})/);
              if (m) ips.add(m[1]);
              if (ev.candidate.type === 'srflx' || !ev.candidate.candidate.includes('typ host')) {
                // keep collecting until timeout
              }
            } else { clearTimeout(t); resolve(); }
          });
        });
        await pc.setLocalDescription(await pc.createOffer());
        await done;
        pc.close();
      } catch (e) { /* RTCPeerConnection blocked = not a leak */ }
      return Array.from(ips);
    })()`;
    const result = (await session.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      // MAIN world is the default for Runtime.evaluate on a page session.
    })) as { result?: { value?: unknown } };
    const addresses = Array.isArray(result.result?.value)
      ? (result.result.value as string[]).filter((a) => typeof a === 'string')
      : [];
    // Leak = a public (non-private, non-loopback) address exposed via ICE.
    const isPrivate = (ip: string): boolean =>
      ip.startsWith('10.') || ip.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith('127.') ||
      ip.startsWith('169.254.') || ip.startsWith('::1') || ip.startsWith('fc') || ip.startsWith('fd');
    const publicAddrs = addresses.filter((a) => !isPrivate(a));
    // mDNS obfuscation: candidates like "xxxx.local" are already hidden — safe.
    const leaked = addresses.filter((a) => !a.endsWith('.local'));
    void leaked;
    return { status: publicAddrs.length > 0 ? 'warn' : 'ok', addresses };
  } catch {
    return { status: null, addresses: [] };
  } finally {
    browser.disconnect();
  }
}

/** UA consistency: navigator.userAgentData.platform should match the UA string's OS. */
async function probeConsistency(
  wsEndpoint: string
): Promise<{ status: CheckStatus | null; detail: string | null }> {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
  try {
    const targets = await browser.targets();
    const pageTarget = targets.find((t) => t.type() === 'page');
    if (!pageTarget) return { status: null, detail: null };
    const session = await pageTarget.createCDPSession();
    const result = (await session.send('Runtime.evaluate', {
      expression: `(() => ({
        ua: navigator.userAgent,
        uadPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
        platform: navigator.platform,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone
      }))()`,
      returnByValue: true,
    })) as { result?: { value?: { ua?: string; uadPlatform?: string | null; platform?: string; tz?: string } } };
    const v = result.result?.value;
    if (!v || !v.ua) return { status: null, detail: null };
    const ua = v.ua;
    const uaSaysWin = /Windows/.test(ua);
    const uaSaysMac = /Macintosh|Mac OS/.test(ua);
    const uaSaysLinux = /Linux|X11/.test(ua) && !/Android/.test(ua);
    const uaSaysAndroid = /Android/.test(ua);
    let uad: string | null = v.uadPlatform ?? null;
    if (!uad && v.platform) {
      // navigator.platform fallback mapping
      if (/Win/.test(v.platform)) uad = 'Windows';
      else if (/Mac/.test(v.platform)) uad = 'macOS';
      else if (/Linux|arm/.test(v.platform) && uaSaysAndroid) uad = 'Android';
      else if (/Linux/.test(v.platform)) uad = 'Linux';
    }
    let detail = `ua=${uaSaysWin ? 'Windows' : uaSaysMac ? 'macOS' : uaSaysAndroid ? 'Android' : uaSaysLinux ? 'Linux' : 'unknown'}`;
    let ok = true;
    if (uad) {
      detail += `, userAgentData=${uad}`;
      const uadWin = uad === 'Windows';
      const uadMac = uad === 'macOS';
      const uadAndroid = uad === 'Android';
      const uadLinux = uad === 'Linux';
      ok =
        (uaSaysWin && uadWin) || (uaSaysMac && uadMac) ||
        (uaSaysAndroid && uadAndroid) || (uaSaysLinux && uadLinux);
    }
    return { status: ok ? 'ok' : 'warn', detail };
  } catch {
    return { status: null, detail: null };
  } finally {
    browser.disconnect();
  }
}

export async function collectDiagnostics(profileId: string): Promise<DiagnosticsReport | null> {
  if (!isRunning(profileId)) return null;
  const ws = getRunningWs(profileId);
  if (!ws) return null; // race: profile stopped between check and ws read
  const report: DiagnosticsReport = {
    profile_id: profileId,
    ip: null,
    geo: null,
    timezone: null,
    ip_timezone: null,
    timezone_match: null,
    webrtc: null,
    webrtc_addresses: [],
    consistency: null,
    consistency_detail: null,
    dns_leak: null,
    collected_at: Date.now(),
    relay_state: getUdpRelayState(profileId),
  };

  const [{ body }, consistency] = await Promise.all([
    fetchGeoThroughBrowserProxy(profileId, ws),
    probeConsistency(ws),
  ]);

  if (body) {
    report.ip = typeof body.query === 'string' ? body.query : null;
    report.geo = {
      country: typeof body.country === 'string' ? body.country : undefined,
      city: typeof body.city === 'string' ? body.city : undefined,
      timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
      lat: typeof body.lat === 'number' ? body.lat : undefined,
      lon: typeof body.lon === 'number' ? body.lon : undefined,
    };
    report.ip_timezone = typeof body.timezone === 'string' ? body.timezone : null;
  }

  // Browser timezone via CDP (reflects the spoofed/emulated timezone).
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    try {
      const targets = await browser.targets();
      const pageTarget = targets.find((t) => t.type() === 'page');
      if (pageTarget) {
        const session = await pageTarget.createCDPSession();
        const r = (await session.send('Runtime.evaluate', {
          expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone',
          returnByValue: true,
        })) as { result?: { value?: string } };
        report.timezone = r.result?.value ?? null;
      }
    } finally {
      browser.disconnect();
    }
  } catch {
    // keep timezone null
  }

  if (report.timezone && report.ip_timezone) {
    report.timezone_match = report.timezone === report.ip_timezone ? 'ok' : 'warn';
  }

  const webrtc = await probeWebRTC(ws);
  report.webrtc = webrtc.status;
  report.webrtc_addresses = webrtc.addresses;
  report.consistency = consistency.status;
  report.consistency_detail = consistency.detail;

  return report;
}

/**
 * Fetch geo through the BROWSER's egress (the profile proxy). We reuse the
 * proxy row from the DB because the browser itself routes through it, so the
 * result is identical to what the page sees.
 */
async function fetchGeoThroughBrowserProxy(
  profileId: string,
  _ws: string
): Promise<{ body: Record<string, unknown> | null }> {
  const { body } = await fetchGeoThroughProxy(profileId);
  return { body };
}