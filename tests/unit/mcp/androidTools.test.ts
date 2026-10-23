import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRouter, TOOL_DEFINITIONS } from '../../../mcp/src/tools';
import { McpAuditLogger } from '../../../mcp/src/audit';
import { AntidetectClient } from '../../../packages/sdk-node/src/client';
import { ActivityReporter } from '../../../mcp/src/activityReporter';

describe('MCP Android tools (android-profiles-integration)', () => {
  let tempAuditPath: string;
  let toolRouter: ToolRouter;
  let lastCall: { url: string; options?: { method?: string; body?: unknown } } | null;

  beforeEach(() => {
    tempAuditPath = path.join(os.tmpdir(), `mcp-android-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    lastCall = null;
    const mockClient = {
      request: vi.fn(async (urlPath: string, options?: { method?: string; body?: unknown }) => {
        lastCall = { url: urlPath, options };
        if (urlPath.endsWith('/screencap')) {
          return { data: { format: 'png', base64: 'iVBORw0KGgo=', sizeBytes: 8 } };
        }
        return { data: { ok: true } };
      }),
    } as unknown as AntidetectClient;
    toolRouter = new ToolRouter({
      client: mockClient,
      auditLogger: new McpAuditLogger(tempAuditPath),
      activityReporter: { isEnabled: () => false, report: () => {} } as unknown as ActivityReporter,
    });
  });

  afterEach(() => {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      if (fs.existsSync(tempAuditPath)) fs.unlinkSync(tempAuditPath);
    } catch {
      // ignore
    }
  });

  it('registers all 9 android.* tools in the default tier', () => {
    const names = new Set(TOOL_DEFINITIONS.filter((t) => t.tier === 'default').map((t) => t.name));
    for (const n of [
      'android.start', 'android.stop', 'android.status', 'android.tap', 'android.swipe',
      'android.type', 'android.key', 'android.screencap', 'android.install_apk',
    ]) {
      expect(names.has(n), `${n} must be a default-tier tool`).toBe(true);
    }
  });

  it('standard scope authorizes android.* like browser verbs (no forbidden)', async () => {
    for (const [name, args] of [
      ['android.status', { profile_id: 'p1' }],
      ['android.tap', { profile_id: 'p1', x: 10, y: 20 }],
      ['android.screencap', { profile_id: 'p1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await toolRouter.callTool(name, args, { scope: 'standard', caller: 'test' });
      expect(res.isForbidden, `${name} must not be forbidden for standard scope`).not.toBe(true);
      expect(res.success, `${name} must dispatch: ${res.error}`).toBe(true);
    }
  });

  it('dispatches tap/swipe/type/key/install to the matching routes with mapped bodies', async () => {
    await toolRouter.callTool('android.tap', { profile_id: 'p1', x: 100, y: 200 }, { scope: 'standard' });
    expect(lastCall?.url).toBe('/api/v1/android/profiles/p1/tap');
    expect(lastCall?.options?.body).toEqual({ x: 100, y: 200 });

    await toolRouter.callTool(
      'android.swipe',
      { profile_id: 'p1', x1: 1, y1: 2, x2: 3, y2: 4, duration_ms: 500 },
      { scope: 'standard' },
    );
    expect(lastCall?.url).toBe('/api/v1/android/profiles/p1/swipe');
    expect(lastCall?.options?.body).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 500 });

    await toolRouter.callTool('android.type', { profile_id: 'p1', text: 'hi' }, { scope: 'standard' });
    expect(lastCall?.url).toBe('/api/v1/android/profiles/p1/type');

    await toolRouter.callTool('android.key', { profile_id: 'p1', keycode: 4 }, { scope: 'standard' });
    expect(lastCall?.options?.body).toEqual({ keycode: 4 });

    await toolRouter.callTool('android.install_apk', { profile_id: 'p1', apk_path: 'c:\\a.apk' }, { scope: 'standard' });
    expect(lastCall?.url).toBe('/api/v1/android/profiles/p1/install');
    expect(lastCall?.options?.body).toEqual({ apkPath: 'c:\\a.apk' });
  });

  it('rejects missing/invalid args before touching the backend', async () => {
    const tap = await toolRouter.callTool('android.tap', { profile_id: 'p1', x: 'left' }, { scope: 'standard' });
    expect(tap.success).toBe(false);
    expect(tap.error).toMatch(/numeric x, y/);

    const noProfile = await toolRouter.callTool('android.status', {}, { scope: 'standard' });
    expect(noProfile.success).toBe(false);
    expect(noProfile.error).toMatch(/profile_id/);

    const emptyText = await toolRouter.callTool('android.type', { profile_id: 'p1', text: '' }, { scope: 'standard' });
    expect(emptyText.success).toBe(false);
  });

  it('screencap returns the browser.screenshot-shaped envelope', async () => {
    const res = await toolRouter.callTool('android.screencap', { profile_id: 'p1' }, { scope: 'standard' });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ format: 'png', sizeBytes: 8 });
    expect(typeof (res.data as { base64: string }).base64).toBe('string');
  });
});
