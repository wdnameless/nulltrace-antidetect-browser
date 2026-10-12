/**
 * Reports what the MCP server just did, so the desktop interface can show it.
 *
 * The operator runs profiles through an AI agent and could not see it happening:
 * «когда агент дергает опишку, у нас должно приходить уведомления, что он что-то дергает и что-то
 * делает». The backend already observes every action that arrives over its HTTP API, but this
 * process reaches the browser two ways — some tools call the API, and six drive puppeteer straight
 * at the profile's DevTools endpoint (`browser.navigate`, `browser.click`, `browser.type`,
 * `browser.screenshot`, `browser.human_type`, `browser.human_click`). Those never touch the backend,
 * so without this reporter the feed would omit exactly the actions that matter most.
 *
 * Two rules make this safe to call from the hot path of every tool:
 *
 *  - It NEVER throws and NEVER rejects. Reporting is a courtesy; a tool call must not fail because
 *    the panel is closed, the backend is restarting, or the network hiccuped.
 *  - It NEVER blocks the caller. The request is fire-and-forget, so a slow panel cannot add latency
 *    to an agent's automation. Failures are dropped silently — there is no one to tell, and a
 *    retry queue for telemetry would be a worse bug than the missing line.
 */

/** Tool names whose effect is invisible to the backend because they use CDP directly. */
export const CDP_DIRECT_TOOLS: Record<string, true> = {
  'browser.navigate': true,
  'browser.click': true,
  'browser.type': true,
  'browser.screenshot': true,
  'browser.human_type': true,
  'browser.human_click': true,
  'browser.evaluate_allowlisted': true,
  'browser.run_round': true,
  'browser.snapshot': true,
  'browser.tabs': true,
};

export interface ActivityReporterOptions {
  /** Backend origin, e.g. `http://127.0.0.1:50325`. Empty disables reporting. */
  apiBaseUrl: string;
  /** Bearer token for the backend. Empty disables reporting. */
  token?: string;
}

/**
 * Sends one activity notification.
 *
 * `profileId` is included when the tool names a profile, because the panel renders it as the
 * subject of the sentence — "Navigated to a page in p_abc" rather than a bare verb.
 */
export class ActivityReporter {
  private readonly apiBaseUrl: string;
  private readonly token: string;

  constructor(options: ActivityReporterOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.token = options.token ?? '';
  }

  /** Whether reporting can work at all; a missing URL or token disables it rather than erroring. */
  public isEnabled(): boolean {
    return this.apiBaseUrl.length > 0 && this.token.length > 0;
  }

  /**
   * Report a completed tool call. Returns immediately; the request continues in the background.
   */
  public report(tool: string, profileId?: string): void {
    if (!this.isEnabled()) return;
    try {
      void fetch(`${this.apiBaseUrl}/api/v1/agent-activity`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          // Lets the backend classify this as agent traffic without guessing from the user agent.
          'X-NullTrace-Client': 'mcp',
        },
        body: JSON.stringify(profileId ? { tool, profileId } : { tool }),
      }).catch(() => undefined);
    } catch {
      // `fetch` itself can throw synchronously in unusual environments; reporting never propagates.
    }
  }
}
