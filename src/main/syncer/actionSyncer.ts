// Action Syncer (Sprint 3.2): mirror master actions to slave profiles over CDP.
//
// Event sources (master page session):
//   - Page.frameNavigated        -> navigate slaves via Page.navigate
//   - Runtime.addBinding click   -> Input.dispatchMouseEvent (mousePressed +
//                                  mouseReleased) at the element resolved by
//                                  selector path, coordinates re-scaled to the
//                                  slave viewport. NEVER Runtime.evaluate clicks
//                                  (scripted clicks are detectable).
//   - Runtime.addBinding input   -> batched (300 ms) replay: focus element,
//                                  select-all, Input.insertText.
//
// Dedup/cascade safety: master events are never re-injected into the master
// (event source check) and slave pages carry an isSlave flag in the injected
// script so their mirrored actions are not re-reported. Dead slaves (closed
// browser) are silently pruned from the session with a log line.
import { randomUUID } from 'crypto';
import puppeteer from 'puppeteer-core';
import type { CDPSession, Browser as PuppeteerBrowser } from 'puppeteer-core';
import { getDb } from '../db';
import { getLiveProfile } from '../profiles/profileManager';
import { getRunningWs, isRunning } from '../launcher/chromium';
import { logger } from '../util/logger';
import { InputDebouncer } from './inputDebounce';

export const KEY_CODE_MAP: Record<string, { code: string; keyCode?: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  F5: { code: 'F5', keyCode: 116 },
};

export interface SyncSessionInfo {
  id: string;
  master_profile_id: string;
  created_at: number;
  status: string;
  members: string[];
}

export type SyncResult<T> = { ok: true; data: T } | { ok: false; code: string; msg: string };

interface SlaveState {
  profileId: string;
  browser: PuppeteerBrowser;
  page: CDPSession;
  viewport: { width: number; height: number };
}

interface MasterState {
  profileId: string;
  browser: PuppeteerBrowser;
  page: CDPSession;
  viewport: { width: number; height: number };
}

interface Session {
  id: string;
  master: MasterState;
  slaves: Map<string, SlaveState>;
  debouncer: InputDebouncer;
}

const sessions = new Map<string, Session>();

// ---------------------------------------------------------------------------
// Injected scripts
// ---------------------------------------------------------------------------

/** isSlave flag script: makes mirrored actions invisible to any collector. */
const SLAVE_FLAG_SCRIPT = `(() => { window.__syncerIsSlave = true; })()`;

/**
 * Master collector: capture-phase listeners on document, MAIN world, reporting
 * through Runtime.addBinding. Clicks report coordinates + a stable selector
 * path (tag:nth-of-type chain, ids when present). Input reports the field
 * snapshot on change/blur (batching happens main-side, 300 ms).
 */
const MASTER_LISTENER = `(() => {
  if (window.__syncerMasterInstalled) return;
  window.__syncerMasterInstalled = true;

  const send = (t, payload) => {
    try { window.__syncerReport(JSON.stringify(Object.assign({ t }, payload))); } catch (e) {}
  };

  const isIgnorable = (el) => !el || el === document || el === document.body ||
    (el.tagName || '').toLowerCase() === 'html';

  const buildPath = (el) => {
    const steps = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      if (node.id && typeof node.id === 'string' && node.id.length > 0) {
        steps.unshift({ id: node.id, tag: '', nth: 1 });
        break;
      }
      const tag = (node.tagName || 'div').toLowerCase();
      let nth = 1;
      let sib = node;
      while ((sib = sib.previousElementSibling)) {
        if ((sib.tagName || '').toLowerCase() === tag) nth++;
      }
      steps.unshift({ tag, nth });
      node = node.parentElement;
      depth++;
    }
    return steps
      .map((s) => (s.id ? '#' + s.id : s.tag + ':nth-of-type(' + s.nth + ')'))
      .join(' > ');
  };

  const fieldKey = (el) => {
    const path = buildPath(el);
    const name = el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'));
    return name ? name + '::' + path : path;
  };

  document.addEventListener('click', (ev) => {
    if (window.__syncerIsSlave) return; // never re-report mirrored actions
    const el = ev.target;
    if (isIgnorable(el)) return;
    const rect = el.getBoundingClientRect();
    send('click', {
      x: ev.clientX, y: ev.clientY,
      cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
      vw: window.innerWidth, vh: window.innerHeight,
      selector: buildPath(el),
      text: (el.textContent || '').slice(0, 80)
    });
  }, true);

  const reportField = (el) => {
    if (window.__syncerIsSlave) return;
    if (isIgnorable(el)) return;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) return;
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio' || t === 'submit' || t === 'button' || t === 'file') return;
    }
    send('input', {
      field: fieldKey(el),
      value: el.isContentEditable ? (el.textContent || '') : String(el.value != null ? el.value : '')
    });
  };

  document.addEventListener('change', (ev) => reportField(ev.target), true);
  document.addEventListener('blur', (ev) => reportField(ev.target), true);

  let lastWheel = 0;
  const pendingWheel = { deltaX: 0, deltaY: 0 };
  let wheelTimer = null;

  document.addEventListener('wheel', (ev) => {
    if (window.__syncerIsSlave) return;
    pendingWheel.deltaX += ev.deltaX;
    pendingWheel.deltaY += ev.deltaY;
    const now = Date.now();
    if (now - lastWheel >= 100) {
      lastWheel = now;
      send('scroll', { deltaX: pendingWheel.deltaX, deltaY: pendingWheel.deltaY });
      pendingWheel.deltaX = 0;
      pendingWheel.deltaY = 0;
    } else {
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        lastWheel = Date.now();
        send('scroll', { deltaX: pendingWheel.deltaX, deltaY: pendingWheel.deltaY });
        pendingWheel.deltaX = 0;
        pendingWheel.deltaY = 0;
      }, 100);
    }
  }, { passive: true, capture: true });

  const submitKeys = ['Enter', 'Escape'];

  document.addEventListener('keydown', (ev) => {
    if (window.__syncerIsSlave) return;
    const el = ev.target;
    const tag = (el && el.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || (el && el.isContentEditable);
    if (inField && !submitKeys.includes(ev.key)) return;
    send('key', { key: ev.key });
  }, true);
})();`;

