import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { McpServer } from '../../../mcp/src/server';
import { ToolRouter, TOOL_DEFINITIONS } from '../../../mcp/src/tools';
import { McpAuditLogger } from '../../../mcp/src/audit';
import { NonceReplayDefense } from '../../../mcp/src/auth';
import { AntidetectClient } from '../../../packages/sdk-node/src/client';
import { BrowserDriver } from '../../../mcp/src/browser';
import { ActivityReporter, CDP_DIRECT_TOOLS } from '../../../mcp/src/activityReporter';

interface ToolResultEnvelope {
  content?: Array<{ type?: string; text?: string }>;
}

interface SchemaWithRequired {
  required?: string[];
}

function parseToolJson(result: unknown): unknown {
  if (result && typeof result === 'object' && 'content' in result) {
    const envelope: ToolResultEnvelope = result;
    const firstTextNode = envelope.content?.find((c) => c.type === 'text');
    if (firstTextNode && typeof firstTextNode.text === 'string') {
      return JSON.parse(firstTextNode.text);
    }
  }
  return null;
}

type MockRequestFn = (
  urlPath: string,
  options?: { method?: string; body?: unknown }
) => Promise<{ data: unknown }>;

interface MockClientWithMock {
  request: MockRequestFn & {
    mockImplementationOnce: (fn: MockRequestFn) => void;
    mockImplementation: (fn: MockRequestFn) => void;
  };
}

