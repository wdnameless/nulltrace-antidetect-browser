// Script Engine (Sprint 4.1): sandboxed JS execution over the Local API.
//
// Isolation model:
//   - Each run executes inside a worker_threads Worker (hard kill via
//     terminate() after SCRIPT_TIMEOUT_MS) whose main file creates a
//     node:vm context containing ONLY the `app` facade + standard JS globals.
//   - No require/process/fs/child_process/net in the context: the worker file
//     never passes them into vm.createContext, and the script code cannot
//     reach the worker's own module scope.
//   - app.http.fetch is an http/https wrapper with a per-call timeout and a
//     hard budget of 100 calls per run; it attaches the app's Bearer key.
//   - app.keys.get returns values only into worker memory (preloaded from the
//     encrypted store); key writes are flushed back to main on finish. The
//     engine itself never logs key values — only what the script logs.
//   - One worker per profile run; at most MAX_WORKERS concurrent, extra runs
//     wait in a FIFO queue.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { Worker } from 'worker_threads';
import { getDb } from '../db';
import { API_HOST, API_PORT, getApiKey } from '../config';
import { logger } from '../util/logger';
import { listKeys, getKeyValueForScript, setKeyValue } from './keyStore';
import {
  verifyScriptModule,
  getDefaultKeyRing,
  ArtifactVerificationResult,
  SecurityPolicyOptions,
} from '../security/enforcement';
import { KeyRingStore, SignedManifestEnvelope } from '../security/signing';
import puppeteer from 'puppeteer-core';
import { isUserInControl } from '../api/routes/handoff';
import { captureSnapshot } from '../automation/snapshot';
import { resolveSelector } from '../automation/selectors';
import { motionSessions } from '../motion/session';
import { getRunningWs } from '../launcher/chromium';

export interface BrowserLike {
  pages?: () => Promise<PageLike[]>;
  newPage?: () => Promise<PageLike>;
  disconnect?: () => Promise<void>;
  [key: string]: unknown;
}

export interface PageLike {
  goto?: (url: string, opts?: Record<string, unknown>) => Promise<{ status?: () => number; [key: string]: unknown } | unknown>;
  url?: () => string;
  title?: () => Promise<string>;
  click?: (selector: string, opts?: Record<string, unknown>) => Promise<unknown>;
  fill?: (selector: string, value: string, opts?: Record<string, unknown>) => Promise<unknown>;
  type?: (selector: string, value: string, opts?: Record<string, unknown>) => Promise<unknown>;
  focus?: (selector: string) => Promise<unknown>;
  waitForSelector?: (selector: string, opts?: Record<string, unknown>) => Promise<unknown>;
  waitForFunction?: (fn: string | ((...args: unknown[]) => unknown), opts?: Record<string, unknown>, ...args: unknown[]) => Promise<unknown>;
  waitForNetworkIdle?: (opts?: Record<string, unknown>) => Promise<unknown>;
  screenshot?: (opts?: Record<string, unknown>) => Promise<string | Buffer>;
  evaluate?: (fn: unknown, ...args: unknown[]) => Promise<unknown>;
  close?: () => Promise<void>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  mouse?: {
    move: (x: number, y: number) => Promise<void>;
    click: (x: number, y: number, opts?: Record<string, unknown>) => Promise<void>;
    down: (opts?: Record<string, unknown>) => Promise<void>;
    up: (opts?: Record<string, unknown>) => Promise<void>;
  };
  keyboard?: {
    down: (key: string) => Promise<void>;
    up: (key: string) => Promise<void>;
  };
  $?: (selector: string) => Promise<{ click?: (opts?: Record<string, unknown>) => Promise<void>; boundingBox?: () => Promise<{ x: number; y: number; width: number; height: number } | null> } | null>;
  [key: string]: unknown;
}

export type BrowserProvider = (profileId: string) => Promise<BrowserLike> | BrowserLike;
let mockBrowserProvider: BrowserProvider | null = null;
const mockBrowserMap = new Map<string, BrowserLike>();

export function setMockBrowserProvider(provider: BrowserProvider | null): void {
  mockBrowserProvider = provider;
  profileSessions.clear();
}

export function registerMockBrowser(profileId: string, browser: BrowserLike): void {
  mockBrowserMap.set(profileId, browser);
  profileSessions.delete(profileId);
}

export function unregisterMockBrowser(profileId: string): void {
  mockBrowserMap.delete(profileId);
  profileSessions.delete(profileId);
}

interface DialogHandleLike {
  type?: () => string;
  message?: () => string;
  accept?: (text?: string) => Promise<void>;
  dismiss?: () => Promise<void>;
  [key: string]: unknown;
}

interface ProfileSessionState {
  pages: Map<string, PageLike>;
  nextPageNum: number;
  recentPopups: Array<{ label: string }>;
  currentDialog: { type: string; message: string; handle?: DialogHandleLike } | null;
}
const profileSessions = new Map<string, ProfileSessionState>();

function getOrCreateSession(profileId: string): ProfileSessionState {
  let sess = profileSessions.get(profileId);
  if (!sess) {
    sess = {
      pages: new Map(),
      nextPageNum: 1,
      recentPopups: [],
      currentDialog: null,
    };
    profileSessions.set(profileId, sess);
  }
  return sess;
}