/** Chromium-only feature: Firefox/Camoufox/Android profiles are not supported. */
function isChromiumProfile(profileId: string): boolean {
  const p = getLiveProfile(profileId);
  if (!p) return false;
  const type = (p.browser_type || 'chromium').toLowerCase();
  return type !== 'firefox' && type !== 'camoufox' && type !== 'android';
}

function loadRow(row: Record<string, unknown>): SyncSessionInfo {
  let members: string[] = [];
  try {
    const parsed = JSON.parse(String(row.members ?? '[]'));
    if (Array.isArray(parsed)) members = parsed.map(String);
  } catch {
    // corrupt members -> empty
  }
  return {
    id: String(row.id),
    master_profile_id: String(row.master_profile_id),
    created_at: Number(row.created_at) || 0,
    status: String(row.status),
    members,
  };
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

async function readViewport(page: CDPSession): Promise<{ width: number; height: number }> {
  try {
    const r = (await page.send('Runtime.evaluate', {
      expression: 'JSON.stringify({w: window.innerWidth, h: window.innerHeight})',
      returnByValue: true,
    })) as { result?: { value?: string } };
    const v = JSON.parse(r.result?.value || '{}') as { w?: number; h?: number };
    if (v.w && v.w > 0 && v.h && v.h > 0) return { width: v.w, height: v.h };
  } catch {
    // fall through to default
  }
  return { width: 1280, height: 800 };
}

async function attachMaster(profileId: string): Promise<MasterState> {
  const ws = getRunningWs(profileId);
  if (!ws) throw new Error('master browser not reachable');
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const targets = await browser.targets();
  const pageTarget = targets.find((t) => t.type() === 'page');
  if (!pageTarget) {
    browser.disconnect();
    throw new Error('master has no page target');
  }
  const page = await pageTarget.createCDPSession();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // Report channel: page -> main.
  await page.send('Runtime.addBinding', { name: '__syncerReport' });
  // Install the collector on the current document AND every future document.
  try {
    await page.send('Runtime.evaluate', { expression: MASTER_LISTENER });
  } catch {
    // current document may be chrome://; new-document injection still applies
  }
  await page
    .send('Page.addScriptToEvaluateOnNewDocument', { source: MASTER_LISTENER })
    .catch(() => undefined);
  const viewport = await readViewport(page);
  return { profileId, browser, page, viewport };
}

async function attachSlave(profileId: string): Promise<SlaveState> {
  const ws = getRunningWs(profileId);
  if (!ws) throw new Error('slave browser not reachable');
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const targets = await browser.targets();
  const pageTarget = targets.find((t) => t.type() === 'page');
  if (!pageTarget) {
    browser.disconnect();
    throw new Error('slave has no page target');
  }
  const page = await pageTarget.createCDPSession();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // isSlave flag on the current document and every future document.
  await page
    .send('Page.addScriptToEvaluateOnNewDocument', { source: SLAVE_FLAG_SCRIPT })
    .catch(() => undefined);
  try {
    await page.send('Runtime.evaluate', { expression: SLAVE_FLAG_SCRIPT });
  } catch {
    // flag will be set on the next document
  }
  const viewport = await readViewport(page);
  return { profileId, browser, page, viewport };
}

function detachSlave(slave: SlaveState): void {
  try {
    slave.page.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    slave.browser.disconnect();
  } catch {
    // ignore
  }
}

async function persistMembers(sessionId: string, members: string[]): Promise<void> {
  getDb()
    .prepare('UPDATE sync_sessions SET members = ? WHERE id = ?')
    .run(JSON.stringify(members), sessionId);
}

/** Dead slave (closed browser / failed CDP call) drops out silently. */
function dropSlave(session: Session, profileId: string, reason: string): void {
  const slave = session.slaves.get(profileId);
  if (!slave) return;
  detachSlave(slave);
  session.slaves.delete(profileId);
  logger.warn('syncer slave dropped', { session: session.id, profileId, reason });
  void persistMembers(session.id, [session.master.profileId, ...Array.from(session.slaves.keys())]);
}

// ---------------------------------------------------------------------------
// Replay helpers (slave side)
// ---------------------------------------------------------------------------

async function slaveNavigate(slave: SlaveState, url: string): Promise<void> {
  await slave.page.send('Page.navigate', { url });
}

/**
 * Replay a click as REAL input: resolve the element by selector path first
 * (querySelector -> center), fall back to master coordinates scaled to the
 * slave viewport, then dispatch mousePressed/mouseReleased. A scripted
 * Runtime.evaluate click is intentionally NOT used (detectable).
 */
async function slaveClick(
  slave: SlaveState,
  ev: { cx: number; cy: number; vw: number; vh: number; selector: string },
  masterViewport: { width: number; height: number }
): Promise<void> {
  const scale = {
    x: slave.viewport.width / Math.max(1, masterViewport.width),
    y: slave.viewport.height / Math.max(1, masterViewport.height),
  };
  let target = { x: ev.cx * scale.x, y: ev.cy * scale.y };
  try {
    const r = (await slave.page.send('Runtime.evaluate', {
      expression: `(() => {
        try {
          const el = document.querySelector(${JSON.stringify(ev.selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 });
        } catch (e) { return null; }
      })()`,
      returnByValue: true,
    })) as { result?: { value?: string | null } };
    if (r.result?.value) {
      const pos = JSON.parse(r.result.value) as { x: number; y: number; visible: boolean };
      if (pos.visible && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        target = { x: pos.x, y: pos.y };
      }
    }
  } catch {
    // fall back to scaled master coordinates
  }
  await slave.page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: target.x,
    y: target.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await slave.page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x,
    y: target.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}

/** Replay a batched field value: focus by selector, select-all, insertText. */
async function slaveType(slave: SlaveState, ev: { field: string; value: string }): Promise<void> {
  // Field key is "name::selector-path" (or just the path); the selector is the
  // trailing segment.
  const selector = ev.field.includes('::') ? ev.field.split('::').pop()! : ev.field;
  await slave.page
    .send('Runtime.evaluate', {
      expression: `(() => { try { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.focus(); } catch (e) {} })()`,
      returnByValue: true,
    })
    .catch(() => undefined);
  // Select all existing content (Ctrl+A), then replace in one undoable op.
  await slave.page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
  });
  await slave.page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
  });
  if (ev.value.length > 0) {
    await slave.page.send('Input.insertText', { text: ev.value });
  } else {
    await slave.page.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await slave.page.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
  }
}

