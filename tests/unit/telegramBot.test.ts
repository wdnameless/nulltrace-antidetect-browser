import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TelegramBot,
  setTelegramBotFetchSeam,
  getTelegramSettings,
  saveTelegramSettings,
  notifyProfileEvent,
  notifyTaskGroupFinished,
  getTelegramBotInstance,
  resetTelegramBotInstance,
  type TelegramSettings,
} from '../../src/main/telegram/bot';
describe('TelegramBot', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = vi.fn();
    setTelegramBotFetchSeam(mockFetch);
    resetTelegramBotInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Whitelist refusal', () => {
    it('unknown chat -> single refusal, no command execution', async () => {
      const bot = new TelegramBot({
        token: 'TEST_TOKEN',
        chatIds: ['12345'],
        enabled: true,
      });

      // Mock getUpdates returning a command from an unauthorized user
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: [
            {
              update_id: 100,
              message: {
                message_id: 1,
                chat: { id: 99999 },
                text: '/status',
              },
            },
          ],
        }),
      });

      // Mock sendMessage response for refusal
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      });

      await bot.pollOnce();

      // Expect two calls: 1 for getUpdates, 1 for sendMessage refusal
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url, options] = mockFetch.mock.calls[1];
      expect(url).toContain('/sendMessage');
      const body = JSON.parse(options.body);
      expect(body.chat_id).toBe('99999');
      expect(body.text.toLowerCase()).toContain('unauthorized');
    });
  });

  describe('Backoff on errors', () => {
    it('backoff on 429 honours Retry-After', async () => {
      const bot = new TelegramBot({
        token: 'TEST_TOKEN',
        chatIds: ['12345'],
        enabled: true,
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '15' }),
        json: async () => ({
          ok: false,
          description: 'Too Many Requests',
          parameters: { retry_after: 15 },
        }),
      });

      const delay = await bot.handlePollError(429, {
        ok: false,
        parameters: { retry_after: 15 },
      });
      expect(delay).toBe(15000);
    });

    it('exponential cap 60s on repeated network failures', async () => {
      const bot = new TelegramBot({
        token: 'TEST_TOKEN',
        chatIds: ['12345'],
        enabled: true,
      });

      // Sequential failures
      expect(await bot.handlePollError(500)).toBe(1000);
      expect(await bot.handlePollError(500)).toBe(2000);
      expect(await bot.handlePollError(500)).toBe(4000);
      expect(await bot.handlePollError(500)).toBe(8000);
      expect(await bot.handlePollError(500)).toBe(16000);
      expect(await bot.handlePollError(500)).toBe(32000);
      expect(await bot.handlePollError(500)).toBe(60000); // capped at 60s
      expect(await bot.handlePollError(500)).toBe(60000); // remains capped

      // Success resets backoff
      bot.resetBackoff();
      expect(await bot.handlePollError(500)).toBe(1000);
    });
  });

  describe('Notification coalescing window 2s', () => {
    it('burst of starts -> exactly one coalesced message', async () => {
      const bot = new TelegramBot({
        token: 'TEST_TOKEN',
        chatIds: ['12345'],
        enabled: true,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      });

      bot.notify('Profile 1 started');
      bot.notify('Profile 2 started');
      bot.notify('Profile 3 started');

      // Before timer fires, no messages sent
      expect(mockFetch).not.toHaveBeenCalled();

      // Advance by 1999ms - still not sent
      vi.advanceTimersByTime(1999);
      expect(mockFetch).not.toHaveBeenCalled();

      // Advance past 2s
      vi.advanceTimersByTime(1);
      // Wait for flush promise
      await vi.runAllTimersAsync();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/sendMessage');
      const body = JSON.parse(options.body);
      expect(body.chat_id).toBe('12345');
      expect(body.text).toContain('Profile 1 started');
      expect(body.text).toContain('Profile 2 started');
      expect(body.text).toContain('Profile 3 started');
    });
  });

  describe('Settings roundtrip', () => {
    it('token + chat IDs persist via getSetting/setSetting', () => {
      const sampleSettings: TelegramSettings = {
        token: 'BOT_TOKEN_123',
        chatIds: ['1001', '1002'],
        enabled: true,
      };

      saveTelegramSettings(sampleSettings);
      const loaded = getTelegramSettings();

      expect(loaded.token).toBe('BOT_TOKEN_123');
      expect(loaded.chatIds).toEqual(['1001', '1002']);
      expect(loaded.enabled).toBe(true);
    });
  });

  describe('Command routing', () => {
    it('/start, /stop, /status, /list dispatch to the right service calls', async () => {
      const startHandler = vi.fn().mockResolvedValue('Profile started');
      const stopHandler = vi.fn().mockResolvedValue('Profile stopped');
      const statusHandler = vi.fn().mockResolvedValue('All profiles normal');
      const listHandler = vi.fn().mockResolvedValue('1. Profile A\n2. Profile B');

      const bot = new TelegramBot({
        token: 'TEST_TOKEN',
        chatIds: ['12345'],
        enabled: true,
      });

      bot.setCommandHandlers({
        start: startHandler,
        stop: stopHandler,
        status: statusHandler,
        list: listHandler,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: {} }),
      });

      await bot.executeCommand('12345', '/start profile-1');
      expect(startHandler).toHaveBeenCalledWith('profile-1');

      await bot.executeCommand('12345', '/stop profile-1');
      expect(stopHandler).toHaveBeenCalledWith('profile-1');

      await bot.executeCommand('12345', '/status');
      expect(statusHandler).toHaveBeenCalled();

      await bot.executeCommand('12345', '/list');
      expect(listHandler).toHaveBeenCalled();
    });
  });

  describe('a failing poll actually waits before the next one', () => {
    /*
     * The loop is `while (!stopRequested) await pollOnce()`. `pollOnce` used to compute the backoff
     * from `handlePollError` into a local and then `return` without waiting, so on failure — the
     * only case where the server does NOT already hold the request open for ~10s — the loop ran as
     * fast as the network answered, hammering the Telegram API during exactly the outage or 429 the
     * backoff exists for.
     *
     * The existing tests above assert `handlePollError`'s RETURN VALUE, which is why this was
     * invisible: the value was always correct, it was simply discarded.
     */
    it('waits the computed delay after an HTTP error instead of spinning', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ ok: false }),
      });
      const bot = new TelegramBot({ token: 't', chatIds: ['1'], enabled: true } as TelegramSettings);

      const started = Date.now();
      const pending = bot.pollOnce();

      // Nothing should have resolved while the backoff is still pending.
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(settled, 'pollOnce returned before its backoff elapsed').toBe(false);

      // The first failure schedules 1000ms; advancing past it must release the call.
      await vi.advanceTimersByTimeAsync(1200);
      await pending;
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(settled).toBe(true);
    });

    it('stops waiting as soon as shutdown is requested', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false }) });
      const bot = new TelegramBot({ token: 't', chatIds: ['1'], enabled: true } as TelegramSettings);

      const pending = bot.pollOnce();
      await vi.advanceTimersByTimeAsync(100);
      // A 60s backoff must not hold shutdown open.
      bot.stopPolling();
      await vi.advanceTimersByTimeAsync(400);
      await pending;
    });
  });

});