function attachPageListeners(sess: ProfileSessionState, page: PageLike, _label: string): void {
  if (page && typeof page.on === 'function') {
    try {
      page.on('dialog', (dialog: unknown) => {
        const d = dialog as DialogHandleLike | undefined;
        sess.currentDialog = {
          type: typeof d?.type === 'function' ? d.type() : String(d?.type || 'alert'),
          message: typeof d?.message === 'function' ? d.message() : String(d?.message || ''),
          handle: d,
        };
      });
      page.on('popup', (popup: unknown) => {
        const nextLabel = `p${++sess.nextPageNum}`;
        const p = popup as PageLike;
        sess.pages.set(nextLabel, p);
        sess.recentPopups.push({ label: nextLabel });
        attachPageListeners(sess, p, nextLabel);
      });
    } catch {}
  }
}

async function getBrowserForProfile(profileId: string): Promise<BrowserLike> {
  if (mockBrowserMap.has(profileId)) {
    return mockBrowserMap.get(profileId)!;
  }
  if (mockBrowserProvider) {
    return await mockBrowserProvider(profileId);
  }
  const ws = getRunningWs(profileId);
  if (!ws) {
    throw new Error(`Browser not running for profile: ${profileId}`);
  }
  return (await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null })) as unknown as BrowserLike;
}

async function getPageForProfile(profileId: string, pageLabel?: string): Promise<{ page: PageLike; label: string; session: ProfileSessionState }> {
  const sess = getOrCreateSession(profileId);
  const browser = await getBrowserForProfile(profileId);
  const targetLabel = pageLabel || 'p1';

  let page = sess.pages.get(targetLabel);
  if (!page) {
    let pagesList: PageLike[] = [];
    if (typeof browser.pages === 'function') {
      try {
        pagesList = await browser.pages();
      } catch {}
    }
    if (pagesList.length > 0 && targetLabel === 'p1') {
      page = pagesList[0];
    } else if (typeof browser.newPage === 'function') {
      page = await browser.newPage();
    } else {
      page = browser as unknown as PageLike;
    }
    sess.pages.set(targetLabel, page);
    attachPageListeners(sess, page, targetLabel);
  }
  return { page, label: targetLabel, session: sess };
}

const MUTATING_OPCODES: Record<string, true> = {
  'browser.goto': true,
  'browser.navigate': true,
  'browser.click': true,
  'browser.fill': true,
  'browser.type': true,
  'browser.newPage': true,
  'browser.close': true,
  'browser.acceptDialog': true,
  'browser.dismissDialog': true,
  'motion.click': true,
  'motion.type': true,
  'browser.snapshot': true,
};

function buildReceipt(session: ProfileSessionState) {
  const receipt = {
    ok: true as const,
    popups: [...session.recentPopups],
    dialog: session.currentDialog ? { type: session.currentDialog.type, message: session.currentDialog.message } : null,
  };
  session.recentPopups = [];
  return receipt;
}

export interface RpcPayload {
  url?: string;
  selector?: string;
  value?: string;
  text?: string;
  fn?: string;
  arg?: unknown;
  state?: string;
  label?: string;
  timeout?: number;
  opts?: {
    timeout?: number;
    waitUntil?: string;
    pageLabel?: string;
    scope?: 'viewport' | 'full_page' | 'subtree';
    root?: string;
    clear?: boolean;
    fullPage?: boolean;
    allowTypos?: boolean;
    clickCount?: number;
    button?: 'left' | 'right' | 'middle';
    targetWidth?: number;
    x?: number;
    y?: number;
  };
}

