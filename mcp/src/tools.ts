import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAuthorized, isProhibitedTool } from './auth';
import { isAnnounceableTool } from '../../src/main/agentActivity';
import { ActivityReporter } from './activityReporter';
import { McpAuditLogger } from './audit';
import { AntidetectClient } from '@antidetect/sdk';
import { BrowserDriver } from './browser';

import { redactSensitiveArgs } from './redaction';
// The manifest is data-only, so it can also be imported by the main process without
// pulling this module's runtime dependencies (notably @antidetect/sdk) along with it.
import { TOOL_DEFINITIONS } from './toolManifest';
export { TOOL_DEFINITIONS };
export interface AllowlistEntry {
  id: string;
  name: string;
  description: string;
  params?: Record<string, unknown>;
  code: string;
}

export interface AllowlistRegistry {
  version: string;
  scripts: Record<string, AllowlistEntry>;
}



export class ToolRouter {
  private readonly client: AntidetectClient;
  private readonly browserDriver: BrowserDriver;
  private readonly auditLogger: McpAuditLogger;
  private readonly activityReporter: ActivityReporter;
  private readonly allowlist: Map<string, AllowlistEntry> = new Map();

  constructor(options?: {
    client?: AntidetectClient;
    browserDriver?: BrowserDriver;
    auditLogger?: McpAuditLogger;
    activityReporter?: ActivityReporter;
    allowlistPath?: string;
  }) {
    // The API lives on the app's own loopback port, and every /api/v1 route requires a
    // Bearer token. Two defects lived here:
    //  - the default was `http://127.0.0.1:3000`, a port this app never listens on, so a
    //    standalone MCP process pointed at nothing;
    //  - no token was ever passed, so even with the right URL every tool call returned 401.
    // Both values now come from the environment, which `mcpService` fills from the running
    // app's real host/port/key.
    const apiBaseUrl =
      process.env.ANTIDETECT_API_URL || `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || '50325'}`;
    this.client =
      options?.client ||
      new AntidetectClient({
        baseUrl: apiBaseUrl,
        token: process.env.ANTIDETECT_API_TOKEN || undefined,
      });
    this.browserDriver = options?.browserDriver || new BrowserDriver(this.client);
    this.auditLogger = options?.auditLogger || new McpAuditLogger();
    this.activityReporter =
      options?.activityReporter ||
      new ActivityReporter({ apiBaseUrl, token: process.env.ANTIDETECT_API_TOKEN });

    const allowlistFile = options?.allowlistPath || path.resolve(__dirname, '../allowlist.json');
    this.loadAllowlist(allowlistFile);
  }

