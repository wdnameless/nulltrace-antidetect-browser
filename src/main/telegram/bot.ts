import { getSetting, setSetting } from '../config';

/** Canonical telegram notification event keys */
export const TELEGRAM_EVENT_KEYS: string[] = [
  'profile.started',
  'profile.stopped',
  'profile.created',
  'profile.deleted',
  'taskgroup.finished',
  'agent.activity',
];

/**
 * Default telegram notification event toggles.
 * Every event defaults to true EXCEPT agent.activity, which defaults to false:
 * an AI agent can act many times per minute (navigating, typing, clicking, inspecting DOM),
 * and emitting a Telegram push message on every single tool call floods the operator.
 * The operator explicitly requested quiet in-app toasts for high-frequency activity and
 * asked for Telegram notifications to be individually configurable.
 */
export const DEFAULT_TELEGRAM_EVENTS: Record<string, boolean> = {
  'profile.started': true,
  'profile.stopped': true,
  'profile.created': true,
  'profile.deleted': true,
  'taskgroup.finished': true,
  'agent.activity': false,
};

export interface TelegramSettings {
  token: string;
  chatIds: string[];
  enabled: boolean;
  events: Record<string, boolean>;
}

export type FetchFn = typeof globalThis.fetch;

let fetchSeam: FetchFn = globalThis.fetch;

export function setTelegramBotFetchSeam(seam: FetchFn): void {
  fetchSeam = seam;
}

export interface TelegramCommandHandlers {
  start?: (arg: string) => Promise<string>;
  stop?: (arg: string) => Promise<string>;
  status?: () => Promise<string>;
  list?: () => Promise<string>;
}

export class TelegramBot {
  private token: string;
  /**
   * Whitelisted chats.
   *
   * Dropped by an edit that added `events` beside it while keeping every use of this field, which
   * left four `this.chatIds` references pointing at nothing and the whole module failing to compile.
   * It is the destination of every notification and the access-control list for inbound commands,
   * so it is load-bearing in both directions.
   */
  private chatIds: Set<string>;
  private enabled: boolean;
  private events: Record<string, boolean>;
  private offset = 0;
  private isPolling = false;
  private stopRequested = false;
  private consecutiveErrors = 0;
  private coalescingTimer: NodeJS.Timeout | null = null;
  private queuedNotifications: string[] = [];
  private commandHandlers: TelegramCommandHandlers = {};

  constructor(settings: TelegramSettings) {
    this.token = settings.token;
    this.chatIds = new Set(settings.chatIds.map(String));
    this.enabled = settings.enabled;
    this.events = { ...DEFAULT_TELEGRAM_EVENTS, ...(settings.events || {}) };
  }

  public updateSettings(settings: TelegramSettings): void {
    this.token = settings.token;
    this.chatIds = new Set(settings.chatIds.map(String));
    this.enabled = settings.enabled;
    this.events = { ...DEFAULT_TELEGRAM_EVENTS, ...(settings.events || {}) };
  }

  public isEventEnabled(eventKey: string): boolean {
    if (typeof this.events[eventKey] === 'boolean') {
      return this.events[eventKey];
    }
    return DEFAULT_TELEGRAM_EVENTS[eventKey] ?? true;
  }

  public isEnabled(): boolean {
    return this.enabled && !!this.token;
  }

  public setCommandHandlers(handlers: TelegramCommandHandlers): void {
    this.commandHandlers = handlers;
  }

  public resetBackoff(): void {
    this.consecutiveErrors = 0;
  }

  public async handlePollError(status?: number, responseData?: unknown): Promise<number> {
    const data = responseData as { parameters?: { retry_after?: number } } | undefined;
    if (status === 429 && data?.parameters?.retry_after) {
      return data.parameters.retry_after * 1000;
    }
    this.consecutiveErrors++;
    const backoff = Math.min(1000 * Math.pow(2, this.consecutiveErrors - 1), 60000);
    return backoff;
  }

