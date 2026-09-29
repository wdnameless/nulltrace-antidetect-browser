import { describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';
import type { Page as PlaywrightPage } from 'playwright';
import {
  evaluateTlsVerdict,
  formatTlsVerdict,
  parseTlsVerdict,
  probeChromium,
  probeCamoufox,
  KNOWN_CHROMIUM_JA4,
  TLS_URL,
} from '../../../scripts/probe-tls';

describe('TLS / JA4 Limitation Record & Probe Gate', () => {
  describe('evaluateTlsVerdict', () => {
    it('evaluates identical JA4 as limitation confirmed (BoringSSL stack unchanged)', () => {
      const result = evaluateTlsVerdict(KNOWN_CHROMIUM_JA4, KNOWN_CHROMIUM_JA4);
      expect(result.verdict).toBe('identical');
      expect(result.limitationConfirmed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain('limitation confirmed');
    });

    it('evaluates differing JA4 as distinct native stacks', () => {
      const firefoxJa4 = 't13d1516h2_fa8a5a40b07b_d8a2da3f94cd';
      const result = evaluateTlsVerdict(KNOWN_CHROMIUM_JA4, firefoxJa4);
      expect(result.verdict).toBe('differ');
      expect(result.limitationConfirmed).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain('distinct native engine TLS stacks');
    });

    it('evaluates skipped secondary kernel against known baseline JA4', () => {
      const result = evaluateTlsVerdict(KNOWN_CHROMIUM_JA4, null);
      expect(result.verdict).toBe('skipped');
      expect(result.limitationConfirmed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain('confirming BoringSSL engine limitation');
    });

    it('evaluates failed when chromium JA4 is missing', () => {
      const result = evaluateTlsVerdict(null, null);
      expect(result.verdict).toBe('failed');
      expect(result.limitationConfirmed).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('formatTlsVerdict & parseTlsVerdict', () => {
    it('formats and parses identical verdict preserving limitationConfirmed', () => {
      const verdict = evaluateTlsVerdict(KNOWN_CHROMIUM_JA4, KNOWN_CHROMIUM_JA4);
      const formatted = formatTlsVerdict(KNOWN_CHROMIUM_JA4, KNOWN_CHROMIUM_JA4, verdict);

      expect(formatted).toContain('[TLS_PROBE] Chromium JA4: ' + KNOWN_CHROMIUM_JA4);
      expect(formatted).toContain('[TLS_PROBE] Verdict: identical -> limitation confirmed');
      expect(formatted).toContain('[TLS_PROBE] Limitation confirmed: true');
      expect(formatted).toContain('[TLS_PROBE] Exit code: 0');

      const parsed = parseTlsVerdict(formatted);
      expect(parsed.verdict).toBe('identical');
      expect(parsed.limitationConfirmed).toBe(true);
      expect(parsed.chromiumJa4).toBe(KNOWN_CHROMIUM_JA4);
      expect(parsed.firefoxJa4).toBe(KNOWN_CHROMIUM_JA4);
      expect(parsed.exitCode).toBe(0);
    });

    it('parses differing verdict correctly', () => {
      const firefoxJa4 = 't13d1516h2_fa8a5a40b07b_d8a2da3f94cd';
      const verdict = evaluateTlsVerdict(KNOWN_CHROMIUM_JA4, firefoxJa4);
      const formatted = formatTlsVerdict(KNOWN_CHROMIUM_JA4, firefoxJa4, verdict);

      const parsed = parseTlsVerdict(formatted);
      expect(parsed.verdict).toBe('differ');
      expect(parsed.limitationConfirmed).toBe(false);
      expect(parsed.chromiumJa4).toBe(KNOWN_CHROMIUM_JA4);
      expect(parsed.firefoxJa4).toBe(firefoxJa4);
      expect(parsed.exitCode).toBe(0);
    });

    it('parses raw text containing identical verdict line', () => {
      const rawOutput = `
=== RAW LOG ===
[TLS_PROBE] Chromium JA4: ${KNOWN_CHROMIUM_JA4}
[TLS_PROBE] Firefox JA4: ${KNOWN_CHROMIUM_JA4}
[TLS_PROBE] Verdict: identical -> limitation confirmed
[TLS_PROBE] Exit code: 0
`;
      const parsed = parseTlsVerdict(rawOutput);
      expect(parsed.verdict).toBe('identical');
      expect(parsed.limitationConfirmed).toBe(true);
      expect(parsed.chromiumJa4).toBe(KNOWN_CHROMIUM_JA4);
      expect(parsed.exitCode).toBe(0);
    });
  });

  describe('probeChromium (Hermetic)', () => {
    it('successfully probes chromium and cleans up in finally', async () => {
      const calls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/browser-profile/create')) {
          return {
            json: async () => ({ code: 0, msg: 'ok', data: { user_id: 'test-user-123' } }),
          };
        }
        if (url.includes('/browser/start')) {
          return {
            json: async () => ({
              code: 0,
              msg: 'ok',
              data: { ws: { puppeteer: 'ws://127.0.0.1:9222/devtools/browser/abc' } },
            }),
          };
        }
        if (url.includes('/browser/stop') || url.endsWith('/browser-profile/delete')) {
          return { json: async () => ({ code: 0, msg: 'ok' }) };
        }
        throw new Error(`Unexpected mockFetch url: ${url}`);
      });

      const mockDisconnect = vi.fn();
      const mockEvaluate = vi.fn().mockResolvedValue(
        JSON.stringify({
          ja3_hash: '9609f7a78377b63f2597ffc6422d3d9e',
          tls: { ja4: KNOWN_CHROMIUM_JA4 },
          user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        })
      );
      const mockGoto = vi.fn().mockResolvedValue(null);

      const mockPuppeteerConnect = vi.fn().mockResolvedValue({
        newPage: async () =>
          ({
            goto: mockGoto,
            evaluate: mockEvaluate,
          } as unknown as Page),
        disconnect: mockDisconnect,
      } as unknown as Browser);

      const result = await probeChromium(
        'http://127.0.0.1:50331',
        { Authorization: 'Bearer test' },
        {
          fetchFn: mockFetch as unknown as typeof fetch,
          puppeteerConnect: mockPuppeteerConnect,
          timeoutMs: 2000,
        }
      );

      expect(result.kernel).toBe('chromium');
      expect(result.ja4).toBe(KNOWN_CHROMIUM_JA4);
      expect(result.ja3_hash).toBe('9609f7a78377b63f2597ffc6422d3d9e');
      expect(mockGoto).toHaveBeenCalledWith(TLS_URL, expect.objectContaining({ timeout: 2000 }));
      expect(mockDisconnect).toHaveBeenCalledTimes(1);

      // Verify cleanup calls in finally
      expect(calls).toContain('http://127.0.0.1:50331/api/v1/browser/stop?user_id=test-user-123');
      expect(calls).toContain('http://127.0.0.1:50331/api/v1/browser-profile/delete');
    });

    it('guarantees profile stop and delete cleanup on page navigation timeout', async () => {
      const calls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/browser-profile/create')) {
          return {
            json: async () => ({ code: 0, msg: 'ok', data: { user_id: 'test-timeout-user' } }),
          };
        }
        if (url.includes('/browser/start')) {
          return {
            json: async () => ({
              code: 0,
              msg: 'ok',
              data: { ws: { puppeteer: 'ws://127.0.0.1:9222/devtools/browser/abc' } },
            }),
          };
        }
        if (url.includes('/browser/stop') || url.endsWith('/browser-profile/delete')) {
          return { json: async () => ({ code: 0, msg: 'ok' }) };
        }
        throw new Error(`Unexpected mockFetch url: ${url}`);
      });

      const mockDisconnect = vi.fn();
      const mockGoto = vi.fn().mockRejectedValue(new Error('Navigation timeout of 2000 ms exceeded'));

      const mockPuppeteerConnect = vi.fn().mockResolvedValue({
        newPage: async () =>
          ({
            goto: mockGoto,
          } as unknown as Page),
        disconnect: mockDisconnect,
      } as unknown as Browser);

      await expect(
        probeChromium(
          'http://127.0.0.1:50331',
          { Authorization: 'Bearer test' },
          {
            fetchFn: mockFetch as unknown as typeof fetch,
            puppeteerConnect: mockPuppeteerConnect,
            timeoutMs: 2000,
          }
        )
      ).rejects.toThrow('Navigation timeout');

      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(calls).toContain('http://127.0.0.1:50331/api/v1/browser/stop?user_id=test-timeout-user');
      expect(calls).toContain('http://127.0.0.1:50331/api/v1/browser-profile/delete');
    });
  });

  describe('probeCamoufox (Hermetic)', () => {
    it('handles skipped launch when firefox binary is unavailable and deletes profile', async () => {
      const calls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/browser-profile/create')) {
          return {
            json: async () => ({ code: 0, msg: 'ok', data: { user_id: 'ff-user-456' } }),
          };
        }
        if (url.includes('/browser/start')) {
          return {
            json: async () => ({
              code: 1,
              msg: 'Camoufox binary not found',
            }),
          };
        }
        if (url.endsWith('/browser-profile/delete')) {
          return { json: async () => ({ code: 0, msg: 'ok' }) };
        }
        throw new Error(`Unexpected mockFetch url: ${url}`);
      });

      const result = await probeCamoufox(
        'http://127.0.0.1:50331',
        { Authorization: 'Bearer test' },
        {
          fetchFn: mockFetch as unknown as typeof fetch,
          timeoutMs: 2000,
        }
      );

      expect(result.kernel).toBe('firefox');
      expect(result.skipped).toBe(true);
      expect(result.ja4).toBeNull();
      expect(calls).toContain('http://127.0.0.1:50331/api/v1/browser-profile/delete');
    });

    it('probes camoufox page successfully and cleans up in finally', async () => {
      const calls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/browser-profile/create')) {
          return {
            json: async () => ({ code: 0, msg: 'ok', data: { user_id: 'ff-running-789' } }),
          };
        }
        if (url.includes('/browser/start')) {
          return {
            json: async () => ({ code: 0, msg: 'ok', data: { ws: { puppeteer: '' } } }),
          };
        }
        if (url.includes('/browser/stop') || url.endsWith('/browser-profile/delete')) {
          return { json: async () => ({ code: 0, msg: 'ok' }) };
        }
        throw new Error(`Unexpected mockFetch url: ${url}`);
      });

      const ffJa4 = 't13d1516h2_fa8a5a40b07b_d8a2da3f94cd';
      const mockGoto = vi.fn().mockResolvedValue(null);
      const mockEvaluate = vi.fn().mockResolvedValue(
        JSON.stringify({
          ja3_hash: '3b5074b1b95c324c4c44a019de9e360a',
          tls: { ja4: ffJa4 },
        })
      );

      const mockGetPage = vi.fn().mockReturnValue({
        goto: mockGoto,
        evaluate: mockEvaluate,
      } as unknown as PlaywrightPage);

      const result = await probeCamoufox(
        'http://127.0.0.1:50331',
        { Authorization: 'Bearer test' },
        {
          fetchFn: mockFetch as unknown as typeof fetch,
          getRunningPageFn: mockGetPage,
          timeoutMs: 2000,
        }
      );

      expect(result.kernel).toBe('firefox');
      expect(result.ja4).toBe(ffJa4);
      expect(calls).toContain('http://127.0.0.1:50331/api/v1/browser/stop?user_id=ff-running-789');
      expect(calls).toContain('http://127.0.0.1:50331/api/v1/browser-profile/delete');
    });
  });
});