async function slaveScroll(
  slave: SlaveState,
  ev: { deltaX: number; deltaY: number; x?: number; y?: number }
): Promise<void> {
  const x = Math.round(ev.x ?? (slave.viewport.width / 2));
  const y = Math.round(ev.y ?? (slave.viewport.height / 2));
  await slave.page.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX: ev.deltaX,
    deltaY: ev.deltaY,
  });
}

async function slaveKey(slave: SlaveState, ev: { key: string }): Promise<void> {
  const meta = KEY_CODE_MAP[ev.key];
  if (!meta) return;
  await slave.page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ev.key,
    code: meta.code,
    windowsVirtualKeyCode: meta.keyCode,
  });
  await slave.page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ev.key,
    code: meta.code,
    windowsVirtualKeyCode: meta.keyCode,
  });
}

// ---------------------------------------------------------------------------
// Event wiring (master side)
// ---------------------------------------------------------------------------

function wireMaster(session: Session): void {
  const { page } = session.master;

  page.on('Page.frameNavigated', (frame: { frame?: { url?: string; parentId?: string } }) => {
    const url = frame?.frame?.url;
    if (!url || frame?.frame?.parentId) return;
    if (url.startsWith('devtools://') || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
    void mirrorNavigation(session, url);
  });

  page.on('Runtime.bindingCalled', (ev: { name?: string; payload?: string }) => {
    if (ev.name !== '__syncerReport' || !ev.payload) return;
    let parsed: { t?: string; [k: string]: unknown };
    try {
      parsed = JSON.parse(ev.payload) as { t?: string; [k: string]: unknown };
    } catch {
      return;
    }
    if (parsed.t === 'click') {
      // SAFETY: payload shape is produced by our own MASTER_LISTENER script above
      // (send('click', {cx, cy, vw, vh, selector})), so the cast restores the known fields.
      void mirrorClick(
        session,
        parsed as unknown as { cx: number; cy: number; vw: number; vh: number; selector: string }
      );
    } else if (parsed.t === 'input') {
      const field = String(parsed.field ?? '');
      const value = String(parsed.value ?? '');
      if (!field) return;
      // 300 ms debounce: rapid keystrokes coalesce into one replay per field.
      session.debouncer.push(field, value, (batch) => {
        void mirrorTyping(session, batch);
      });
    } else if (parsed.t === 'scroll') {
      void mirrorScroll(session, {
        deltaX: Number(parsed.deltaX ?? 0),
        deltaY: Number(parsed.deltaY ?? 0),
      });
    } else if (parsed.t === 'key') {
      void mirrorKey(session, {
        key: String(parsed.key ?? ''),
      });
    }
  });

  // Master disconnect = session over.
  session.master.browser.on('disconnected', () => {
    logger.warn('syncer master disconnected, stopping session', { session: session.id });
    void stopSessionInternal(session.id);
  });
}

async function mirrorNavigation(session: Session, url: string): Promise<void> {
  for (const [pid, slave] of Array.from(session.slaves)) {
    try {
      await slaveNavigate(slave, url);
    } catch (err) {
      dropSlave(session, pid, (err as Error).message);
    }
  }
}

async function mirrorClick(
  session: Session,
  ev: { cx: number; cy: number; vw: number; vh: number; selector: string }
): Promise<void> {
  for (const [pid, slave] of Array.from(session.slaves)) {
    try {
      await slaveClick(slave, ev, session.master.viewport);
    } catch (err) {
      dropSlave(session, pid, (err as Error).message);
    }
  }
}

async function mirrorTyping(session: Session, batch: { fieldKey: string; value: string }): Promise<void> {
  for (const [pid, slave] of Array.from(session.slaves)) {
    try {
      await slaveType(slave, { field: batch.fieldKey, value: batch.value });
    } catch (err) {
      dropSlave(session, pid, (err as Error).message);
    }
  }
}

async function mirrorScroll(
  session: Session,
  ev: { deltaX: number; deltaY: number }
): Promise<void> {
  if (!Number.isFinite(ev.deltaX) || !Number.isFinite(ev.deltaY)) return;
  if (ev.deltaX === 0 && ev.deltaY === 0) return;
  for (const [pid, slave] of Array.from(session.slaves)) {
    try {
      await slaveScroll(slave, ev);
    } catch (err) {
      dropSlave(session, pid, (err as Error).message);
    }
  }
}

async function mirrorKey(session: Session, ev: { key: string }): Promise<void> {
  if (!KEY_CODE_MAP[ev.key]) return;
  for (const [pid, slave] of Array.from(session.slaves)) {
    try {
      await slaveKey(slave, ev);
    } catch (err) {
      dropSlave(session, pid, (err as Error).message);
    }
  }
}


// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export function validateProfilesForSync(profileIds: string[]): SyncResult<{ masterId: string; slaveIds: string[] }> {
  if (profileIds.length < 1) {
    return { ok: false, code: 'INVALID_INPUT', msg: 'profile_ids must contain at least one id' };
  }
  for (const pid of profileIds) {
    if (!isRunning(pid)) return { ok: false, code: 'NOT_RUNNING', msg: `profile ${pid} is not running` };
    if (!isChromiumProfile(pid)) {
      return { ok: false, code: 'UNSUPPORTED', msg: `profile ${pid} is not a Chromium profile` };
    }
  }
  const [masterId, ...slaveIds] = profileIds;
  return { ok: true, data: { masterId, slaveIds } };
}