export async function handleRpcRequest(opcode: string, profileId: string, args?: RpcPayload): Promise<unknown> {
  if (MUTATING_OPCODES[opcode] && isUserInControl(profileId)) {
    return {
      error: 'profile is under user control',
      error_code: 'USER_IN_CONTROL',
    };
  }

  switch (opcode) {
    case 'browser.goto':
    case 'browser.navigate': {
      const { page } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const url = String(args?.url || '');
      let status: number | null = 200;
      if (typeof page.goto === 'function') {
        const resp = (await page.goto(url, {
          timeout: args?.opts?.timeout ?? 30000,
          waitUntil: args?.opts?.waitUntil ?? 'domcontentloaded',
        })) as { status?: () => number; [key: string]: unknown } | null;
        if (resp && typeof resp.status === 'function') {
          status = resp.status();
        } else if (resp && typeof (resp as Record<string, unknown>).status === 'number') {
          status = (resp as Record<string, unknown>).status as number;
        }
      }
      const finalUrl = typeof page.url === 'function' ? page.url() : url;
      return { url: finalUrl, status };
    }

    case 'browser.snapshot': {
      const { page, label } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      return await captureSnapshot(profileId, page, {
        scope: args?.opts?.scope,
        root: args?.opts?.root,
        pageLabel: label,
      });
    }

    case 'browser.click': {
      const { page, label, session } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const sel = String(args?.selector || '');
      let resolved: { box?: { x: number; y: number; width: number; height: number } } | null = null;
      try {
        resolved = await resolveSelector(page, sel, profileId, label);
      } catch (e) {
        if (!page.click && !page.$) throw e;
      }

      if (typeof page.click === 'function') {
        try {
          await page.click(sel, { timeout: args?.opts?.timeout ?? 10000 });
        } catch {
          if (resolved?.box && page.mouse && typeof page.mouse.click === 'function') {
            await page.mouse.click(resolved.box.x + resolved.box.width / 2, resolved.box.y + resolved.box.height / 2);
          }
        }
      } else if (resolved?.box && page.mouse && typeof page.mouse.click === 'function') {
        await page.mouse.click(resolved.box.x + resolved.box.width / 2, resolved.box.y + resolved.box.height / 2);
      }

      return buildReceipt(session);
    }

    case 'browser.fill':
    case 'browser.type': {
      const { page, label } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const sel = String(args?.selector || '');
      const val = String(args?.value ?? args?.text ?? '');
      try {
        await resolveSelector(page, sel, profileId, label);
      } catch (e) {
        if (!page.fill && !page.type) throw e;
      }
      if (typeof page.fill === 'function') {
        await page.fill(sel, val);
      } else if (typeof page.type === 'function') {
        if (args?.opts?.clear && page.$) {
          const el = await page.$(sel);
          if (el && typeof el.click === 'function') await el.click({ clickCount: 3 });
        }
        await page.type(sel, val);
      }
      return { filled: true, typed: true };
    }

    case 'browser.waitForSelector': {
      const { page, label } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const sel = String(args?.selector || '');
      const timeout = Number(args?.opts?.timeout) || 10000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try {
          const res = await resolveSelector(page, sel, profileId, label);
          if (res) return { ok: true };
        } catch {
          if (typeof page.waitForSelector === 'function') {
            try {
              await page.waitForSelector(sel, { timeout: 200 });
              return { ok: true };
            } catch {}
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timeout waiting for selector "${sel}" after ${timeout}ms`);
    }

    case 'browser.waitForURL': {
      const { page } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const target = String(args?.url || '');
      const timeout = Number(args?.opts?.timeout) || 10000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const current = typeof page.url === 'function' ? page.url() : '';
        if (current.includes(target) || current === target) return { ok: true };
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timeout waiting for URL "${target}" after ${timeout}ms`);
    }

    case 'browser.waitForFunction': {
      const { page } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const fnStr = String(args?.fn || '');
      const timeout = Number(args?.opts?.timeout) || 10000;
      if (typeof page.waitForFunction === 'function') {
        await page.waitForFunction(fnStr, { timeout }, args?.arg);
        return { ok: true };
      }
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try {
          const ok = await page.evaluate?.(new Function('arg', `return (${fnStr})(arg)`), args?.arg);
          if (ok) return { ok: true };
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timeout waiting for function after ${timeout}ms`);
    }

    case 'browser.waitForLoadState': {
      const { page } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const timeout = Number(args?.opts?.timeout) || 10000;
      if (typeof page.waitForNetworkIdle === 'function' && args?.state === 'networkidle') {
        await page.waitForNetworkIdle({ timeout });
      } else if (typeof page.evaluate === 'function') {
        await page.evaluate(new Function('return document.readyState === "complete"'));
      }
      return { ok: true };
    }

    case 'browser.screenshot': {
      const { page } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      let base64 = '';
      if (typeof page.screenshot === 'function') {
        const buf = await page.screenshot({
          fullPage: Boolean(args?.opts?.fullPage),
          encoding: 'base64',
        });
        base64 = typeof buf === 'string' ? buf : (buf ? buf.toString('base64') : '');
      }
      return { base64, cssScale: true };
    }

    case 'browser.evaluate': {
      const { page } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const fnStr = String(args?.fn || '');
      const timeout = Number(args?.timeout) || 10000;
      const evalPromise = (async () => {
        if (typeof page.evaluate === 'function') {
          return await page.evaluate(
            (code: string, argVal: unknown) => {
              let fn;
              try {
                fn = new Function('arg', `return (${code})(arg);`);
                return fn(argVal);
              } catch {
                const expr = new Function('arg', `return (${code});`);
                return expr(argVal);
              }
            },
            fnStr,
            args?.arg
          );
        }
        return undefined;
      })();

      const timerPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`evaluate exceeded ${timeout}ms timeout`)), timeout);
      });

      const raw = await Promise.race([evalPromise, timerPromise]);
      return raw !== undefined ? JSON.parse(JSON.stringify(raw)) : undefined;
    }

    case 'browser.tabs': {
      const sess = getOrCreateSession(profileId);
      await getBrowserForProfile(profileId);
      const labels: Array<{ label: string; url: string; title?: string }> = [];
      for (const [lbl, p] of sess.pages.entries()) {
        const url = typeof p.url === 'function' ? p.url() : '';
        let title = '';
        if (typeof p.title === 'function') {
          try { title = await p.title(); } catch {}
        }
        labels.push({ label: lbl, url, title });
      }
      if (labels.length === 0) {
        labels.push({ label: 'p1', url: '', title: '' });
      }
      return labels;
    }

    case 'browser.newPage': {
      const sess = getOrCreateSession(profileId);
      const browser = await getBrowserForProfile(profileId);
      const newP: PageLike = typeof browser.newPage === 'function' ? await browser.newPage() : (browser as unknown as PageLike);
      const label = `p${++sess.nextPageNum}`;
      sess.pages.set(label, newP);
      attachPageListeners(sess, newP, label);
      return { label };
    }

    case 'browser.close': {
      const sess = getOrCreateSession(profileId);
      const label = args?.label || 'p1';
      const page = sess.pages.get(label);
      if (page && typeof page.close === 'function') {
        try { await page.close(); } catch {}
      }
      sess.pages.delete(label);
      return { ok: true };
    }

    case 'browser.acceptDialog': {
      const sess = getOrCreateSession(profileId);
      if (sess.currentDialog?.handle && typeof sess.currentDialog.handle.accept === 'function') {
        await sess.currentDialog.handle.accept(args?.text);
      }
      sess.currentDialog = null;
      return { ok: true };
    }

    case 'browser.dismissDialog': {
      const sess = getOrCreateSession(profileId);
      if (sess.currentDialog?.handle && typeof sess.currentDialog.handle.dismiss === 'function') {
        await sess.currentDialog.handle.dismiss();
      }
      sess.currentDialog = null;
      return { ok: true };
    }

    case 'motion.click': {
      const { page, label, session } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const sel = String(args?.selector || '');
      let resolved: { box?: { x: number; y: number; width: number; height: number } } | null = null;
      try {
        resolved = await resolveSelector(page, sel, profileId, label);
      } catch (e) {
        if (!page.mouse) throw e;
      }
      let toX = args?.opts?.x;
      let toY = args?.opts?.y;
      let targetWidth = args?.opts?.targetWidth ?? 32;
      if (typeof toX !== 'number' || typeof toY !== 'number') {
        if (resolved?.box) {
          toX = resolved.box.x + resolved.box.width / 2;
          toY = resolved.box.y + resolved.box.height / 2;
          targetWidth = resolved.box.width || 32;
        } else {
          toX = 100;
          toY = 100;
        }
      }
      if (!motionSessions.hasPointer(profileId)) {
        motionSessions.createPointer(profileId, { startX: 0, startY: 0 });
      }
      const { plan } = motionSessions.glideTo(profileId, { x: toX, y: toY }, targetWidth);
      if (page.mouse && typeof page.mouse.move === 'function') {
        for (const move of plan.moves) {
          await page.mouse.move(move.x, move.y);
        }
      }
      const tapResult = motionSessions.tap(profileId, {
        clickCount: args?.opts?.clickCount ?? 1,
        button: args?.opts?.button ?? 'left',
      });
      if (page.mouse && typeof page.mouse.down === 'function') {
        await page.mouse.down({ button: tapResult.button });
        await page.mouse.up({ button: tapResult.button });
      }
      return buildReceipt(session);
    }

    case 'motion.type': {
      const { page, label } = await getPageForProfile(profileId, args?.opts?.pageLabel);
      const sel = String(args?.selector || '');
      const text = String(args?.text || '');
      try {
        await resolveSelector(page, sel, profileId, label);
      } catch (e) {
        if (!page.keyboard) throw e;
      }
      if (typeof page.focus === 'function') {
        try { await page.focus(sel); } catch {}
      }
      if (!motionSessions.hasPointer(profileId)) {
        motionSessions.createPointer(profileId, { startX: 0, startY: 0 });
      }
      const { plan } = motionSessions.enterText(profileId, text, Boolean(args?.opts?.allowTypos));
      if (page.keyboard && typeof page.keyboard.down === 'function') {
        for (const key of plan.keys) {
          if (key.type === 'down') {
            await page.keyboard.down(key.key);
          } else {
            await page.keyboard.up(key.key);
          }
        }
      }
      return { ok: true, typed: true };
    }

    default:
      throw new Error(`Unknown RPC opcode: ${opcode}`);
  }
}

export const SCRIPT_TIMEOUT_MS = 60_000;
export const MAX_HTTP_CALLS = 100;
export const MAX_WORKERS = 5;
export const HTTP_CALL_TIMEOUT_MS = 15_000;

export interface ScriptRow {
  id: string;
  name: string;
  code: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_status: string | null;
}

export interface ScriptRunRow {
  id: string;
  script_id: string;
  profile_ids: string[];
  status: 'running' | 'done' | 'error' | 'timeout';
  log: string;
  started_at: number;
  finished_at: number | null;
}

interface ActiveRun {
  runId: string;
  worker: Worker;
  timer: ReturnType<typeof setTimeout>;
  profileId: string;
}

const activeRuns = new Map<string, ActiveRun>();
const queue: Array<{ scriptId: string; code: string; runId: string; profileId: string }> = [];

// ---------------------------------------------------------------------------
// Worker source (inline via eval:true; only worker_threads + vm + http/https
// are required INSIDE the worker — the sandbox context never sees them).
// ---------------------------------------------------------------------------

const WORKER_SOURCE = `
const { workerData, parentPort } = require('worker_threads');
const vm = require('node:vm');
const http = require('http');
const https = require('https');

const cfg = workerData; // { code, profileId, apiBase, apiKey, maxHttpCalls, httpTimeoutMs, keyValues }
let httpCalls = 0;
const logs = [];

/** Node http(s) request with a hard timeout; resolves {status, data}. */
function rawRequest(urlStr, opts) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('invalid url')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { reject(new Error('only http/https allowed')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign(
      { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
      (opts && opts.headers) || {}
    );
    const req = mod.request(u, { method: (opts && opts.method) || 'GET', headers, timeout: cfg.httpTimeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 262144) chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('http call timeout')));
    req.on('error', reject);
    if (opts && opts.body != null) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function api(pathAndQuery, opts) {
  return rawRequest(cfg.apiBase + pathAndQuery, opts);
}

let rpcSeq = 0;
let rpcPendingCount = 0;
const pendingRpc = Object.create(null);
if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'rpc_reply' && pendingRpc[msg.id]) {
      const entry = pendingRpc[msg.id];
      delete pendingRpc[msg.id];
      rpcPendingCount--;
      if (rpcPendingCount <= 0 && typeof parentPort.unref === 'function') {
        rpcPendingCount = 0;
        parentPort.unref();
      }
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        const err = new Error(msg.error || 'RPC error');
        if (msg.error_code) err.code = msg.error_code;
        entry.reject(err);
      }
    }
  });
  if (typeof parentPort.unref === 'function') {
    parentPort.unref();
  }
}

function rpc(opcode, args) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const id = ++rpcSeq;
  pendingRpc[id] = { resolve, reject };
  rpcPendingCount++;
  if (parentPort && typeof parentPort.ref === 'function') {
    parentPort.ref();
  }
  let safeArgs = {};
  if (args !== undefined) {
    try { safeArgs = JSON.parse(JSON.stringify(args)); } catch (e) { safeArgs = {}; }
  }
  parentPort.postMessage({ type: 'rpc', id, opcode, args: safeArgs });
  return promise;
}

/** app facade — the ONLY surface the script sees. */
const app = {
  profileId: cfg.profileId,
  profiles: {
    list: async (params) => {
      const q = new URLSearchParams(Object.entries(params || {}).map(([k, v]) => [k, String(v)]));
      const r = await api('/api/v1/browser/list?' + q.toString(), { method: 'GET' });
      return r.data;
    },
    get: async (id) => {
      const r = await api('/api/v1/browser-profile/detail?user_id=' + encodeURIComponent(String(id)), { method: 'GET' });
      return r.data;
    },
    start: async (id) => {
      const r = await api('/api/v1/browser/start?user_id=' + encodeURIComponent(String(id)), { method: 'GET' });
      return r.data;
    },
    stop: async (id) => {
      const r = await api('/api/v1/browser/stop?user_id=' + encodeURIComponent(String(id)), { method: 'POST', body: {} });
      return r.data;
    },
  },
  proxy: {
    list: async () => {
      const r = await api('/api/v1/proxy/list', { method: 'GET' });
      return r.data;
    },
  },
  keys: {
    get: (key) => cfg.keyValues[key],
    set: (key, value) => { cfg.keyValues[key] = String(value); },
  },
  callModule: async (name, args) => {
    if (httpCalls >= cfg.maxHttpCalls) throw new Error('http call budget exceeded (' + cfg.maxHttpCalls + ')');
    httpCalls++;
    const r = await api('/api/v1/scripts/' + encodeURIComponent(String(name)) + '/invoke', {
      method: 'POST',
      body: { args: args || {} },
    });
    if (r.status !== 200 || !r.data || r.data.code !== 0) {
      const errDetail = (r.data && (r.data.error || r.data.msg)) || ('HTTP ' + r.status);
      const err = new Error('Module call failed: ' + errDetail);
      err.code = (r.data && r.data.code) || 'MODULE_CALL_FAILED';
      throw err;
    }
    return r.data.data ? r.data.data.result : undefined;
  },
  http: {
    fetch: async (url, opts) => {
      if (httpCalls >= cfg.maxHttpCalls) throw new Error('http call budget exceeded (' + cfg.maxHttpCalls + ')');
      httpCalls++;
      return rawRequest(String(url), opts || {});
    },
  },
  // Persona + form filling (parity: form-filling-helper). The sandbox has no CDP
  // access, so every call is proxied to the authenticated Local API, which performs
  // the real keystroke-level fill on the running profile.
  persona: {
    get: async () => {
      if (httpCalls >= cfg.maxHttpCalls) throw new Error('http call budget exceeded (' + cfg.maxHttpCalls + ')');
      httpCalls++;
      const r = await api('/api/v1/persona?profile_id=' + encodeURIComponent(String(cfg.profileId)), { method: 'GET' });
      if (r.status !== 200 || !r.data || r.data.code !== 0) {
        const detail = (r.data && (r.data.msg || r.data.error)) || ('HTTP ' + r.status);
        throw new Error('Persona fetch failed: ' + detail);
      }
      return r.data.data ? (r.data.data.persona || r.data.data) : undefined;
    },
    fillForm: async (mapping, opts) => {
      if (httpCalls >= cfg.maxHttpCalls) throw new Error('http call budget exceeded (' + cfg.maxHttpCalls + ')');
      httpCalls++;
      const r = await api('/api/v1/persona/fill', {
        method: 'POST',
        body: { profile_id: cfg.profileId, mapping: mapping || {}, clear_first: Boolean(opts && opts.clearFirst) },
      });
      if (r.status !== 200 || !r.data || r.data.code !== 0) {
        const detail = (r.data && (r.data.msg || r.data.error)) || ('HTTP ' + r.status);
        const err = new Error('Form fill failed: ' + detail);
        err.code = (r.data && r.data.code) || 'FORM_FILL_FAILED';
        throw err;
      }
      return r.data.data;
    },
  },
  browser: {
    goto: (url, opts) => rpc('browser.goto', { url: String(url ?? ''), opts }),
    navigate: (url, opts) => rpc('browser.navigate', { url: String(url ?? ''), opts }),
    snapshot: (opts) => rpc('browser.snapshot', { opts }),
    click: (selector, opts) => rpc('browser.click', { selector: String(selector ?? ''), opts }),
    fill: (selector, value, opts) => rpc('browser.fill', { selector: String(selector ?? ''), value: String(value ?? ''), opts }),
    type: (selector, text, opts) => rpc('browser.type', { selector: String(selector ?? ''), text: String(text ?? ''), opts }),
    waitForSelector: (selector, opts) => rpc('browser.waitForSelector', { selector: String(selector ?? ''), opts }),
    waitForURL: (url, opts) => rpc('browser.waitForURL', { url: String(url ?? ''), opts }),
    waitForFunction: (fn, opts, arg) => rpc('browser.waitForFunction', { fn: typeof fn === 'function' ? fn.toString() : String(fn ?? ''), opts, arg }),
    waitForLoadState: (state, opts) => rpc('browser.waitForLoadState', { state: state ? String(state) : 'load', opts }),
    screenshot: (opts) => rpc('browser.screenshot', { opts }),
    evaluate: (fn, arg, opts) => rpc('browser.evaluate', { fn: typeof fn === 'function' ? fn.toString() : String(fn ?? ''), arg, timeout: opts && opts.timeout, opts }),
    tabs: () => rpc('browser.tabs', {}),
    newPage: () => rpc('browser.newPage', {}),
    close: (label) => rpc('browser.close', { label: label ? String(label) : undefined }),
    acceptDialog: (text) => rpc('browser.acceptDialog', { text: text !== undefined ? String(text) : undefined }),
    dismissDialog: () => rpc('browser.dismissDialog', {}),
  },
  motion: {
    click: (selector, opts) => rpc('motion.click', { selector: String(selector ?? ''), opts }),
    type: (selector, text, opts) => rpc('motion.type', { selector: String(selector ?? ''), text: String(text ?? ''), opts }),
  },
  log: (msg) => {
    const line = String(msg);
    logs.push(line);
    try { parentPort.postMessage({ type: 'log', message: line }); } catch {}
  },
};

async function main() {
  try {
    const context = vm.createContext({
      app,
      console: { log: app.log, error: app.log, warn: app.log, info: app.log },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 30000)),
      clearTimeout,
      Promise, Date, Math, JSON, Object, Array, String, Number, Boolean,
      Map, Set, WeakMap, WeakSet, RegExp, Error, TypeError, RangeError, SyntaxError,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
      URL, URLSearchParams, isNaN, isFinite, parseInt, parseFloat, BigInt,
    });
    const result = await vm.runInContext(cfg.code, context, { timeout: 55000 });
    let out = null;
    if (result !== undefined) {
      try { out = JSON.parse(JSON.stringify(result)); } catch (e) { out = String(result); }
    }
    parentPort.postMessage({ type: 'done', result: out, logs, keyValues: cfg.keyValues });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: String((e && e.message) || e), logs, keyValues: cfg.keyValues });
  }
}

