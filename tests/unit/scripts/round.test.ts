import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { initDb, closeDb } from '../../../src/main/db';
import {
  invokeScriptTask,
  registerMockBrowser,
  unregisterMockBrowser,
  type BrowserLike,
  type PageLike,
} from '../../../src/main/scripts/scriptEngine';
import { setController, resetControllers } from '../../../src/main/api/routes/handoff';
import { compileFlowToScript } from '../../../src/main/flows/compiler';
import type { FlowDocument } from '../../../src/main/flows/types';
import { invalidateRefs, type AXNode } from '../../../src/main/automation/snapshot';

interface RoundOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
}

function runWorkerRound(profileId: string, code: string): Promise<RoundOutcome> {
  const { promise, resolve } = Promise.withResolvers<RoundOutcome>();
  const streamedLogs: string[] = [];
  const handle = invokeScriptTask({
    profileId,
    code,
    timeoutMs: 10000,
  });

  handle.logStream.on('log', (line: string) => {
    streamedLogs.push(line);
  });

  handle.logStream.on('done', (payload: { result?: unknown; logs?: string[] }) => {
    resolve({
      ok: true,
      result: payload.result,
      logs: Array.isArray(payload.logs) && payload.logs.length > 0 ? payload.logs : streamedLogs,
    });
  });

  handle.logStream.on('error', (payload: { error: string; logs?: string[] }) => {
    resolve({
      ok: false,
      error: payload.error,
      logs: Array.isArray(payload.logs) && payload.logs.length > 0 ? payload.logs : streamedLogs,
    });
  });

  return promise;
}

function createMockBrowserEnv() {
  const events: string[] = [];
  let currentUrl = 'about:blank';
  const dialogListeners: Array<(dialog: unknown) => void> = [];
  const popupListeners: Array<(popup: unknown) => void> = [];

  const axNodes: AXNode[] = [
    {
      nodeId: '1',
      backendDOMNodeId: 10,
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'computedString', value: 'Dashboard' },
      childIds: ['2', '3'],
    },
    {
      nodeId: '2',
      backendDOMNodeId: 20,
      parentId: '1',
      role: { type: 'role', value: 'textbox' },
      name: { type: 'computedString', value: 'Username' },
    },
    {
      nodeId: '3',
      backendDOMNodeId: 30,
      parentId: '1',
      role: { type: 'role', value: 'button' },
      name: { type: 'computedString', value: 'Submit' },
    },
  ];

  const page: PageLike = {
    goto: async (url: string) => {
      events.push(`goto:${url}`);
      currentUrl = url;
      return { status: () => 200 };
    },
    url: () => currentUrl,
    title: async () => 'Mock Page',
    fill: async (selector: string, value: string) => {
      events.push(`fill:${selector}=${value}`);
    },
    type: async (selector: string, value: string) => {
      events.push(`type:${selector}=${value}`);
    },
    click: async (selector: string) => {
      events.push(`click:${selector}`);
    },
    focus: async (selector: string) => {
      events.push(`focus:${selector}`);
    },
    waitForSelector: async (selector: string) => {
      events.push(`waitForSelector:${selector}`);
      return { ok: true };
    },
    waitForFunction: async (fn: string | ((...args: unknown[]) => unknown)) => {
      events.push(`waitForFunction:${String(fn)}`);
      return { ok: true };
    },
    waitForNetworkIdle: async () => {
      events.push('waitForNetworkIdle');
      return { ok: true };
    },
    screenshot: async () => {
      events.push('screenshot');
      return Buffer.from('mock-png').toString('base64');
    },
    evaluate: async (fn: unknown, ...args: unknown[]) => {
      events.push('evaluate');
      if (typeof fn === 'function') {
        return (fn as (...a: unknown[]) => unknown)(...args);
      }
      return null;
    },
    close: async () => {
      events.push('close');
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'dialog') dialogListeners.push(handler);
      if (event === 'popup') popupListeners.push(handler);
    },
    mouse: {
      move: async (x: number, y: number) => {
        events.push(`mouse.move:${Math.round(x)},${Math.round(y)}`);
      },
      click: async (x: number, y: number) => {
        events.push(`mouse.click:${Math.round(x)},${Math.round(y)}`);
      },
      down: async () => {
        events.push('mouse.down');
      },
      up: async () => {
        events.push('mouse.up');
      },
    },
    keyboard: {
      down: async (key: string) => {
        events.push(`key.down:${key}`);
      },
      up: async (key: string) => {
        events.push(`key.up:${key}`);
      },
    },
    send: async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        events.push('snapshot:ax');
        return { nodes: axNodes };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { layoutViewport: { clientWidth: 1280, clientHeight: 800 } };
      }
      return {};
    },
  };

  const browser: BrowserLike = {
    pages: async () => [page],
    newPage: async () => {
      events.push('newPage');
      return { ...page };
    },
  };

  return { browser, page, events, dialogListeners, popupListeners };
}