export async function createSession(profileIds: string[]): Promise<SyncResult<SyncSessionInfo>> {
  const v = validateProfilesForSync(profileIds);
  if (!v.ok) return v;
  const { masterId, slaveIds } = v.data;

  let master: MasterState;
  try {
    master = await attachMaster(masterId);
  } catch (err) {
    return { ok: false, code: 'NOT_RUNNING', msg: (err as Error).message };
  }

  const session: Session = {
    id: 'sync_' + randomUUID(),
    master,
    slaves: new Map(),
    debouncer: new InputDebouncer(300),
  };

  for (const pid of slaveIds) {
    try {
      session.slaves.set(pid, await attachSlave(pid));
    } catch (err) {
      logger.warn('syncer slave attach failed', { profileId: pid, error: (err as Error).message });
    }
  }

  wireMaster(session);
  sessions.set(session.id, session);

  const info: SyncSessionInfo = {
    id: session.id,
    master_profile_id: masterId,
    created_at: Date.now(),
    status: 'active',
    members: [masterId, ...Array.from(session.slaves.keys())],
  };
  getDb()
    .prepare('INSERT INTO sync_sessions (id, master_profile_id, created_at, status, members) VALUES (?, ?, ?, ?, ?)')
    .run(info.id, info.master_profile_id, info.created_at, 'active', JSON.stringify(info.members));
  return { ok: true, data: info };
}

