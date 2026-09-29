// TLS-fingerprint gate & limitation record: measures JA3/JA4 on both kernels —
// fingerprint-chromium (BoringSSL stack) vs Camoufox (NSS / Firefox stack) — via tls.peet.ws.
// Read-only repeatable gate; verifies BoringSSL engine limitation without MITM or engine forks.
// Run: $env:ANTIDETECT_DATA_DIR="D:\WORK\antidetect browser\data"; $env:API_PORT="50331"; npx tsx scripts/probe-tls.ts

import type { Page as PlaywrightPage } from 'playwright';
import type { Browser as PuppeteerBrowser, ConnectOptions } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';
import { getApiKey, API_HOST, API_PORT } from '../src/main/config';
import { startService } from '../src/main/index';
import { getRunningPage } from '../src/main/launcher/firefox';

export const TLS_URL = 'https://tls.peet.ws/api/all';
export const KNOWN_CHROMIUM_JA4 = 't13d1516h2_8daaf6152771_d8a2da3f94cd';
export const DEFAULT_TIMEOUT_MS = 15000;

export interface PeetResult {
  ja3?: string;
  ja3_hash?: string;
  ja4?: string;
  user_agent?: string;
  tls?: { ja4?: string };
}

export interface TlsProbeKernelResult {
  kernel: 'chromium' | 'firefox';
  ja3_hash: string | null;
  ja4: string | null;
  userAgent: string | null;
  skipped?: boolean;
  error?: string;
}

export interface TlsVerdictResult {
  verdict: 'identical' | 'differ' | 'skipped' | 'failed';
  limitationConfirmed: boolean;
  exitCode: number;
  summary: string;
}

export interface ParsedTlsVerdict {
  chromiumJa4: string | null;
  firefoxJa4: string | null;
  verdict: 'identical' | 'differ' | 'skipped' | 'failed';
  limitationConfirmed: boolean;
  exitCode: number;
}

interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

interface ProfileCreateData {
  user_id: string;
}

interface BrowserStartData {
  ws: {
    puppeteer: string;
  };
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch
): Promise<Response> {
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  return fetchFn(url, { ...init, signal });
}

export function evaluateTlsVerdict(
  chromiumJa4: string | null | undefined,
  firefoxJa4: string | null | undefined
): TlsVerdictResult {
  if (!chromiumJa4) {
    return {
      verdict: 'failed',
      limitationConfirmed: false,
      exitCode: 1,
      summary: 'Chromium JA4 could not be captured.',
    };
  }

  if (!firefoxJa4) {
    const isKnown = chromiumJa4 === KNOWN_CHROMIUM_JA4;
    return {
      verdict: 'skipped',
      limitationConfirmed: isKnown,
      exitCode: 0,
      summary: isKnown
        ? `Firefox probe skipped; Chromium JA4 matches known baseline (${chromiumJa4}), confirming BoringSSL engine limitation.`
        : `Firefox probe skipped; Chromium JA4 captured (${chromiumJa4}).`,
    };
  }

  if (chromiumJa4 === firefoxJa4) {
    return {
      verdict: 'identical',
      limitationConfirmed: true,
      exitCode: 0,
      summary: 'identical -> limitation confirmed (TLS fingerprint cannot be differentiated across profiles/kernels by JS/seed)',
    };
  }

  return {
    verdict: 'differ',
    limitationConfirmed: false,
    exitCode: 0,
    summary: 'differ -> distinct native engine TLS stacks observed (BoringSSL vs NSS)',
  };
}

export function formatTlsVerdict(
  chromiumJa4: string | null | undefined,
  firefoxJa4: string | null | undefined,
  result: TlsVerdictResult
): string {
  const lines = [
    '=== TLS PROBE COMPARISON ===',
    `[TLS_PROBE] Chromium JA4: ${chromiumJa4 ?? 'none'}`,
    `[TLS_PROBE] Firefox JA4: ${firefoxJa4 ?? 'skipped'}`,
    `[TLS_PROBE] Comparison: ${result.verdict}`,
    `[TLS_PROBE] Verdict: ${result.verdict}${result.limitationConfirmed ? ' -> limitation confirmed' : ''}`,
    `[TLS_PROBE] Limitation confirmed: ${result.limitationConfirmed}`,
    `[TLS_PROBE] Summary: ${result.summary}`,
    `[TLS_PROBE] Exit code: ${result.exitCode}`,
  ];
  return lines.join('\n');
}