  private loadAllowlist(filePath: string): void {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const json = JSON.parse(raw) as AllowlistRegistry;
        if (json.scripts) {
          for (const [key, val] of Object.entries(json.scripts)) {
            this.allowlist.set(key, val);
          }
        }
      } catch (err) {
        console.error('[ToolRouter] Failed to parse allowlist.json:', err);
      }
    }
  }

  private async requestBackend<T = unknown>(
    path: string,
    options?: { method?: string; body?: unknown; query?: Record<string, unknown> }
  ): Promise<{ data: T }> {
    // SAFETY: AntidetectClient defines request() for generic HTTP endpoints
    const apiClient = this.client as unknown as {
      request: (p: string, opts?: { method?: string; body?: unknown; query?: Record<string, unknown> }) => Promise<{ data: T }>;
    };
    return await apiClient.request(path, options);
  }

  public getAllowlist(): Map<string, AllowlistEntry> {
    return this.allowlist;
  }

  public listTools(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  public async callTool(
    name: string,
    args: Record<string, unknown> = {},
    context: { scope?: string; caller?: string; nonce?: string; allowedGatedEnv?: string } = {}
  ): Promise<{ success: boolean; data?: unknown; error?: string; isForbidden?: boolean; isProhibited?: boolean }> {
    const caller = context.caller || 'mcp-agent';
    const nonce = context.nonce || `nonce_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const scope = context.scope || 'standard';
    // Redaction happens BEFORE hashing/logging so audit logs never contain raw secrets
    // and the hash chain remains verifiable against redacted parameters.
    const auditedArgs = redactSensitiveArgs(args);
    if (isProhibitedTool(name)) {
      this.auditLogger.log({
        nonce,
        tool: name,
        args: auditedArgs,
        decision: 'deny',
        error: 'Prohibited operation',
        caller,
      });
      return {
        success: false,
        error: `Prohibited operation: '${name}' violates safety policy`,
        isProhibited: true,
      };
    }

    if (!isAuthorized(name, scope, context.allowedGatedEnv)) {
      this.auditLogger.log({
        nonce,
        tool: name,
        args: auditedArgs,
        decision: 'deny',
        error: 'Insufficient permissions',
        caller,
      });
      return {
        success: false,
        error: `Forbidden: Scope '${scope}' cannot execute tool '${name}'`,
        isForbidden: true,
      };
    }

    try {
      const result = await this.executeToolInternal(name, args);
      this.auditLogger.log({
        nonce,
        tool: name,
        args: auditedArgs,
        decision: 'allow',
        caller,
      });
      /*
       * Report the action so the desktop panel can show it.
       *
       * Only on success, and only for tools that actually changed something: a refused or failed
       * call is not something to tell the operator about, and announcing reads would bury the real
       * actions. `isAnnounceableTool` owns that distinction.
       *
       * Deliberately NOT awaited — see `ActivityReporter`. Reporting must not add latency to an
       * agent's automation or be able to fail a tool that already succeeded.
       */
      if (isAnnounceableTool(name)) {
        this.activityReporter.report(name, typeof args.profile_id === 'string' ? args.profile_id : undefined);
      }
      return { success: true, data: result };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.auditLogger.log({
        nonce,
        tool: name,
        args: auditedArgs,
        decision: 'error',
        error: errMsg,
        caller,
      });
      return { success: false, error: errMsg };
    }
  }

  private async executeToolInternal(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'profiles.list': {
        const resp = await this.client.profiles.list(args as any);
        return resp.data;
      }
      case 'profiles.get': {
        const profileId = String(args.profile_id || '');
        const resp = await this.client.profiles.get(profileId);
        return resp.data;
      }
      case 'profiles.create': {
        const resp = await this.client.profiles.create(args as any);
        return resp.data;
      }
      case 'profiles.start': {
        const profileId = String(args.profile_id || '');
        const headless = Boolean(args.headless);
        const resp = await this.client.browser.start(profileId, { headless });
        return resp.data;
      }
      case 'profiles.stop': {
        const profileId = String(args.profile_id || '');
        const resp = await this.client.browser.stop(profileId);
        return resp.data;
      }
      case 'browser.navigate': {
        const profileId = String(args.profile_id || '');
        const url = String(args.url || '');
        return await this.browserDriver.navigate(profileId, url);
      }
      case 'browser.click': {
        const profileId = String(args.profile_id || '');
        const selector = String(args.selector || '');
        return await this.browserDriver.click(profileId, selector);
      }
      case 'browser.type': {
        const profileId = String(args.profile_id || '');
        const selector = String(args.selector || '');
        const text = String(args.text || '');
        return await this.browserDriver.type(profileId, selector, text);
      }
      case 'browser.screenshot': {
        const profileId = String(args.profile_id || '');
        const fullPage = Boolean(args.full_page);
        return await this.browserDriver.screenshot(profileId, fullPage);
      }
      case 'browser.human_type': {
        const profileId = String(args.profile_id || '');
        const selector = String(args.selector || '');
        const text = String(args.text || '');
        const allowTypos = Boolean(args.allow_typos);
        return await this.browserDriver.humanType(profileId, selector, text, allowTypos);
      }
      case 'browser.human_click': {
        const profileId = String(args.profile_id || '');
        const selector = String(args.selector || '');
        const targetWidth = Number(args.target_width) > 0 ? Number(args.target_width) : 32;
        return await this.browserDriver.humanClick(profileId, selector, targetWidth);
      }
      case 'browser.run_round': {
        const profileId = String(args.profile_id || '');
        const code = String(args.code || '');
        const timeoutMs = args.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined;
        try {
          const resp = await this.requestBackend<{ console?: string[]; result?: unknown; error?: string; error_code?: string }>(
            `/api/v1/browser/${encodeURIComponent(profileId)}/round`,
            {
              method: 'POST',
              body: { code, timeout_ms: timeoutMs },
            }
          );
          return resp.data;
        } catch (err: unknown) {
          const errorObj = err as {
            status?: number;
            data?: { error_code?: string; error?: string; data?: { console?: string[]; result?: unknown } };
            message?: string;
          } | null;
          if (
            errorObj?.status === 409 ||
            errorObj?.data?.error_code === 'USER_IN_CONTROL' ||
            errorObj?.data?.error === 'USER_IN_CONTROL' ||
            (typeof errorObj?.message === 'string' && errorObj.message.includes('USER_IN_CONTROL'))
          ) {
            return {
              error: 'USER_IN_CONTROL',
              error_code: 'USER_IN_CONTROL',
              console: errorObj?.data?.data?.console || [],
              result: null,
            };
          }
          if (errorObj?.data?.data && errorObj?.data?.error) {
            return errorObj.data.data;
          }
          throw err;
        }
      }
      case 'browser.snapshot': {
        const profileId = String(args.profile_id || '');
        const snapshotOpts: Record<string, unknown> = {};
        if (args.scope !== undefined) snapshotOpts.scope = args.scope;
        if (args.root !== undefined) snapshotOpts.root = args.root;
        if (args.page !== undefined) snapshotOpts.pageLabel = args.page;
        if (args.pageLabel !== undefined) snapshotOpts.pageLabel = args.pageLabel;


        const code = `return await app.browser.snapshot(${JSON.stringify(snapshotOpts)});`;
        const roundRes = (await this.executeToolInternal('browser.run_round', {
          profile_id: profileId,
          code,
        })) as { error_code?: string; error?: string; result?: unknown } | null;

        if (roundRes && typeof roundRes === 'object') {
          if (roundRes.error_code === 'USER_IN_CONTROL') {
            return roundRes;
          }
          if (roundRes.result !== undefined && roundRes.result !== null) {
            return roundRes.result;
          }
          if (roundRes.error) {
            throw new Error(String(roundRes.error));
          }
        }
        return roundRes;
      }
      case 'browser.tabs': {
        const profileId = String(args.profile_id || '');
        try {
          const roundRes = (await this.executeToolInternal('browser.run_round', {
            profile_id: profileId,
            code: 'return await app.browser.tabs();',
          })) as { error_code?: string; result?: unknown } | null;
          if (roundRes && typeof roundRes === 'object') {
            if (roundRes.error_code === 'USER_IN_CONTROL') {
              if (this.browserDriver && typeof this.browserDriver.listTabs === 'function') {
                return await this.browserDriver.listTabs(profileId);
              }
              return roundRes;
            }
            if (roundRes.result !== undefined && roundRes.result !== null) {
              return roundRes.result;
            }
          }
          return roundRes;
        } catch (roundErr: unknown) {
          if (this.browserDriver && typeof this.browserDriver.listTabs === 'function') {
            return await this.browserDriver.listTabs(profileId);
          }
          throw roundErr;
        }
      }
      case 'diagnostics.run': {
        const profileId = String(args.profile_id || '');
        const resp = await this.client.diagnostics.run(profileId);
        return resp.data;
      }

      // Tier 1.5+ surface: proxies / extensions / flows / task groups / trash / triggers / tags / batch
      case 'proxies.list': {
        const resp = await this.client.proxy.list();
        return resp.data;
      }
      case 'proxies.create': {
        const resp = await this.client.proxy.create({
          type: String(args.type || ''),
          host: String(args.host || ''),
          port: Number(args.port),
          ...(args.username !== undefined ? { username: String(args.username) } : {}),
          ...(args.password !== undefined ? { password: String(args.password) } : {}),
          ...(args.privateKey !== undefined ? { privateKey: String(args.privateKey) } : {}),
        });
        return resp.data;
      }
      case 'proxies.check': {
        const proxyId = String(args.proxy_id || '');
        const resp = await this.client.proxy.check(proxyId);
        return resp.data;
      }
      case 'extensions.list': {
        const resp = await (this.client as any).request('/api/v1/extension/list', { method: 'GET' });
        return resp.data;
      }
      case 'extensions.install': {
        const payload: Record<string, unknown> = {};
        if (args.url !== undefined) payload.url = String(args.url);
        if (args.id !== undefined) payload.id = String(args.id);
        if (args.path !== undefined) payload.path = String(args.path);
        const resp = await (this.client as any).request('/api/v1/extension/install', { method: 'POST', body: payload });
        return resp.data;
      }
      case 'flows.list': {
        const resp = await (this.client as any).request('/api/flows', { method: 'GET' });
        return resp.data;
      }
      case 'flows.get': {
        const flowId = String(args.flow_id || '');
        const resp = await (this.client as any).request(`/api/flows/${encodeURIComponent(flowId)}`, { method: 'GET' });
        return resp.data;
      }
      case 'flows.run': {
        const flowId = String(args.flow_id || '');
        const body: Record<string, unknown> = { profile_ids: args.profile_ids };
        if (args.concurrency !== undefined) body.concurrency = Number(args.concurrency);
        if (args.trigger !== undefined) body.trigger = String(args.trigger);
        if (args.cron_schedule !== undefined) body.cron_schedule = String(args.cron_schedule);
        const resp = await (this.client as any).request(`/api/flows/${encodeURIComponent(flowId)}/run`, { method: 'POST', body });
        return resp.data;
      }
      case 'flows.validate': {
        const flowId = args.flow_id !== undefined ? String(args.flow_id) : undefined;
        const payload = args.document !== undefined ? (args.document as Record<string, unknown>) : undefined;
        if (flowId) {
          // POST /api/flows/:id/validate validates the stored flow
          const resp = await (this.client as any).request(`/api/flows/${encodeURIComponent(flowId)}/validate`, { method: 'POST', body: {} });
          return resp.data;
        }
        if (payload) {
          // POST /api/flows/validate validates an inline document
          const resp = await (this.client as any).request('/api/flows/validate', { method: 'POST', body: payload });
          return resp.data;
        }
        throw new Error('flows.validate requires either flow_id or an inline document');
      }
      case 'task_groups.list': {
        const resp = await (this.client as any).request('/api/task-groups', { method: 'GET' });
        return resp.data;
      }
      case 'task_groups.get': {
        const groupId = String(args.group_id || '');
        const resp = await (this.client as any).request(`/api/task-groups/${encodeURIComponent(groupId)}`, { method: 'GET' });
        return resp.data;
      }
      case 'task_groups.tasks': {
        const groupId = String(args.group_id || '');
        const resp = await (this.client as any).request(`/api/task-groups/${encodeURIComponent(groupId)}/tasks`, { method: 'GET' });
        return resp.data;
      }
      case 'task_groups.start': {
        const groupId = String(args.group_id || '');
        const resp = await (this.client as any).request(`/api/task-groups/${encodeURIComponent(groupId)}/start`, { method: 'POST', body: {} });
        return resp.data;
      }
      case 'task_groups.stop': {
        const groupId = String(args.group_id || '');
        const resp = await (this.client as any).request(`/api/task-groups/${encodeURIComponent(groupId)}/stop`, { method: 'POST', body: {} });
        return resp.data;
      }
      case 'trash.list': {
        const resp = await (this.client as any).request('/api/v1/trash', { method: 'GET' });
        return resp.data;
      }
      case 'triggers.list': {
        const resp = await (this.client as any).request('/api/v1/triggers', { method: 'GET' });
        return resp.data;
      }
      case 'triggers.create': {
        const body: Record<string, unknown> = {
          name: String(args.name || ''),
          script_id: String(args.script_id || ''),
          type: String(args.type || ''),
        };
        if (args.schedule !== undefined) body.schedule = String(args.schedule);
        if (args.event !== undefined) body.event = String(args.event);
        const resp = await (this.client as any).request('/api/v1/triggers', { method: 'POST', body });
        return resp.data;
      }
      case 'triggers.toggle': {
        const triggerId = String(args.trigger_id || '');
        const enabled = Boolean(args.enabled);
        const resp = await (this.client as any).request(`/api/v1/triggers/${encodeURIComponent(triggerId)}/toggle`, {
          method: 'POST',
          body: { enabled },
        });
        return resp.data;
      }
      case 'tags.list': {
        const resp = await (this.client as any).request('/api/v1/tags', { method: 'GET' });
        return resp.data;
      }
      case 'tags.attach': {
        const tagId = String(args.tag_id || '');
        const userIds = Array.isArray(args.user_ids) ? (args.user_ids as unknown[]) : [];
        const resp = await (this.client as any).request(`/api/v1/tags/${encodeURIComponent(tagId)}/attach`, {
          method: 'POST',
          body: { user_ids: userIds },
        });
        return resp.data;
      }
      case 'tags.detach': {
        const tagId = String(args.tag_id || '');
        const userIds = Array.isArray(args.user_ids) ? (args.user_ids as unknown[]) : [];
        const resp = await (this.client as any).request(`/api/v1/tags/${encodeURIComponent(tagId)}/detach`, {
          method: 'POST',
          body: { user_ids: userIds },
        });
        return resp.data;
      }
      case 'batch.start': {
        const userIds = Array.isArray(args.user_ids) ? (args.user_ids as unknown[]) : [];
        const resp = await (this.client as any).request('/api/v1/browser-profile/bulk-start', {
          method: 'POST',
          body: { user_ids: userIds },
        });
        return resp.data;
      }
      case 'batch.stop': {
        const userIds = Array.isArray(args.user_ids) ? (args.user_ids as unknown[]) : [];
        const resp = await (this.client as any).request('/api/v1/browser-profile/bulk-stop', {
          method: 'POST',
          body: { user_ids: userIds },
        });
        return resp.data;
      }

      // Gated Tools
      case 'profiles.delete': {
        const profileId = String(args.profile_id || '');
        const resp = await this.client.profiles.delete(profileId);
        return resp.data;
      }
      case 'profiles.restore': {
        const profileId = String(args.profile_id || '');
        // Calls POST /api/v1/trash/:id/restore via generic client request
        const resp = await (this.client as any).request(`/api/v1/trash/${encodeURIComponent(profileId)}/restore`, {
          method: 'POST',
        });
        return resp.data;
      }
      case 'profiles.export_preserved': {
        const registryId = String(args.registry_id || '');
        const resp = await (this.client as any).request(`/api/v1/preserved-browser-data/${encodeURIComponent(registryId)}/export`, {
          method: 'POST',
        });
        return resp.data;
      }
      case 'profiles.cleanup_preserved': {
        const registryId = String(args.registry_id || '');
        const confirmation = String(args.confirmation || '');
        const resp = await (this.client as any).request(`/api/v1/preserved-browser-data/${encodeURIComponent(registryId)}/cleanup`, {
          method: 'POST',
          body: { confirmation },
        });
        return resp.data;
      }
      case 'browser.evaluate_allowlisted': {
        const profileId = String(args.profile_id || '');
        const scriptId = String(args.script_id || '');
        const params = (args.params as Record<string, unknown>) || {};

        const scriptEntry = this.allowlist.get(scriptId);
        if (!scriptEntry) {
          throw new Error(`Script ID '${scriptId}' is not registered in mcp allowlist. Arbitrary script evaluation is prohibited.`);
        }

        return await this.browserDriver.evaluateAllowlisted(profileId, scriptEntry.code, params);
      }
      case 'proxies.delete': {
        const proxyId = String(args.proxy_id || '');
        const resp = await this.client.proxy.delete(proxyId);
        return resp.data;
      }
      case 'extensions.delete': {
        const extensionId = String(args.extension_id || '');
        const resp = await (this.client as any).request('/api/v1/extension/delete', {
          method: 'POST',
          body: { extension_id: extensionId },
        });
        return resp.data;
      }
      case 'trash.delete_forever': {
        const profileId = String(args.profile_id || '');
        // POST /api/v1/trash/:id/delete purges a soft-deleted profile permanently.
        const resp = await (this.client as any).request(`/api/v1/trash/${encodeURIComponent(profileId)}/delete`, {
          method: 'POST',
        });
        return resp.data;
      }
      case 'cookies.export': {
        const profileId = String(args.profile_id || '');
        const format = args.format !== undefined ? String(args.format) : 'json';
        const resp = await (this.client as any).request('/api/v1/browser-profile/cookies/export', {
          method: 'GET',
          query: { user_id: profileId, format },
        });
        return resp.data;
      }
      case 'cookies.import': {
        const profileId = String(args.profile_id || '');
        const body: Record<string, unknown> = { user_id: profileId };
        if (args.cookies !== undefined) body.cookies = args.cookies;
        if (args.format !== undefined) body.format = String(args.format);
        if (args.text !== undefined) body.text = String(args.text);
        const resp = await (this.client as any).request('/api/v1/browser-profile/cookies/import', {
          method: 'POST',
          body,
        });
        return resp.data;
      }
      case 'triggers.delete': {
        const triggerId = String(args.trigger_id || '');
        const resp = await (this.client as any).request(`/api/v1/triggers/${encodeURIComponent(triggerId)}/delete`, {
          method: 'POST',
          body: {},
        });
        return resp.data;
      }
      case 'batch.delete': {
        const userIds = Array.isArray(args.user_ids) ? (args.user_ids as unknown[]) : [];
        const resp = await (this.client as any).request('/api/v1/browser-profile/bulk-delete', {
          method: 'POST',
          body: { user_ids: userIds },
        });
        return resp.data;
      }
      // Email tools (Default tier)
      case 'email.accounts.list': {
        const query: Record<string, unknown> = {};
        // null means "unbound accounts" — forward as '' (REST maps '' to IS NULL),
        // matching the SDK; String(null) would query the literal "null".
        if (args.profile_id !== undefined) query.profile_id = args.profile_id === null ? '' : String(args.profile_id);
        const resp = await this.requestBackend('/api/v1/email/accounts', {
          method: 'GET',
          query: Object.keys(query).length > 0 ? query : undefined,
        });
        return resp.data;
      }
      case 'email.accounts.get': {
        const accountId = String(args.account_id || '');
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}`, {
          method: 'GET',
        });
        return resp.data;
      }
      case 'email.accounts.create': {
        const body: Record<string, unknown> = {
          email: String(args.email || ''),
          host: String(args.host || ''),
          username: String(args.username || ''),
        };
        if (args.port !== undefined) body.port = Number(args.port);
        if (args.password !== undefined) body.password = String(args.password);
        if (args.label !== undefined) body.label = String(args.label);
        if (args.display_name !== undefined) body.display_name = String(args.display_name);
        if (args.signature !== undefined) body.signature = String(args.signature);
        if (args.smtp_host !== undefined) body.smtp_host = String(args.smtp_host);
        if (args.smtp_port !== undefined) body.smtp_port = args.smtp_port === null ? null : Number(args.smtp_port);
        if (args.smtp_secure !== undefined) body.smtp_secure = args.smtp_secure === null ? null : Boolean(args.smtp_secure);
        if (args.profile_id !== undefined) body.profile_id = args.profile_id ? String(args.profile_id) : null;
        const resp = await this.requestBackend('/api/v1/email/accounts', {
          method: 'POST',
          body,
        });
        return resp.data;
      }
      case 'email.accounts.update': {
        const accountId = String(args.account_id || '');
        const body: Record<string, unknown> = {};
        if (args.email !== undefined) body.email = String(args.email);
        if (args.host !== undefined) body.host = String(args.host);
        if (args.port !== undefined) body.port = Number(args.port);
        if (args.username !== undefined) body.username = String(args.username);
        if (args.password !== undefined) body.password = String(args.password);
        if (args.label !== undefined) body.label = String(args.label);
        if (args.display_name !== undefined) body.display_name = String(args.display_name);
        if (args.signature !== undefined) body.signature = String(args.signature);
        if (args.smtp_host !== undefined) body.smtp_host = String(args.smtp_host);
        if (args.smtp_port !== undefined) body.smtp_port = args.smtp_port === null ? null : Number(args.smtp_port);
        if (args.smtp_secure !== undefined) body.smtp_secure = args.smtp_secure === null ? null : Boolean(args.smtp_secure);
        if (args.profile_id !== undefined) body.profile_id = args.profile_id ? String(args.profile_id) : null;
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}`, {
          method: 'PATCH',
          body,
        });
        return resp.data;
      }
      case 'email.accounts.bind_profile': {
        const accountId = String(args.account_id || '');
        const profileId = args.profile_id !== undefined && args.profile_id !== null ? String(args.profile_id) : null;
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}/bind-profile`, {
          method: 'POST',
          body: { profile_id: profileId },
        });
        return resp.data;
      }
      case 'email.folders.list': {
        const accountId = String(args.account_id || '');
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}/folders`, {
          method: 'GET',
        });
        return resp.data;
      }
      case 'email.messages.list': {
        const accountId = String(args.account_id || '');
        const folder = String(args.folder || 'INBOX');
        const query: Record<string, unknown> = {};
        if (args.q !== undefined && String(args.q).trim()) query.q = String(args.q).trim();
        if (args.unread !== undefined) query.unread = args.unread ? '1' : '0';
        const resp = await this.requestBackend(
          `/api/v1/email/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folder)}/messages`,
          {
            method: 'GET',
            query: Object.keys(query).length > 0 ? query : undefined,
          }
        );
        return resp.data;
      }
      case 'email.messages.read': {
        const accountId = String(args.account_id || '');
        const uid = String(args.uid || '');
        const folder = args.folder ? String(args.folder) : undefined;
        const path = folder
          ? `/api/v1/email/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folder)}/messages/${encodeURIComponent(uid)}`
          : `/api/v1/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(uid)}`;
        const resp = await this.requestBackend(path, { method: 'GET' });
        return resp.data;
      }
      case 'email.messages.search': {
        const accountId = String(args.account_id || '');
        const folder = String(args.folder || 'INBOX');
        const query: Record<string, unknown> = {
          q: String(args.query || ''),
        };
        if (args.unread !== undefined) query.unread = args.unread ? '1' : '0';
        const resp = await this.requestBackend(
          `/api/v1/email/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folder)}/messages`,
          {
            method: 'GET',
            query,
          }
        );
        return resp.data;
      }
      case 'email.messages.set_flags': {
        const accountId = String(args.account_id || '');
        const uid = String(args.uid || '');
        const folder = String(args.folder || 'INBOX');
        const body: Record<string, unknown> = { folder };
        if (args.seen !== undefined) body.seen = Boolean(args.seen);
        if (args.flagged !== undefined) body.flagged = Boolean(args.flagged);
        if (args.answered !== undefined) body.answered = Boolean(args.answered);
        const resp = await this.requestBackend(
          `/api/v1/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(uid)}/flags`,
          {
            method: 'PATCH',
            body,
          }
        );
        return resp.data;
      }
      case 'email.codes.extract': {
        if (args.account_id && args.uid) {
          const accountId = String(args.account_id);
          const uid = String(args.uid);
          const resp = await this.requestBackend(
            `/api/v1/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(uid)}/codes`,
            { method: 'GET' }
          );
          return resp.data;
        } else if (args.account_id) {
          const accountId = String(args.account_id);
          const resp = await this.requestBackend(
            `/api/v1/email/accounts/${encodeURIComponent(accountId)}/codes`,
            { method: 'GET' }
          );
          return resp.data;
        } else {
          const text = String(args.text || '');
          const resp = await this.requestBackend('/api/v1/email/extract-codes', {
            method: 'POST',
            body: { text },
          });
          return resp.data;
        }
      }
      case 'email.drafts.save': {
        const accountId = String(args.account_id || '');
        const body: Record<string, unknown> = {};
        if (args.id !== undefined) body.id = String(args.id);
        if (args.to !== undefined) body.to = args.to;
        if (args.cc !== undefined) body.cc = args.cc;
        if (args.bcc !== undefined) body.bcc = args.bcc;
        if (args.subject !== undefined) body.subject = String(args.subject);
        if (args.text !== undefined) body.body_text = String(args.text);
        if (args.body_text !== undefined) body.body_text = String(args.body_text);
        if (args.html !== undefined) body.body_html = String(args.html);
        if (args.body_html !== undefined) body.body_html = String(args.body_html);
        if (args.in_reply_to !== undefined) body.in_reply_to = String(args.in_reply_to);
        if (args.inReplyTo !== undefined) body.in_reply_to = String(args.inReplyTo);
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}/drafts`, {
          method: 'POST',
          body,
        });
        return resp.data;
      }
      case 'email.drafts.list': {
        const accountId = String(args.account_id || '');
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}/drafts`, {
          method: 'GET',
        });
        return resp.data;
      }
      case 'email.drafts.delete': {
        const accountId = String(args.account_id || '');
        const draftId = String(args.draft_id || '');
        const resp = await this.requestBackend(
          `/api/v1/email/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}`,
          {
            method: 'DELETE',
          }
        );
        return resp.data;
      }
      case 'email.outbox.list': {
        const accountId = String(args.account_id || '');
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}/outbox`, {
          method: 'GET',
        });
        return resp.data;
      }
      // Email tools (Gated tier)
      case 'email.messages.send': {
        const accountId = String(args.account_id || '');
        const body: Record<string, unknown> = {
          to: args.to,
          subject: String(args.subject || ''),
        };
        if (args.cc !== undefined) body.cc = args.cc;
        if (args.bcc !== undefined) body.bcc = args.bcc;
        if (args.text !== undefined) body.text = String(args.text);
        if (args.html !== undefined) body.html = String(args.html);
        if (args.in_reply_to !== undefined) body.inReplyTo = String(args.in_reply_to);
        if (args.inReplyTo !== undefined) body.inReplyTo = String(args.inReplyTo);
        if (args.references !== undefined) body.references = args.references;
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}/send`, {
          method: 'POST',
          body,
        });
        return resp.data;
      }
      case 'email.accounts.delete': {
        const accountId = String(args.account_id || '');
        const resp = await this.requestBackend(`/api/v1/email/accounts/${encodeURIComponent(accountId)}`, {
          method: 'DELETE',
        });
        return resp.data;
      }
      // Android emulator tools (Default tier — same scope as browser.* verbs)
      case 'android.start': {
        const profileId = String(args.profile_id || '');
        if (!profileId) throw new Error('android.start requires profile_id');
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/start`, {
          method: 'POST',
        });
        return resp.data;
      }
      case 'android.stop': {
        const profileId = String(args.profile_id || '');
        if (!profileId) throw new Error('android.stop requires profile_id');
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/stop`, {
          method: 'POST',
        });
        return resp.data;
      }
      case 'android.status': {
        const profileId = String(args.profile_id || '');
        if (!profileId) throw new Error('android.status requires profile_id');
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/status`, {
          method: 'GET',
        });
        return resp.data;
      }
      case 'android.tap': {
        const profileId = String(args.profile_id || '');
        const x = Number(args.x);
        const y = Number(args.y);
        if (!profileId || !Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error('android.tap requires profile_id and numeric x, y');
        }
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/tap`, {
          method: 'POST',
          body: { x, y },
        });
        return resp.data;
      }
      case 'android.swipe': {
        const profileId = String(args.profile_id || '');
        const x1 = Number(args.x1);
        const y1 = Number(args.y1);
        const x2 = Number(args.x2);
        const y2 = Number(args.y2);
        if (!profileId || !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
          throw new Error('android.swipe requires profile_id and numeric x1, y1, x2, y2');
        }
        const body: Record<string, unknown> = { x1, y1, x2, y2 };
        if (args.duration_ms !== undefined) body.durationMs = Number(args.duration_ms);
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/swipe`, {
          method: 'POST',
          body,
        });
        return resp.data;
      }
      case 'android.type': {
        const profileId = String(args.profile_id || '');
        const text = String(args.text || '');
        if (!profileId || !text) throw new Error('android.type requires profile_id and non-empty text');
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/type`, {
          method: 'POST',
          body: { text },
        });
        return resp.data;
      }
      case 'android.key': {
        const profileId = String(args.profile_id || '');
        const keycode = Number(args.keycode);
        if (!profileId || !Number.isFinite(keycode)) {
          throw new Error('android.key requires profile_id and numeric keycode');
        }
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/key`, {
          method: 'POST',
          body: { keycode },
        });
        return resp.data;
      }
      case 'android.screencap': {
        const profileId = String(args.profile_id || '');
        if (!profileId) throw new Error('android.screencap requires profile_id');
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/screencap`, {
          method: 'GET',
        });
        return resp.data;
      }
      case 'android.install_apk': {
        const profileId = String(args.profile_id || '');
        const apkPath = String(args.apk_path || '');
        if (!profileId || !apkPath) throw new Error('android.install_apk requires profile_id and apk_path');
        const resp = await this.requestBackend(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/install`, {
          method: 'POST',
          body: { apkPath },
        });
        return resp.data;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