export function listActiveSessions(): SyncSessionInfo[] {
  const rows = getDb()
    .prepare("SELECT * FROM sync_sessions WHERE status = 'active' ORDER BY created_at DESC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(loadRow);
}

export function getSession(id: string): SyncSessionInfo | null {
  const row = getDb().prepare('SELECT * FROM sync_sessions WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? loadRow(row) : null;
}

async function stopSessionInternal(id: string): Promise<void> {
  const session = sessions.get(id);
  if (session) {
    session.debouncer.clear();
    try {
      session.master.page.removeAllListeners();
      session.master.browser.disconnect();
    } catch {
      // ignore
    }
    for (const slave of session.slaves.values()) detachSlave(slave);
    sessions.delete(id);
  }
  getDb().prepare("UPDATE sync_sessions SET status = 'stopped' WHERE id = ?").run(id);
}

export async function stopSession(id: string): Promise<SyncResult<{ stopped: boolean }>> {
  const info = getSession(id);
  if (!info) return { ok: false, code: 'NOT_FOUND', msg: 'session not found' };
  await stopSessionInternal(id);
  return { ok: true, data: { stopped: true } };
}

export async function joinSession(id: string, profileId: string): Promise<SyncResult<SyncSessionInfo>> {
  const info = getSession(id);
  if (!info || info.status !== 'active') return { ok: false, code: 'NOT_FOUND', msg: 'active session not found' };
  const session = sessions.get(id);
  if (!session) return { ok: false, code: 'NOT_FOUND', msg: 'session runtime missing (service restarted?)' };
  if (session.slaves.has(profileId) || session.master.profileId === profileId) {
    return { ok: false, code: 'ALREADY_MEMBER', msg: 'profile already in session' };
  }
  const v = validateProfilesForSync([profileId]);
  if (!v.ok) return v;
  try {
    const slave = await attachSlave(profileId);
    session.slaves.set(profileId, slave);
  } catch (err) {
    return { ok: false, code: 'NOT_RUNNING', msg: (err as Error).message };
  }
  await persistMembers(id, [session.master.profileId, ...Array.from(session.slaves.keys())]);
  return { ok: true, data: getSession(id)! };
}

export async function leaveSession(id: string, profileId: string): Promise<SyncResult<SyncSessionInfo>> {
  const info = getSession(id);
  if (!info || info.status !== 'active') return { ok: false, code: 'NOT_FOUND', msg: 'active session not found' };
  const session = sessions.get(id);
  if (!session) return { ok: false, code: 'NOT_FOUND', msg: 'session runtime missing (service restarted?)' };
  if (profileId === session.master.profileId) {
    await stopSessionInternal(id);
    return { ok: true, data: getSession(id)! };
  }
  dropSlave(session, profileId, 'left by request');
  if (session.slaves.size === 0) {
    await stopSessionInternal(id);
  }
  return { ok: true, data: getSession(id)! };
}

/** Service shutdown: stop every runtime session (rows are already persisted). */
export async function stopAllSessions(): Promise<void> {
  for (const id of Array.from(sessions.keys())) {
    await stopSessionInternal(id);
  }
}

/** Test/inspection helpers. */
export function activeSessionCount(): number {
  return sessions.size;
}

export function isSessionProfile(profileId: string): boolean {
  for (const s of sessions.values()) {
    if (s.master.profileId === profileId || s.slaves.has(profileId)) return true;
  }
  return false;
}