main();
`;

// ---------------------------------------------------------------------------
// Scripts CRUD
// ---------------------------------------------------------------------------

export function listScripts(): ScriptRow[] {
  return getDb()
    .prepare('SELECT * FROM scripts ORDER BY updated_at DESC')
    .all() as unknown as ScriptRow[];
}

export function getScript(id: string): ScriptRow | undefined {
  return getDb().prepare('SELECT * FROM scripts WHERE id = ?').get(id) as unknown as ScriptRow | undefined;
}

export function createScript(name: string, code: string): { id: string } {
  const id = 'scr_' + randomUUID();
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO scripts (id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, code, now, now);
  return { id };
}

export function updateScript(id: string, updates: { name?: string; code?: string }): boolean {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.code !== undefined) { sets.push('code = ?'); params.push(updates.code); }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  params.push(Date.now(), id);
  return (
    getDb()
      .prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params).changes > 0
  );
}

export function deleteScript(id: string): boolean {
  const res = getDb().prepare('DELETE FROM scripts WHERE id = ?').run(id);
  if (res.changes > 0) {
    getDb().prepare('DELETE FROM script_runs WHERE script_id = ?').run(id);
    getDb().prepare('DELETE FROM triggers WHERE script_id = ?').run(id);
  }
  return res.changes > 0;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function listRuns(scriptId: string): ScriptRunRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM script_runs WHERE script_id = ? ORDER BY started_at DESC LIMIT 50')
    .all(scriptId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    script_id: String(r.script_id),
    profile_ids: safeParseArray(String(r.profile_ids ?? '[]')),
    status: String(r.status) as ScriptRunRow['status'],
    log: String(r.log ?? ''),
    started_at: Number(r.started_at) || 0,
    finished_at: (r.finished_at as number | null) ?? null,
  }));
}

export interface RunHandle {
  run_ids: string[];
  queued: number;
}

/** Preload every global key into worker memory (plaintext never hits logs). */
function preloadKeyValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of listKeys()) {
    const value = getKeyValueForScript(item.key);
    if (value !== undefined) out[item.key] = value;
  }
  return out;
}

/**
 * Start a script run across profiles: one worker per profile, FIFO queue with
 * at most MAX_WORKERS concurrent workers. Returns immediately.
 */
export function runScript(
  scriptId: string,
  profileIds: string[],
  options?: {
    manifestEnvelope?: SignedManifestEnvelope | null;
    modulePath?: string;
    keyRing?: KeyRingStore;
    policyOpts?: SecurityPolicyOptions;
  }
): RunHandle {
  const script = getScript(scriptId);
  if (!script) throw new Error('script not found');

  const keyRing = options?.keyRing ?? getDefaultKeyRing();
  const modulePath = options?.modulePath ?? script.name ?? scriptId;
  const envelope = options?.manifestEnvelope ?? null;
  const verification = verifyScriptModule(scriptId, modulePath, envelope, keyRing, {
    logger,
    ...options?.policyOpts,
  });

  if (!verification.allowed) {
    logger.error(`[AUDIT REFUSAL] Refused execution of script module '${scriptId}': signature verification failed`, {
      scriptId,
      reason: verification.reason,
      auditRecord: verification.auditRecord,
    });
    throw new Error(`Execution refused for script '${scriptId}': ${verification.reason}`);
  }

  const runIds: string[] = [];
  let queued = 0;
  for (const pid of profileIds) {
    const runId = 'run_' + randomUUID();
    getDb()
      .prepare('INSERT INTO script_runs (id, script_id, profile_ids, status, log, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, scriptId, JSON.stringify([pid]), 'running', '', Date.now());
    runIds.push(runId);
    if (activeRuns.size < MAX_WORKERS) {
      startWorker(scriptId, script.code, runId, pid);
    } else {
      queue.push({ scriptId, code: script.code, runId, profileId: pid });
      queued++;
    }
  }
  getDb()
    .prepare('UPDATE scripts SET last_run_at = ?, last_status = ? WHERE id = ?')
    .run(Date.now(), 'running', scriptId);
  return { run_ids: runIds, queued };
}

function startWorker(scriptId: string, code: string, runId: string, profileId: string): void {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      code,
      profileId,
      apiBase: `http://${API_HOST}:${API_PORT}`,
      apiKey: getApiKey(),
      maxHttpCalls: MAX_HTTP_CALLS,
      httpTimeoutMs: HTTP_CALL_TIMEOUT_MS,
      keyValues: preloadKeyValues(),
    },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
  });

  const timer = setTimeout(() => {
    // Hard stop: infinite loops never yield to the vm statement timeout.
    void worker.terminate();
    finishRun(runId, 'timeout', 'script exceeded 60s timeout');
  }, SCRIPT_TIMEOUT_MS);

  activeRuns.set(runId, { runId, worker, timer, profileId });

  worker.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'rpc') {
      dispatchWorkerRpc(worker, profileId, msg);
      return;
    }
    if (msg.type === 'log') {
      return;
    }
    const logs = Array.isArray(msg.logs) ? msg.logs.join('\n') : '';
    if (msg.type === 'done') {
      flushKeyWrites(msg.keyValues);
      finishRun(runId, 'done', logs || 'ok');
    } else {
      finishRun(runId, 'error', [msg.error ?? 'script error', logs].filter(Boolean).join('\n'));
    }
  });

  worker.on('error', (err: Error) => {
    finishRun(runId, 'error', `worker error: ${err.message}`);
  });

  worker.on('exit', (exitCode: number) => {
    if (exitCode !== 0 && activeRuns.has(runId)) {
      finishRun(runId, 'error', `worker exited with code ${exitCode}`);
    }
  });

  logger.info('script run started', { scriptId, runId, profileId });
}