describe('Z2 Round Worker Facades & Flow Execution (tasks.md §2.1, §2.4)', () => {
  const profileId = 'prof_round_z2';

  beforeAll(async () => {
    await initDb();
  });

  beforeEach(() => {
    resetControllers();
    invalidateRefs(profileId);
  });

  afterEach(() => {
    unregisterMockBrowser(profileId);
    resetControllers();
  });

  afterAll(() => {
    closeDb();
  });

  it('executes goto -> fill -> click -> waitForSelector -> snapshot chain in one worker round (R02, R12i)', async () => {
    const env = createMockBrowserEnv();
    registerMockBrowser(profileId, env.browser);

    const outcome = await runWorkerRound(
      profileId,
      `
      (async () => {
        const nav = await app.browser.goto('https://example.com/login');
        const filled = await app.browser.fill('#username', 'alice');
        const clicked = await app.browser.click('#submit');
        const waited = await app.browser.waitForSelector('#dashboard', { timeout: 2000 });
        await app.browser.waitForURL('example.com/login', { timeout: 2000 });
        await app.browser.waitForFunction('() => true', { timeout: 2000 });
        await app.browser.waitForLoadState('networkidle', { timeout: 2000 });
        const snap = await app.browser.snapshot();
        return { nav, filled, clicked, waited, snap };
      })()
      `
    );

    expect(outcome.ok).toBe(true);
    expect(env.events).toEqual([
      'goto:https://example.com/login',
      'fill:#username=alice',
      'click:#submit',
      'waitForSelector:#dashboard',
      'waitForFunction:() => true',
      'waitForNetworkIdle',
      'snapshot:ax',
    ]);

    const res = outcome.result as {
      nav: { url: string; status: number };
      filled: { filled: boolean };
      clicked: { ok: boolean };
      waited: { ok: boolean };
      snap: { text: string; refs: string[] };
    };
    expect(res.nav.url).toBe('https://example.com/login');
    expect(res.filled.filled).toBe(true);
    expect(res.clicked.ok).toBe(true);
    expect(res.waited.ok).toBe(true);
    expect(res.snap.text).toContain('RootWebArea "Dashboard"');
    expect(res.snap.text).toContain('button "Submit" [ref=');
    expect(res.snap.refs.length).toBeGreaterThan(0);
  }, 15000);

  it('supports screenshot, evaluate, tabs, newPage, close, dialogs, and motion facades (R04, R05, R10i)', async () => {
    const env = createMockBrowserEnv();
    registerMockBrowser(profileId, env.browser);

    const outcome = await runWorkerRound(
      profileId,
      `
      (async () => {
        await app.browser.goto('https://example.com');
        const shot = await app.browser.screenshot({ fullPage: true });
        const evalOut = await app.browser.evaluate('(x) => x * 2', 21);
        const created = await app.browser.newPage();
        const tabsBefore = await app.browser.tabs();
        await app.browser.close(created.label);
        await app.browser.acceptDialog('ok');
        await app.browser.dismissDialog();
        await app.motion.click('#submit', { x: 120, y: 80, targetWidth: 32 });
        await app.motion.type('#username', 'hi', { allowTypos: false });
        return { shot, evalOut, created, tabsCount: tabsBefore.length };
      })()
      `
    );

    expect(outcome.ok).toBe(true);
    const res = outcome.result as {
      shot: { base64: string; cssScale: boolean };
      evalOut: number;
      created: { label: string };
      tabsCount: number;
    };
    expect(res.shot.cssScale).toBe(true);
    expect(res.shot.base64.length).toBeGreaterThan(0);
    expect(res.evalOut).toBe(42);
    expect(res.created.label).toBe('p2');
    expect(res.tabsCount).toBe(2);
    expect(env.events.some((e) => e.startsWith('mouse.move:'))).toBe(true);
    expect(env.events).toContain('mouse.down');
    expect(env.events).toContain('key.down:h');
    expect(env.events).toContain('key.down:i');
  }, 15000);

  it('R03 regression proof: compiled flow with navigate and click executes in worker with zero Simulated log lines', async () => {
    const env = createMockBrowserEnv();
    registerMockBrowser(profileId, env.browser);

    const flow: FlowDocument = {
      id: 'flow-r03',
      name: 'R03 Live Browser Proof',
      version: 1,
      entryNodeId: 'n1',
      variables: [],
      nodes: [
        {
          id: 'n1',
          type: 'navigate',
          url: 'https://example.com/flow',
          timeoutMs: 5000,
        },
        {
          id: 'n2',
          type: 'click',
          selector: '#cta-btn',
          waitForSelector: false,
          timeoutMs: 5000,
        },
        {
          id: 'n3',
          type: 'human_click',
          selector: '#human-btn',
          targetWidth: 32,
          x: 100,
          y: 100,
        },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', branch: 'default' },
        { id: 'e2', source: 'n2', target: 'n3', branch: 'default' },
      ],
    };

    const compiledCode = compileFlowToScript(flow);
    const outcome = await runWorkerRound(profileId, compiledCode);

    expect(outcome.ok).toBe(true);
    expect(outcome.logs.some((line) => /Simulated/i.test(line))).toBe(false);
    expect(env.events).toContain('goto:https://example.com/flow');
    expect(env.events).toContain('click:#cta-btn');
    expect(env.events.some((e) => e.startsWith('mouse.move:'))).toBe(true);
  }, 15000);

  it('denies OS, filesystem, and process access inside round code (R11i)', async () => {
    const env = createMockBrowserEnv();
    registerMockBrowser(profileId, env.browser);

    const probeOutcome = await runWorkerRound(
      profileId,
      `
      ({
        requireType: typeof require,
        processType: typeof process,
        fsType: typeof fs,
        childProcessType: typeof child_process,
        parentPortType: typeof parentPort,
      })
      `
    );

    expect(probeOutcome.ok).toBe(true);
    expect(probeOutcome.result).toEqual({
      requireType: 'undefined',
      processType: 'undefined',
      fsType: 'undefined',
      childProcessType: 'undefined',
      parentPortType: 'undefined',
    });

    const throwOutcome = await runWorkerRound(profileId, `require('fs').readFileSync('/etc/passwd')`);
    expect(throwOutcome.ok).toBe(false);
    expect(String(throwOutcome.error)).toMatch(/require is not defined/i);
  }, 15000);

  it('enforces USER_IN_CONTROL gate on mutating round calls while allowing read-only tabs (R07)', async () => {
    const env = createMockBrowserEnv();
    registerMockBrowser(profileId, env.browser);
    setController(profileId, 'user');

    const outcome = await runWorkerRound(
      profileId,
      `
      (async () => {
        const clickRes = await app.browser.click('#submit');
        const snapRes = await app.browser.snapshot();
        const tabsRes = await app.browser.tabs();
        return { clickRes, snapRes, tabsRes };
      })()
      `
    );

    expect(outcome.ok).toBe(true);
    const res = outcome.result as {
      clickRes: { error: string; error_code: string };
      snapRes: { error: string; error_code: string };
      tabsRes: Array<{ label: string }>;
    };
    expect(res.clickRes.error_code).toBe('USER_IN_CONTROL');
    expect(res.snapRes.error_code).toBe('USER_IN_CONTROL');
    expect(Array.isArray(res.tabsRes)).toBe(true);
    expect(env.events).not.toContain('click:#submit');
  }, 15000);
});
