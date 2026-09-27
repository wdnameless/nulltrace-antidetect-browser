import { describe, it, expect, vi } from 'vitest';
import puppeteer from 'puppeteer-core';
import { installProxyAuth } from '../../src/main/proxy/proxyAuth';

describe('installProxyAuth CDP authentication', () => {
  it('authenticates initial page targets and registers listener for newly created targets', async () => {
    const mockPage1 = {
      authenticate: vi.fn().mockResolvedValue(undefined),
    };
    const mockTarget1 = {
      type: () => 'page',
      page: vi.fn().mockResolvedValue(mockPage1),
    };
    const mockTargetOther = {
      type: () => 'service_worker',
      page: vi.fn().mockResolvedValue(null),
    };

    let targetCreatedCallback: ((t: any) => void) | undefined;
    const mockBrowser = {
      targets: vi.fn().mockResolvedValue([mockTarget1, mockTargetOther]),
      on: vi.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'targetcreated') targetCreatedCallback = cb;
      }),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
    };

    const connectSpy = vi.spyOn(puppeteer, 'connect').mockResolvedValue(mockBrowser as any);

    const cleanup = await installProxyAuth('ws://127.0.0.1:12345', {
      username: 'test_user',
      password: 'test_password',
    });

    // 1. Initial page was authenticated
    expect(mockPage1.authenticate).toHaveBeenCalledWith({
      username: 'test_user',
      password: 'test_password',
    });

    // 2. targetcreated listener was attached
    expect(mockBrowser.on).toHaveBeenCalledWith('targetcreated', expect.any(Function));
    expect(targetCreatedCallback).toBeDefined();

    // 3. Newly created target is authenticated automatically
    const mockPage2 = {
      authenticate: vi.fn().mockResolvedValue(undefined),
    };
    const mockTarget2 = {
      type: () => 'page',
      page: vi.fn().mockResolvedValue(mockPage2),
    };
    await targetCreatedCallback!(mockTarget2);

    expect(mockPage2.authenticate).toHaveBeenCalledWith({
      username: 'test_user',
      password: 'test_password',
    });

    // 4. Non-page target is ignored
    const mockTarget3 = {
      type: () => 'background_page',
      page: vi.fn().mockResolvedValue(null),
    };
    await targetCreatedCallback!(mockTarget3);

    // 5. Cleanup removes listener and disconnects
    cleanup();
    expect(mockBrowser.removeAllListeners).toHaveBeenCalledWith('targetcreated');
    expect(mockBrowser.disconnect).toHaveBeenCalled();

    connectSpy.mockRestore();
  });
});