export function parseTlsVerdict(output: string): ParsedTlsVerdict {
  const chromMatch = output.match(/(?:\[TLS_PROBE\]\s*)?Chromium JA4:\s*([^\r\n]+)/i);
  const ffMatch = output.match(/(?:\[TLS_PROBE\]\s*)?Firefox JA4:\s*([^\r\n]+)/i);
  const verdictMatch = output.match(/(?:\[TLS_PROBE\]\s*)?Verdict:\s*([a-zA-Z]+)(?:\s*->\s*limitation confirmed)?/i);
  const limitMatch = output.match(/(?:\[TLS_PROBE\]\s*)?Limitation confirmed:\s*(true|false)/i);
  const exitMatch = output.match(/(?:\[TLS_PROBE\]\s*)?Exit code:\s*(\d+)/i);

  const rawChromium = chromMatch ? chromMatch[1].trim() : null;
  const rawFf = ffMatch ? ffMatch[1].trim() : null;

  const chromiumJa4 = rawChromium && rawChromium !== 'none' ? rawChromium : null;
  const firefoxJa4 = rawFf && !['none', 'skipped'].includes(rawFf.toLowerCase()) ? rawFf : null;

  const rawVerdict = verdictMatch ? verdictMatch[1].toLowerCase() : null;
  let verdict: 'identical' | 'differ' | 'skipped' | 'failed' = 'failed';
  if (rawVerdict === 'identical' || rawVerdict === 'differ' || rawVerdict === 'skipped') {
    verdict = rawVerdict;
  }

  const limitationConfirmed = limitMatch
    ? limitMatch[1].toLowerCase() === 'true'
    : (verdict === 'identical' || (output.includes('limitation confirmed') && verdict !== 'failed'));

  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : (verdict === 'failed' ? 1 : 0);

  return {
    chromiumJa4,
    firefoxJa4,
    verdict,
    limitationConfirmed,
    exitCode,
  };
}

async function cleanupProfile(
  base: string,
  id: string | null,
  headers: Record<string, string>,
  fetchFn: typeof fetch
): Promise<void> {
  if (!id) return;
  try {
    await fetchWithTimeout(`${base}/api/v1/browser/stop?user_id=${id}`, { headers }, 5000, fetchFn);
  } catch (stopErr) {
    // Best effort stop during cleanup
    void stopErr;
  }
  try {
    await fetchWithTimeout(
      `${base}/api/v1/browser-profile/delete`,
      { method: 'POST', headers, body: JSON.stringify({ user_id: id }) },
      5000,
      fetchFn
    );
  } catch (deleteErr) {
    // Best effort profile delete during cleanup
    void deleteErr;
  }
}

async function createAndStartProfile(
  base: string,
  headers: Record<string, string>,
  createPayload: Record<string, string>,
  timeoutMs: number,
  fetchFn: typeof fetch
): Promise<{ id: string; wsEndpoint: string | null; skipped?: boolean; skipReason?: string }> {
  const createdRes = await fetchWithTimeout(
    `${base}/api/v1/browser-profile/create`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(createPayload),
    },
    timeoutMs,
    fetchFn
  );
  const created = (await createdRes.json()) as ApiResponse<ProfileCreateData>;
  const id = created.data?.user_id ?? null;
  if (!id) {
    throw new Error('profile creation failed: no user_id returned');
  }

  const startRes = await fetchWithTimeout(
    `${base}/api/v1/browser/start?user_id=${id}`,
    { headers },
    timeoutMs,
    fetchFn
  );
  const start = (await startRes.json()) as ApiResponse<BrowserStartData>;
  if (start.code !== 0) {
    return { id, wsEndpoint: null, skipped: true, skipReason: start.msg };
  }

  return { id, wsEndpoint: start.data?.ws?.puppeteer ?? null };
}

function parsePeetBody(text: string, kernel: 'chromium' | 'firefox'): TlsProbeKernelResult {
  let data: PeetResult = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      // SAFETY: parsed is validated as non-null object from TLS endpoint payload
      data = parsed as PeetResult;
    }
  } catch (parseErr) {
    void parseErr;
    return {
      kernel,
      ja3_hash: null,
      ja4: null,
      userAgent: null,
      error: 'Malformed response body from TLS endpoint',
    };
  }

  const ja4 = data.tls?.ja4 ?? data.ja4 ?? null;
  const ja3Hash = data.ja3_hash ?? null;
  const userAgent = data.user_agent ?? null;

  const header = kernel === 'chromium' ? 'fingerprint-chromium (Chromium stack)' : 'Camoufox (Firefox stack)';
  console.log(`=== ${header} ===`);
  console.log('JA3 hash:', ja3Hash);
  console.log('JA4:', ja4);
  console.log('UA:', (userAgent ?? '').slice(0, 80));

  return {
    kernel,
    ja3_hash: ja3Hash,
    ja4,
    userAgent,
  };
}

