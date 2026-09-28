import { describe, it, expect, vi } from 'vitest';
import puppeteer from 'puppeteer-core';
import { buildChromiumArgs } from '../../src/main/launcher/chromium';

describe('Screen resolution and viewport override', () => {
  it('launches headed desktop profiles maximized without forcing fixed pixel viewport box', async () => {
    const config: any = {
      profileId: 'test-headed-screen',
      userDataDir: 'D:/tmp/test-user-data',
      headless: false,
      screenOverride: { width: 2560, height: 1600 },
    };

    const args = await buildChromiumArgs(config);
    expect(args).toContain('--start-maximized');
    expect(args.some((a: string) => a.startsWith('--window-size=2560,1600'))).toBe(false);
  });

  it('keeps explicit window dimensions in headless mode for virtual rendering', async () => {
    const config: any = {
      profileId: 'test-headless-screen',
      userDataDir: 'D:/tmp/test-user-data',
      headless: true,
      screenOverride: { width: 2560, height: 1600 },
    };

    const args = await buildChromiumArgs(config);
    expect(args).toContain('--window-size=2560,1600');
    expect(args).toContain('--window-position=0,0');
    expect(args).not.toContain('--start-maximized');
  });
});