  public async sendMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.token) return false;
    try {
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      const res = await fetchSeam(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(chatId),
          text,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  public notify(message: string): void {
    if (!this.isEnabled()) return;
    this.queuedNotifications.push(message);

    if (!this.coalescingTimer) {
      this.coalescingTimer = setTimeout(() => {
        this.flushNotifications();
      }, 2000);
    }
  }

  public async flushNotifications(): Promise<void> {
    if (this.coalescingTimer) {
      clearTimeout(this.coalescingTimer);
      this.coalescingTimer = null;
    }

    if (this.queuedNotifications.length === 0) return;

    const messages = [...this.queuedNotifications];
    this.queuedNotifications = [];
    const combined = messages.join('\n');

    for (const chatId of this.chatIds) {
      await this.sendMessage(chatId, combined);
    }
  }

  public async executeCommand(chatId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    let reply = '';
    switch (cmd) {
      case '/start':
        if (this.commandHandlers.start) {
          reply = await this.commandHandlers.start(arg);
        } else {
          reply = 'Start command received';
        }
        break;
      case '/stop':
        if (this.commandHandlers.stop) {
          reply = await this.commandHandlers.stop(arg);
        } else {
          reply = 'Stop command received';
        }
        break;
      case '/status':
        if (this.commandHandlers.status) {
          reply = await this.commandHandlers.status();
        } else {
          reply = 'Status: running';
        }
        break;
      case '/list':
        if (this.commandHandlers.list) {
          reply = await this.commandHandlers.list();
        } else {
          reply = 'No profiles configured';
        }
        break;
      default:
        reply = `Unknown command: ${cmd}`;
        break;
    }

    if (reply) {
      await this.sendMessage(chatId, reply);
    }
  }

  public async pollOnce(): Promise<void> {
    if (!this.token) return;
    try {
      /*
       * A long-poll `timeout=10` means a healthy call already blocks ~10s on the server side. On
       * FAILURE it returns immediately, and the loop below is a `while` with no delay of its own —
       * so an error path used to spin as fast as the network answered, hammering the Telegram API
       * during exactly the outage or 429 that the computed backoff exists to handle. Measured: the
       * delay from `handlePollError` was awaited into a local and then dropped by `return`.
       *
       * Waiting here is the fix, and it is applied on every failing branch below.
       */
      const url = `https://api.telegram.org/bot${this.token}/getUpdates?offset=${this.offset}&timeout=10`;
      const res = await fetchSeam(url);
      const data = (await res.json()) as {
        ok?: boolean;
        result?: Array<{
          update_id: number;
          message?: { text?: string; chat?: { id?: number | string } };
        }>;
        parameters?: { retry_after?: number };
      };

      if (!res.ok || !data.ok) {
        const delay = await this.handlePollError(res.status, data);
        await this.sleepInterruptibly(delay);
        return;
      }

      this.resetBackoff();

      const updates = data.result || [];
      for (const update of updates) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const msg = update.message;
        if (!msg || !msg.text) continue;

        const chatId = String(msg.chat?.id ?? '');
        if (!this.chatIds.has(chatId)) {
          // Whitelist refusal: unknown chats get a single refusal, not an error echo
          await this.sendMessage(chatId, 'Unauthorized: chat ID not whitelisted.');
          continue;
        }

        await this.executeCommand(chatId, msg.text);
      }
    } catch {
      const delay = await this.handlePollError();
      await this.sleepInterruptibly(delay);
    }
  }

  /**
   * Wait, but wake immediately when shutdown is requested.
   *
   * A plain `setTimeout` would make shutdown wait out the full backoff — up to 60s — which is why
   * the wait is interruptible rather than merely delayed.
   */
  private sleepInterruptibly(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, ms);
      const poll = setInterval(() => {
        if (this.stopRequested) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 200);
      // Never hold the event loop open on this timer alone.
      poll.unref?.();
      timer.unref?.();
    });
  }

  public startPolling(): void {
    if (this.isPolling || !this.isEnabled()) return;
    this.isPolling = true;
    this.stopRequested = false;

    const pollLoop = async () => {
      while (!this.stopRequested && this.isEnabled()) {
        await this.pollOnce();
      }
      this.isPolling = false;
    };

    pollLoop().catch(() => {
      this.isPolling = false;
    });
  }

  public stopPolling(): void {
    this.stopRequested = true;
    this.isPolling = false;
    if (this.coalescingTimer) {
      clearTimeout(this.coalescingTimer);
      this.coalescingTimer = null;
    }
  }
}