/** Persist key writes made by the script (app.keys.set). */
function flushKeyWrites(keyValues: Record<string, string> | undefined): void {
  if (!keyValues) return;
  for (const [key, value] of Object.entries(keyValues)) {
    if (getKeyValueForScript(key) !== value) {
      setKeyValue(key, value);
    }
  }
}
interface WorkerMessage {
  type: string;
  id?: number;
  opcode?: string;
  args?: RpcPayload;
  message?: string;
  error?: string;
  logs?: string[];
  keyValues?: Record<string, string>;
  result?: unknown;
}

function dispatchWorkerRpc(worker: Worker, profileId: string, msg: WorkerMessage): void {
  const rpcId = msg.id;
  const opcode = String(msg.opcode || '');
  void handleRpcRequest(opcode, profileId, msg.args).then(
    (result) => {
      try {
        worker.postMessage({ type: 'rpc_reply', id: rpcId, ok: true, result });
      } catch {}
    },
    (err: unknown) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      try {
        worker.postMessage({ type: 'rpc_reply', id: rpcId, ok: false, error: errorMsg });
      } catch {}
    }
  );
}


function finishRun(runId: string, status: 'done' | 'error' | 'timeout', log: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  clearTimeout(run.timer);
  try {
    void run.worker.terminate();
  } catch {
    // already gone
  }
  activeRuns.delete(runId);
  getDb()
    .prepare('UPDATE script_runs SET status = ?, log = ?, finished_at = ? WHERE id = ?')
    .run(status, log.slice(0, 65536), Date.now(), runId);

  const scriptId = (
    getDb().prepare('SELECT script_id FROM script_runs WHERE id = ?').get(runId) as
      | { script_id: string }
      | undefined
  )?.script_id;
  if (scriptId) {
    getDb()
      .prepare('UPDATE scripts SET last_status = ? WHERE id = ?')
      .run(status, scriptId);
  }

  logger.info('script run finished', { runId, status });

  // Pull the next queued run.
  const next = queue.shift();
  if (next) startWorker(next.scriptId, next.code, next.runId, next.profileId);
}