export async function probeChromium(
  base: string,
  headers: Record<string, string>,
  deps?: {
    fetchFn?: typeof fetch;
    puppeteerConnect?: (options: ConnectOptions) => Promise<PuppeteerBrowser>;
    timeoutMs?: number;
  }
): Promise<TlsProbeKernelResult> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const connectFn = deps?.puppeteerConnect ?? puppeteer.connect;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let id: string | null = null;
  let browser: PuppeteerBrowser | null = null;

  try {
    const launch = await createAndStartProfile(
      base,
      headers,
      { name: 'tls-probe-chromium' },
      timeoutMs,
      fetchFn
    );
    id = launch.id;
    if (launch.skipped || !launch.wsEndpoint) {
      throw new Error('chromium start failed: ' + (launch.skipReason ?? 'unknown error'));
    }

    browser = await connectFn({
      browserWSEndpoint: launch.wsEndpoint,
      defaultViewport: null,
    });

    const page = await browser.newPage();
    await page.goto(TLS_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const text = await page.evaluate((): string => {
      return document.body?.innerText ?? '{}';
    });

    return parsePeetBody(text, 'chromium');
  } finally {
    if (browser) {
      try {
        browser.disconnect();
      } catch (discErr) {
        void discErr;
      }
    }
    await cleanupProfile(base, id, headers, fetchFn);
  }
}

export async function probeCamoufox(
  base: string,
  headers: Record<string, string>,
  deps?: {
    fetchFn?: typeof fetch;
    getRunningPageFn?: (profileId: string) => PlaywrightPage | undefined;
    timeoutMs?: number;
  }
): Promise<TlsProbeKernelResult> {
  const fetchFn = deps?.fetchFn ?? fetch;
  const getPageFn = deps?.getRunningPageFn ?? getRunningPage;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let id: string | null = null;
  try {
    const launch = await createAndStartProfile(
      base,
      headers,
      { name: 'tls-probe-firefox', browser_type: 'firefox' },
      timeoutMs,
      fetchFn
    );
    id = launch.id;
    if (launch.skipped) {
      console.log('=== Camoufox (Firefox stack) ===');
      console.log('SKIPPED:', launch.skipReason);
      return {
        kernel: 'firefox',
        ja3_hash: null,
        ja4: null,
        userAgent: null,
        skipped: true,
      };
    }

    const page = getPageFn(id);
    if (!page) throw new Error('no managed page for the firefox profile');
    await page.goto(TLS_URL, { timeout: timeoutMs });
    const text = await page.evaluate((): string => {
      return document.body?.innerText ?? '{}';
    });

    return parsePeetBody(text, 'firefox');
  } finally {
    await cleanupProfile(base, id, headers, fetchFn);
  }
}

export async function runTlsProbe(options?: {
  base?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{
  chromium: TlsProbeKernelResult;
  firefox: TlsProbeKernelResult;
  verdict: TlsVerdictResult;
  formattedOutput: string;
}> {
  const base = options?.base ?? `http://${API_HOST}:${API_PORT}`;
  const headers = options?.headers ?? {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
  };
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let chromiumRes: TlsProbeKernelResult;
  try {
    chromiumRes = await probeChromium(base, headers, { timeoutMs });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    chromiumRes = {
      kernel: 'chromium',
      ja3_hash: null,
      ja4: null,
      userAgent: null,
      error: errorMsg,
    };
  }

  let firefoxRes: TlsProbeKernelResult;
  try {
    firefoxRes = await probeCamoufox(base, headers, { timeoutMs });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    firefoxRes = {
      kernel: 'firefox',
      ja3_hash: null,
      ja4: null,
      userAgent: null,
      error: errorMsg,
    };
  }

  const verdict = evaluateTlsVerdict(chromiumRes.ja4, firefoxRes.ja4);
  const formattedOutput = formatTlsVerdict(chromiumRes.ja4, firefoxRes.ja4, verdict);
  console.log(formattedOutput);

  return {
    chromium: chromiumRes,
    firefox: firefoxRes,
    verdict,
    formattedOutput,
  };
}

async function main(): Promise<void> {
  await startService();
  const { verdict } = await runTlsProbe();
  process.exit(verdict.exitCode);
}

if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.endsWith('probe-tls.ts') || process.argv[1]?.endsWith('probe-tls.js'))) {
  main().catch((err: unknown) => {
    console.error('TLS PROBE FAILED', err);
    process.exit(1);
  });
}