describe('Z3 MCP Round Tools & BrowserDriver (R04, R08-MCP, R09)', () => {
  let tempAuditPath: string;
  let auditLogger: McpAuditLogger;
  let nonceDefense: NonceReplayDefense;
  let mockClient: AntidetectClient;
  let mockBrowserDriver: BrowserDriver;
  let mockReporter: ActivityReporter;
  let reportedActivities: Array<{ tool: string; profileId?: string }>;
  let toolRouter: ToolRouter;
  let server: McpServer;

  beforeEach(() => {
    tempAuditPath = path.join(os.tmpdir(), `mcp-round-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    auditLogger = new McpAuditLogger(tempAuditPath);
    nonceDefense = new NonceReplayDefense();
    reportedActivities = [];

    mockReporter = {
      isEnabled: () => true,
      report: (tool: string, profileId?: string) => {
        reportedActivities.push({ tool, profileId });
      },
    } as unknown as ActivityReporter;

    mockClient = {
      request: vi.fn(async (urlPath: string, options?: { method?: string; body?: unknown }) => {
        if (urlPath.includes('/round')) {
          const body = (options?.body || {}) as { code?: string };
          if (body.code?.includes('throw new Error("fail")')) {
            return {
              data: {
                console: ['log before fail'],
                result: null,
                error: 'fail',
              },
            };
          }
          if (body.code?.includes('app.browser.tabs()')) {
            return {
              data: {
                console: [],
                result: [{ label: 'p1', url: 'https://example.com', title: 'Example' }],
              },
            };
          }
          if (body.code?.includes('app.browser.snapshot(')) {
            return {
              data: {
                console: [],
                result: {
                  text: 'role:button [ref=1]',
                  refs: ['@1'],
                  truncated: false,
                },
              },
            };
          }
          return {
            data: {
              console: ['round log 1', 'round log 2'],
              result: { success: true, count: 42 },
            },
          };
        }
        return { data: {} };
      }),
    } as unknown as AntidetectClient;

    mockBrowserDriver = {
      navigate: vi.fn(async (_id: string, url: string) => ({ url, status: 200 })),
      click: vi.fn(async (_id: string, selector: string) => ({ clicked: true, selector })),
      type: vi.fn(async (_id: string, selector: string, _text: string) => ({ typed: true, selector })),
      humanType: vi.fn(async (_id: string, selector: string, _text: string) => ({
        typed: true,
        selector,
        durationMs: 120,
      })),
      humanClick: vi.fn(async (_id: string, selector: string) => ({
        clicked: true,
        selector,
        durationMs: 180,
      })),
      screenshot: vi.fn(async (_id: string) => ({
        format: 'image/png',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        sizeBytes: 68,
      })),
      evaluateAllowlisted: vi.fn(async (_id: string, _code: string, params: Record<string, unknown>) => ({
        evalResult: true,
        echo: params,
      })),
      listTabs: vi.fn(async (_id: string) => [
        { label: 'p1', url: 'https://example.com', title: 'Example' },
      ]),
    } as unknown as BrowserDriver;

    toolRouter = new ToolRouter({
      client: mockClient,
      browserDriver: mockBrowserDriver,
      auditLogger,
      activityReporter: mockReporter,
    });

    server = new McpServer({
      toolRouter,
      nonceDefense,
    });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempAuditPath)) {
        fs.unlinkSync(tempAuditPath);
      }
    } catch {}
  });

  describe('Manifest & Security Tiers (Tier 1)', () => {
    it('declares browser.run_round, browser.snapshot, browser.tabs as Tier 1 (default)', () => {
      const names = ['browser.run_round', 'browser.snapshot', 'browser.tabs'];
      for (const name of names) {
        const def = TOOL_DEFINITIONS.find((t) => t.name === name);
        expect(def, `Tool ${name} should be in toolManifest`).toBeDefined();
        expect(def?.tier).toBe('default');
      }
    });

    it('matches manifest snapshot for all browser tools', () => {
      const browserTools = TOOL_DEFINITIONS.filter((t) => t.name.startsWith('browser.')).map((t) => {
        const schema = t.inputSchema as SchemaWithRequired;
        return {
          name: t.name,
          tier: t.tier,
          required: schema?.required || [],
        };
      });
      expect(browserTools).toEqual([
        { name: 'browser.navigate', tier: 'default', required: ['profile_id', 'url'] },
        { name: 'browser.click', tier: 'default', required: ['profile_id', 'selector'] },
        { name: 'browser.type', tier: 'default', required: ['profile_id', 'selector', 'text'] },
        { name: 'browser.human_type', tier: 'default', required: ['profile_id', 'selector', 'text'] },
        { name: 'browser.human_click', tier: 'default', required: ['profile_id', 'selector'] },
        { name: 'browser.screenshot', tier: 'default', required: ['profile_id'] },
        { name: 'browser.run_round', tier: 'default', required: ['profile_id', 'code'] },
        { name: 'browser.snapshot', tier: 'default', required: ['profile_id'] },
        { name: 'browser.tabs', tier: 'default', required: ['profile_id'] },
        { name: 'browser.evaluate_allowlisted', tier: 'gated', required: ['profile_id', 'script_id'] },
      ]);
    });
  });

  describe('Tool Routing & Execution', () => {
    it('routes browser.run_round through backend round endpoint', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'browser.run_round',
          arguments: {
            profile_id: 'prof_123',
            code: 'return 42;',
            timeout_ms: 15000,
          },
        },
      }, { scope: 'standard' });

      expect(resp.error).toBeUndefined();
      expect(resp.result).toBeDefined();
      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({
        console: ['round log 1', 'round log 2'],
        result: { success: true, count: 42 },
      });

      expect(reportedActivities).toContainEqual({
        tool: 'browser.run_round',
        profileId: 'prof_123',
      });
    });

    it('routes browser.snapshot through backend round engine and returns snapshot data', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'browser.snapshot',
          arguments: {
            profile_id: 'prof_123',
            scope: 'viewport',
          },
        },
      }, { scope: 'standard' });

      expect(resp.error).toBeUndefined();
      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({
        text: 'role:button [ref=1]',
        refs: ['@1'],
        truncated: false,
      });
    });

    it('routes browser.tabs to list open tabs', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser.tabs',
          arguments: {
            profile_id: 'prof_123',
          },
        },
      }, { scope: 'standard' });

      expect(resp.error).toBeUndefined();
      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual([{ label: 'p1', url: 'https://example.com', title: 'Example' }]);
    });
  });

  describe('Audit Log Redaction & ActivityReporter', () => {
    it('redacts code parameter from audit logs for browser.run_round', async () => {
      await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'browser.run_round',
          arguments: {
            profile_id: 'prof_sec',
            code: 'const secretApiKey = "SK_LIVE_SECRET_987654321"; return secretApiKey;',
          },
        },
      }, { scope: 'standard' });

      const logLines = fs.readFileSync(tempAuditPath, 'utf8').trim().split('\n');
      expect(logLines.length).toBeGreaterThan(0);
      const lastEntry = JSON.parse(logLines[logLines.length - 1]);
      expect(lastEntry.tool).toBe('browser.run_round');
      // Audit log stores only argsHash (never raw args); redaction must hold:
      // the secret from `code` must appear nowhere in the log file.
      expect('args' in lastEntry).toBe(false);
      expect(fs.readFileSync(tempAuditPath, 'utf8')).not.toContain('SK_LIVE_SECRET_987654321');
    });

    it('includes new browser tools in CDP_DIRECT_TOOLS', () => {
      expect(CDP_DIRECT_TOOLS['browser.run_round']).toBe(true);
      expect(CDP_DIRECT_TOOLS['browser.snapshot']).toBe(true);
      expect(CDP_DIRECT_TOOLS['browser.tabs']).toBe(true);
    });
  });

  describe('Handoff Gate Passthrough (mock 409 USER_IN_CONTROL)', () => {
    it('passes through 409 USER_IN_CONTROL on browser.run_round', async () => {
      const clientWithMock = mockClient as unknown as MockClientWithMock;
      clientWithMock.request.mockImplementationOnce(async () => {
        const error = new Error('USER_IN_CONTROL') as Error & {
          status: number;
          data: { error_code: string; error: string; data: { console: string[] } };
        };
        error.status = 409;
        error.data = {
          error_code: 'USER_IN_CONTROL',
          error: 'USER_IN_CONTROL',
          data: { console: [] },
        };
        throw error;
      });

      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'browser.run_round',
          arguments: {
            profile_id: 'prof_user',
            code: 'return 1;',
          },
        },
      }, { scope: 'standard' });

      expect(resp.error).toBeUndefined();
      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({
        error: 'USER_IN_CONTROL',
        error_code: 'USER_IN_CONTROL',
        console: [],
        result: null,
      });
    });

    it('passes through 409 USER_IN_CONTROL on browser.snapshot', async () => {
      const clientWithMock = mockClient as unknown as MockClientWithMock;
      clientWithMock.request.mockImplementation(async () => {
        const error = new Error('USER_IN_CONTROL') as Error & {
          status: number;
          data: { error_code: string; error: string; data: { console: string[] } };
        };
        error.status = 409;
        error.data = {
          error_code: 'USER_IN_CONTROL',
          error: 'USER_IN_CONTROL',
          data: { console: [] },
        };
        throw error;
      });

      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'browser.snapshot',
          arguments: {
            profile_id: 'prof_user',
          },
        },
      }, { scope: 'standard' });

      expect(resp.error).toBeUndefined();
      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({
        error: 'USER_IN_CONTROL',
        error_code: 'USER_IN_CONTROL',
        console: [],
        result: null,
      });
    });
  });

  describe('R09 Behavior Freeze of Pre-existing Browser Tools', () => {
    it('preserves browser.navigate return shape { url, status }', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'browser.navigate',
          arguments: { profile_id: 'p1', url: 'https://nulltrace.dev' },
        },
      }, { scope: 'standard' });

      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({ url: 'https://nulltrace.dev', status: 200 });
    });

    it('preserves browser.click return shape { clicked, selector }', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'browser.click',
          arguments: { profile_id: 'p1', selector: '#btn-submit' },
        },
      }, { scope: 'standard' });

      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({ clicked: true, selector: '#btn-submit' });
    });

    it('preserves browser.type return shape { typed, selector }', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'browser.type',
          arguments: { profile_id: 'p1', selector: '#input-user', text: 'alice' },
        },
      }, { scope: 'standard' });

      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({ typed: true, selector: '#input-user' });
    });

    it('preserves browser.human_type return shape { typed, selector, durationMs }', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'browser.human_type',
          arguments: { profile_id: 'p1', selector: '#input-user', text: 'bob' },
        },
      }, { scope: 'standard' });

      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({ typed: true, selector: '#input-user', durationMs: 120 });
    });

    it('preserves browser.human_click return shape { clicked, selector, durationMs }', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'browser.human_click',
          arguments: { profile_id: 'p1', selector: '#btn-login', target_width: 48 },
        },
      }, { scope: 'standard' });

      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({ clicked: true, selector: '#btn-login', durationMs: 180 });
    });

    it('preserves browser.screenshot return shape { format, base64, sizeBytes }', async () => {
      const resp = await server.handleJsonRpcRequest({
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: {
          name: 'browser.screenshot',
          arguments: { profile_id: 'p1', full_page: false },
        },
      }, { scope: 'standard' });

      const parsed = parseToolJson(resp.result);
      expect(parsed).toEqual({
        format: 'image/png',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        sizeBytes: 68,
      });
    });
  });

  describe('BrowserDriver Additive Tabs and Dialog Registry', () => {
    it('manages tab registry with p1 default and newPage/closePage/listTabs', async () => {
      let pageCounter = 0;
      const makeMockPage = (url = 'about:blank', title = 'Page') => ({
        url: () => url,
        title: async () => title,
        close: vi.fn(async () => {}),
        isClosed: () => false,
        on: vi.fn(),
      });

      const p1 = makeMockPage('https://example.com', 'Example');
      const mockBrowser = {
        connected: true,
        pages: async () => [p1],
        newPage: async () => {
          pageCounter++;
          return makeMockPage(`https://test.local/p${pageCounter}`, `Tab ${pageCounter}`);
        },
        on: vi.fn(),
        disconnect: vi.fn(async () => {}),
      };

      const sdkClient = {
        browser: {
          list: async () => ({ data: { list: [{ user_id: 'prof_driver' }] } }),
          start: async () => ({ data: { wsEndpoint: 'ws://127.0.0.1:9222/devtools' } }),
        },
      } as unknown as AntidetectClient;

      const driver = new BrowserDriver(sdkClient);
      const cacheHolder: { browserCache: Map<string, unknown> } = driver as unknown as { browserCache: Map<string, unknown> };
      cacheHolder.browserCache.set('prof_driver', mockBrowser);

      // 1. Initial listTabs sets up p1
      const initialTabs = await driver.listTabs('prof_driver');
      expect(initialTabs).toEqual([{ label: 'p1', url: 'https://example.com', title: 'Example' }]);

      // 2. getPageByLabel returns p1
      const fetchedP1 = await driver.getPageByLabel('prof_driver', 'p1');
      expect(fetchedP1).toBe(p1);

      // 3. newPage creates p2
      const newTabRes = await driver.newPage('prof_driver');
      expect(newTabRes.label).toBe('p2');

      const tabsAfterNew = await driver.listTabs('prof_driver');
      expect(tabsAfterNew).toHaveLength(2);
      expect(tabsAfterNew[1].label).toBe('p2');

      // 4. closePage closes p2
      const closeRes = await driver.closePage('prof_driver', 'p2');
      expect(closeRes).toEqual({ ok: true });

      const tabsAfterClose = await driver.listTabs('prof_driver');
      expect(tabsAfterClose).toHaveLength(1);
      expect(tabsAfterClose[0].label).toBe('p1');
    });

    it('records and handles dialog opening via acceptDialog and dismissDialog', async () => {
      let dialogHandler: ((d: unknown) => void) | undefined;
      const mockDialog = {
        type: () => 'prompt',
        message: () => 'Enter your age:',
        accept: vi.fn(async () => {}),
        dismiss: vi.fn(async () => {}),
      };

      const mockPage = {
        url: () => 'https://dialog.test',
        title: async () => 'Dialog Test',
        close: vi.fn(async () => {}),
        isClosed: () => false,
        on: (event: string, handler: (arg: unknown) => void) => {
          if (event === 'dialog') {
            dialogHandler = handler;
          }
        },
      };

      const mockBrowser = {
        connected: true,
        pages: async () => [mockPage],
        newPage: async () => mockPage,
        on: vi.fn(),
        disconnect: vi.fn(async () => {}),
      };

      const sdkClient = {} as unknown as AntidetectClient;
      const driver = new BrowserDriver(sdkClient);
      const cacheHolder: { browserCache: Map<string, unknown> } = driver as unknown as { browserCache: Map<string, unknown> };
      cacheHolder.browserCache.set('prof_dialog', mockBrowser);

      await driver.getPageByLabel('prof_dialog', 'p1');
      expect(dialogHandler).toBeDefined();

      // Trigger dialog event
      if (!dialogHandler) throw new Error('dialog handler not registered');
      dialogHandler(mockDialog);

      // Check pending receipt
      const receipt = driver.getPendingReceipt('prof_dialog');
      expect(receipt.ok).toBe(true);
      expect(receipt.dialog).toEqual({
        type: 'prompt',
        message: 'Enter your age:',
      });

      // Accept dialog
      const acceptRes = await driver.acceptDialog('prof_dialog', '25');
      expect(acceptRes).toEqual({ ok: true });
      expect(mockDialog.accept).toHaveBeenCalledWith('25');

      // Subsequent receipt shows cleared dialog
      const receiptAfter = driver.getPendingReceipt('prof_dialog');
      expect(receiptAfter.dialog).toBeNull();

      // Trigger again for dismiss
      dialogHandler(mockDialog);
      const dismissRes = await driver.dismissDialog('prof_dialog');
      expect(dismissRes).toEqual({ ok: true });
      expect(mockDialog.dismiss).toHaveBeenCalled();
    });
  });
});