/**
 * Stored events with every key present.
 *
 * Back-fills an install that predates per-event settings, and ignores anything stored that is not a
 * boolean so a corrupted value cannot silently disable a notification. One implementation shared by
 * the reader and the writer: two copies of this rule would drift, and the writer is the one that
 * decides whether an omitted key survives a save.
 */
function normalizeEvents(raw: unknown): Record<string, boolean> {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const events: Record<string, boolean> = { ...DEFAULT_TELEGRAM_EVENTS };
  for (const key of TELEGRAM_EVENT_KEYS) {
    if (typeof stored[key] === 'boolean') events[key] = stored[key] as boolean;
  }
  return events;
}

export function getTelegramSettings(): TelegramSettings {
  const token = (getSetting('telegram_bot_token') as string) || '';
  const rawChatIds = (getSetting('telegram_chat_ids') as string[]) || [];
  const enabled = (getSetting('telegram_bot_enabled') as boolean) || false;

  return {
    token,
    chatIds: Array.isArray(rawChatIds) ? rawChatIds : [],
    enabled: Boolean(enabled),
    events: normalizeEvents(getSetting('telegram_events')),
  };
}

/**
 * Persist settings.
 *
 * `events` is MERGED over what is already stored, never written through.
 *
 * A caller that omits it means "leave the per-event routing alone", not "reset it": the settings
 * form sends the whole map, but an internal caller (a test, a script, a future partial save) has no
 * reason to know the key exists, and writing `undefined` there silently discarded the operator's
 * choices and flipped `agent.activity` back to its off default. Measured by a test that turned the
 * key on, saved without it, and read it back as off.
 */
export function saveTelegramSettings(settings: TelegramSettings): void {
  const merged: TelegramSettings = {
    ...settings,
    events: { ...DEFAULT_TELEGRAM_EVENTS, ...normalizeEvents(getSetting('telegram_events')), ...settings.events },
  };

  setSetting('telegram_bot_token', merged.token);
  setSetting('telegram_chat_ids', merged.chatIds);
  setSetting('telegram_bot_enabled', merged.enabled);
  setSetting('telegram_events', merged.events);

  // Update singleton instance if present
  if (globalTelegramBot) {
    globalTelegramBot.updateSettings(merged);
    if (!merged.enabled) {
      globalTelegramBot.stopPolling();
    } else {
      globalTelegramBot.startPolling();
    }
  }
}

let globalTelegramBot: TelegramBot | null = null;

export function getTelegramBotInstance(): TelegramBot {
  if (!globalTelegramBot) {
    const settings = getTelegramSettings();
    globalTelegramBot = new TelegramBot(settings);
  }
  return globalTelegramBot;
}

export function resetTelegramBotInstance(): void {
  if (globalTelegramBot) {
    globalTelegramBot.stopPolling();
  }
  globalTelegramBot = null;
}

export function notifyProfileStarted(profileId: string, profileName?: string): void {
  notifyProfileEvent('started', profileId, profileName);
}

export function notifyProfileStopped(profileId: string, profileName?: string): void {
  notifyProfileEvent('stopped', profileId, profileName);
}

export function notifyProfileEvent(action: 'started' | 'stopped' | 'created' | 'deleted', profileId: string, profileName?: string): void {
  const bot = getTelegramBotInstance();
  if (!bot.isEnabled()) return;
  const eventKey = `profile.${action}`;
  if (!bot.isEventEnabled(eventKey)) return;
  const nameDisplay = profileName ? ` (${profileName})` : '';
  bot.notify(`Profile ${action}: ${profileId}${nameDisplay}`);
}

export function notifyTaskGroupFinished(groupId: string | number, status: string, groupName?: string): void {
  const bot = getTelegramBotInstance();
  if (!bot.isEnabled()) return;
  if (!bot.isEventEnabled('taskgroup.finished')) return;
  const nameDisplay = groupName ? ` (${groupName})` : '';
  bot.notify(`Task group finished: ${groupId}${nameDisplay} with status: ${status}`);
}

export function notifyAgentActivity(summary: string): void {
  const bot = getTelegramBotInstance();
  if (!bot.isEnabled()) return;
  if (!bot.isEventEnabled('agent.activity')) return;
  bot.notify(`Agent activity: ${summary}`);
}