/** Stop every active worker (service shutdown). */
export function stopAllWorkers(): void {
  for (const run of Array.from(activeRuns.values())) {
    clearTimeout(run.timer);
    try {
      void run.worker.terminate();
    } catch {
      // ignore
    }
  }
}

export function activeWorkerCount(): number {
  return activeRuns.size;
}

export function queuedRunCount(): number {
  return queue.length;
}

export interface TaskInvocationHandle {
  taskUuid: string;
  logStream: EventEmitter; // emits 'log' (line: string), 'done' ({ result?: unknown; logs: string[] }), 'error' ({ error: string; logs: string[] })
  terminate: () => Promise<void>;
}

export interface InvokeScriptTaskOptions {
  taskUuid?: string;
  scriptId?: string;
  code?: string;
  profileId: string;
  timeoutMs?: number;
  manifestEnvelope?: SignedManifestEnvelope | null;
  modulePath?: string;
  keyRing?: KeyRingStore;
  policyOpts?: SecurityPolicyOptions;
}

export function invokeScriptTask(opts: InvokeScriptTaskOptions): TaskInvocationHandle {
  const taskUuid = opts.taskUuid || randomUUID();
  let scriptCode = opts.code;
  const scriptId = opts.scriptId || taskUuid;
  if (!scriptCode && opts.scriptId) {
    const script = getScript(opts.scriptId);
    if (!script) throw new Error(`script not found: ${opts.scriptId}`);
    scriptCode = script.code;
  }
  if (!scriptCode) {
    throw new Error('either code or valid scriptId must be provided');
  }

  const keyRing = opts.keyRing ?? getDefaultKeyRing();
  const modulePath = opts.modulePath ?? scriptId;
  const envelope = opts.manifestEnvelope ?? null;
  const verification = verifyScriptModule(scriptId, modulePath, envelope, keyRing, {
    logger,
    allowUnsignedDev: !opts.manifestEnvelope && !opts.modulePath,
    ...opts.policyOpts,
  });

  if (!verification.allowed) {
    logger.error(`[AUDIT REFUSAL] Refused execution of script task '${scriptId}': signature verification failed`, {
      scriptId,
      taskUuid,
      reason: verification.reason,
      auditRecord: verification.auditRecord,
    });
    throw new Error(`Execution refused for script task '${scriptId}': ${verification.reason}`);
  }
  const logStream = new EventEmitter();
  const capturedLogs: string[] = [];
  const timeoutMs = opts.timeoutMs ?? SCRIPT_TIMEOUT_MS;

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      code: scriptCode,
      profileId: opts.profileId,
      apiBase: `http://${API_HOST}:${API_PORT}`,
      apiKey: getApiKey(),
      maxHttpCalls: MAX_HTTP_CALLS,
      httpTimeoutMs: HTTP_CALL_TIMEOUT_MS,
      keyValues: preloadKeyValues(),
    },
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
  });

  let finished = false;
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    void worker.terminate();
    logStream.emit('error', {
      error: `script exceeded ${timeoutMs}ms timeout`,
      logs: capturedLogs,
    });
  }, timeoutMs);

  worker.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'rpc') {
      dispatchWorkerRpc(worker, opts.profileId, msg);
    } else if (msg.type === 'log') {
      const line = String(msg.message ?? '');
      capturedLogs.push(line);
      logStream.emit('log', line);
    } else if (msg.type === 'done') {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      flushKeyWrites(msg.keyValues);
      const allLogs = Array.isArray(msg.logs) && msg.logs.length > 0 ? msg.logs : capturedLogs;
      logStream.emit('done', { result: msg.result, logs: allLogs });
    } else if (msg.type === 'error') {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      flushKeyWrites(msg.keyValues);
      const allLogs = Array.isArray(msg.logs) && msg.logs.length > 0 ? msg.logs : capturedLogs;
      logStream.emit('error', {
        error: String(msg.error || 'script error'),
        logs: allLogs,
      });
    }
  });

  worker.on('error', (err: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    logStream.emit('error', {
      error: `worker error: ${err.message}`,
      logs: capturedLogs,
    });
  });

  worker.on('exit', (exitCode: number) => {
    if (finished) return;
    if (exitCode !== 0) {
      finished = true;
      clearTimeout(timer);
      logStream.emit('error', {
        error: `worker crashed with exit code ${exitCode}`,
        logs: capturedLogs,
      });
    }
  });

  return {
    taskUuid,
    logStream,
    terminate: async () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
      }
      try {
        await worker.terminate();
      } catch {}
    },
  };
}