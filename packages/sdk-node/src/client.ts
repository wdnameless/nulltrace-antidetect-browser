import { ensureEngine } from './engine.js';
import type { EnsureEngineOptions } from './engine.js';
import { launchStandaloneProfile } from './standalone.js';
import type { StandaloneLaunchConfig, StandaloneProfileInstance } from './standalone.js';
import { ApiError } from './errors.js';
import type {
  ClientConfig,
  ApiResponse,
  BrowserStartData,
  ProfileItem,
  ProfileListFilter,
  ProfileListResult,
  CreateProfileParams,
  UpdateProfileParams,
  TemporaryProfileParams,
  ProxyItem,
  CreateProxyParams,
  UpdateProxyParams,
  ProxyCheckResult,
  DiagnosticReport,
  EmailAccountMasked,
  EmailAccountFilter,
  CreateEmailAccountParams,
  UpdateEmailAccountParams,
  EmailFolderItem,
  EmailInboxResult,
  EmailMessageDetail,
  EmailMessagesQuery,
  EmailSetFlagsParams,
  EmailSetFlagsResult,
  EmailSendParams,
  EmailSendResult,
  EmailOutboxItem,
  EmailDraftParams,
  EmailDraftItem,
  EmailExtractCodesResult,
  EmailMessageCodesResult,
  EmailAccountCodesResult,
  EmailDeleteResult,
  EmailPasswordResult,
} from './types.js';

export class AntidetectClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeout: number;

  constructor(config: ClientConfig = {}) {
    this.baseUrl = (config.baseUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.token = config.token;
    this.timeout = config.timeout ?? 30000;
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, unknown>;
    } = {}
  ): Promise<ApiResponse<T>> {
    const { method = 'GET', body, query } = options;

    let url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (query) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiError(`Network request failed: ${message}`, 0, -1, err);
    } finally {
      clearTimeout(timer);
    }

    let responseJson: unknown = null;
    try {
      responseJson = await response.json();
    } catch {
      // response body was not valid JSON
    }

    if (!response.ok) {
      let code = -1;
      let msg = `HTTP error ${response.status}: ${response.statusText}`;
      if (
        responseJson &&
        typeof responseJson === 'object' &&
        'msg' in responseJson &&
        typeof (responseJson as { msg: unknown }).msg === 'string'
      ) {
        msg = (responseJson as { msg: string }).msg;
      }
      if (
        responseJson &&
        typeof responseJson === 'object' &&
        'code' in responseJson &&
        typeof (responseJson as { code: unknown }).code === 'number'
      ) {
        code = (responseJson as { code: number }).code;
      }
      throw new ApiError(msg, response.status, code, responseJson);
    }

    const typedJson = responseJson as ApiResponse<T>;
    if (typedJson && typeof typedJson === 'object' && 'code' in typedJson && typedJson.code !== 0) {
      throw new ApiError(typedJson.msg || 'API returned failure code', response.status, typedJson.code, typedJson);
    }

    return typedJson;
  }

  public async getStatus(): Promise<ApiResponse<Record<string, unknown>>> {
    return this.request('/status');
  }

  public readonly profiles = {
    list: async (filter?: ProfileListFilter): Promise<ApiResponse<ProfileListResult>> => {
      return this.request<ProfileListResult>('/api/v1/browser/list', {
        method: 'GET',
        query: filter as Record<string, unknown>,
      });
    },

    get: async (userId: string): Promise<ApiResponse<ProfileItem>> => {
      return this.request<ProfileItem>('/api/v1/browser-profile/detail', {
        method: 'GET',
        query: { user_id: userId },
      });
    },

    create: async (params: CreateProfileParams): Promise<ApiResponse<ProfileItem>> => {
      return this.request<ProfileItem>('/api/v1/browser-profile/create', {
        method: 'POST',
        body: params,
      });
    },

    update: async (params: UpdateProfileParams): Promise<ApiResponse<ProfileItem>> => {
      return this.request<ProfileItem>('/api/v1/browser-profile/update', {
        method: 'POST',
        body: params,
      });
    },

    delete: async (userId: string): Promise<ApiResponse<Record<string, unknown>>> => {
      return this.request('/api/v1/browser-profile/delete', {
        method: 'POST',
        body: { user_id: userId },
      });
    },

    temporary: async (params?: TemporaryProfileParams): Promise<ApiResponse<ProfileItem>> => {
      return this.request<ProfileItem>('/api/v1/profiles/temporary', {
        method: 'POST',
        body: params || {},
      });
    },
  };

  public readonly browser = {
    start: async (
      userId: string,
      options: { headless?: boolean; proxy_id?: string; url?: string } = {}
    ): Promise<ApiResponse<BrowserStartData>> => {
      return this.request<BrowserStartData>('/api/v1/browser/start', {
        method: 'POST',
        body: { user_id: userId, ...options },
      });
    },

    stop: async (userId: string): Promise<ApiResponse<Record<string, unknown>>> => {
      return this.request('/api/v1/browser/stop', {
        method: 'POST',
        body: { user_id: userId },
      });
    },

    list: async (filter?: ProfileListFilter): Promise<ApiResponse<ProfileListResult>> => {
      return this.request<ProfileListResult>('/api/v1/browser/list', {
        method: 'GET',
        query: filter as Record<string, unknown>,
      });
    },
  };

  public readonly proxy = {
    list: async (): Promise<ApiResponse<{ list: ProxyItem[] }>> => {
      return this.request<{ list: ProxyItem[] }>('/api/v1/proxy/list', {
        method: 'GET',
      });
    },

    create: async (params: CreateProxyParams): Promise<ApiResponse<ProxyItem>> => {
      return this.request<ProxyItem>('/api/v1/proxy/create', {
        method: 'POST',
        body: params,
      });
    },

    update: async (params: UpdateProxyParams): Promise<ApiResponse<ProxyItem>> => {
      return this.request<ProxyItem>('/api/v1/proxy/update', {
        method: 'POST',
        body: params,
      });
    },

    delete: async (proxyId: string): Promise<ApiResponse<Record<string, unknown>>> => {
      return this.request('/api/v1/proxy/delete', {
        method: 'POST',
        body: { proxy_id: proxyId },
      });
    },

    check: async (proxyId: string): Promise<ApiResponse<ProxyCheckResult>> => {
      return this.request<ProxyCheckResult>('/api/v1/proxy/check', {
        method: 'POST',
        body: { proxy_id: proxyId },
      });
    },

    test: async (params: CreateProxyParams): Promise<ApiResponse<ProxyCheckResult>> => {
      return this.request<ProxyCheckResult>('/api/v1/proxy/test', {
        method: 'POST',
        body: params,
      });
    },
  };

  /** Human input (Motion domain): per-profile motor seeds, Fitts glide, paced typing. */
  public readonly motion = {
    createPointer: async (
      profileId: string,
      options: { seed?: number; profileSeed?: number; paceScale?: number; startX?: number; startY?: number } = {}
    ): Promise<ApiResponse<Record<string, unknown>>> =>
      this.request(`/api/v1/motion/${encodeURIComponent(profileId)}/createPointer`, {
        method: 'POST',
        body: options,
      }),
    glideTo: async (
      profileId: string,
      x: number,
      y: number,
      targetWidth = 32
    ): Promise<ApiResponse<Record<string, unknown>>> =>
      this.request(`/api/v1/motion/${encodeURIComponent(profileId)}/glideTo`, {
        method: 'POST',
        body: { x, y, targetWidth },
      }),
    tap: async (
      profileId: string,
      options: { clickCount?: number; button?: 'left' | 'right' | 'middle'; delayMs?: number } = {}
    ): Promise<ApiResponse<Record<string, unknown>>> =>
      this.request(`/api/v1/motion/${encodeURIComponent(profileId)}/tap`, {
        method: 'POST',
        body: options,
      }),
    enterText: async (
      profileId: string,
      text: string,
      allowTypos = false
    ): Promise<ApiResponse<Record<string, unknown>>> =>
      this.request(`/api/v1/motion/${encodeURIComponent(profileId)}/enterText`, {
        method: 'POST',
        body: { text, allowTypos },
      }),
    destroyPointer: async (profileId: string): Promise<ApiResponse<Record<string, unknown>>> =>
      this.request(`/api/v1/motion/${encodeURIComponent(profileId)}/destroyPointer`, {
        method: 'POST',
        body: {},
      }),
  };

  public readonly diagnostics = {
    run: async (profileId: string): Promise<ApiResponse<DiagnosticReport>> => {
      return this.request<DiagnosticReport>(`/api/v1/diagnostics/${encodeURIComponent(profileId)}`, {
        method: 'GET',
      });
    },
  };

  public readonly adspower = {
    userList: async (filter?: ProfileListFilter): Promise<ApiResponse<ProfileListResult>> => {
      return this.request<ProfileListResult>('/api/v1/user/list', {
        method: 'GET',
        query: filter as Record<string, unknown>,
      });
    },

    userCreate: async (params: Record<string, unknown>): Promise<ApiResponse<unknown>> => {
      return this.request('/api/v1/user/create', {
        method: 'POST',
        body: params,
      });
    },

    userUpdate: async (params: { user_id: string; [key: string]: unknown }): Promise<ApiResponse<unknown>> => {
      return this.request('/api/v1/user/update', {
        method: 'POST',
        body: params,
      });
    },

    userDelete: async (userIds: string[]): Promise<ApiResponse<unknown>> => {
      return this.request('/api/v1/user/delete', {
        method: 'POST',
        body: { user_ids: userIds },
      });
    },

    browserStart: async (
      userId: string,
      options: { headless?: boolean; [key: string]: unknown } = {}
    ): Promise<ApiResponse<BrowserStartData>> => {
      return this.request<BrowserStartData>('/api/v1/browser/start', {
        method: 'GET',
        query: { user_id: userId, ...options },
      });
    },

    browserStop: async (userId: string): Promise<ApiResponse<Record<string, unknown>>> => {
      return this.request('/api/v1/browser/stop', {
        method: 'GET',
        query: { user_id: userId },
      });
    },

    browserActive: async (): Promise<ApiResponse<unknown>> => {
      return this.request('/api/v1/browser/active', {
        method: 'GET',
      });
    },
  };

  /** Email domain: multi-account IMAP/SMTP profiles, folders, messages, drafts, outbox. */
  public readonly email = {
    listAccounts: async (filter?: EmailAccountFilter): Promise<ApiResponse<EmailAccountMasked[]>> => {
      const query: Record<string, unknown> = {};
      if (filter?.profile_id !== undefined) {
        query.profile_id = filter.profile_id ?? '';
      }
      return this.request<EmailAccountMasked[]>('/api/v1/email/accounts', {
        method: 'GET',
        query,
      });
    },

    getAccount: async (id: string): Promise<ApiResponse<EmailAccountMasked>> => {
      return this.request<EmailAccountMasked>(`/api/v1/email/accounts/${encodeURIComponent(id)}`, {
        method: 'GET',
      });
    },

    createAccount: async (params: CreateEmailAccountParams): Promise<ApiResponse<EmailAccountMasked>> => {
      return this.request<EmailAccountMasked>('/api/v1/email/accounts', {
        method: 'POST',
        body: params,
      });
    },

    updateAccount: async (
      id: string,
      params: UpdateEmailAccountParams
    ): Promise<ApiResponse<EmailAccountMasked>> => {
      return this.request<EmailAccountMasked>(`/api/v1/email/accounts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: params,
      });
    },

    deleteAccount: async (id: string): Promise<ApiResponse<EmailDeleteResult>> => {
      return this.request<EmailDeleteResult>(`/api/v1/email/accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    bindProfile: async (
      id: string,
      profileId?: string | null
    ): Promise<ApiResponse<EmailAccountMasked>> => {
      return this.request<EmailAccountMasked>(`/api/v1/email/accounts/${encodeURIComponent(id)}/bind-profile`, {
        method: 'POST',
        body: { profile_id: profileId ?? null },
      });
    },

    revealPassword: async (id: string): Promise<ApiResponse<EmailPasswordResult>> => {
      return this.request<EmailPasswordResult>(`/api/v1/email/accounts/${encodeURIComponent(id)}/reveal`, {
        method: 'POST',
      });
    },

    listFolders: async (id: string): Promise<ApiResponse<EmailFolderItem[]>> => {
      return this.request<EmailFolderItem[]>(`/api/v1/email/accounts/${encodeURIComponent(id)}/folders`, {
        method: 'GET',
      });
    },

    listMessages: async (
      id: string,
      folder = 'INBOX',
      query?: EmailMessagesQuery
    ): Promise<ApiResponse<EmailInboxResult>> => {
      const queryObj: Record<string, unknown> = {};
      if (query?.q) queryObj.q = query.q;
      if (query?.unread !== undefined) queryObj.unread = query.unread ? '1' : '0';
      return this.request<EmailInboxResult>(
        `/api/v1/email/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(folder)}/messages`,
        {
          method: 'GET',
          query: queryObj,
        }
      );
    },

    getMessage: async (
      id: string,
      folder: string,
      uid: string
    ): Promise<ApiResponse<EmailMessageDetail & { folder: string }>> => {
      return this.request<EmailMessageDetail & { folder: string }>(
        `/api/v1/email/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(folder)}/messages/${encodeURIComponent(uid)}`,
        {
          method: 'GET',
        }
      );
    },

    searchMessages: async (
      id: string,
      folder: string,
      query: string,
      options?: { unread?: boolean | string | number }
    ): Promise<ApiResponse<EmailInboxResult>> => {
      const queryObj: Record<string, unknown> = { q: query };
      if (options?.unread !== undefined) queryObj.unread = options.unread ? '1' : '0';
      return this.request<EmailInboxResult>(
        `/api/v1/email/accounts/${encodeURIComponent(id)}/folders/${encodeURIComponent(folder)}/messages`,
        {
          method: 'GET',
          query: queryObj,
        }
      );
    },

    setMessageFlags: async (
      id: string,
      uid: string,
      flags: EmailSetFlagsParams,
      options?: { folder?: string }
    ): Promise<ApiResponse<EmailSetFlagsResult>> => {
      const folder = options?.folder || flags.folder;
      const query = folder ? { folder } : undefined;
      return this.request<EmailSetFlagsResult>(
        `/api/v1/email/accounts/${encodeURIComponent(id)}/messages/${encodeURIComponent(uid)}/flags`,
        {
          method: 'PATCH',
          body: flags,
          query,
        }
      );
    },

    send: async (id: string, params: EmailSendParams): Promise<ApiResponse<EmailSendResult>> => {
      return this.request<EmailSendResult>(`/api/v1/email/accounts/${encodeURIComponent(id)}/send`, {
        method: 'POST',
        body: params,
      });
    },

    listOutbox: async (id: string): Promise<ApiResponse<EmailOutboxItem[]>> => {
      return this.request<EmailOutboxItem[]>(`/api/v1/email/accounts/${encodeURIComponent(id)}/outbox`, {
        method: 'GET',
      });
    },

    listDrafts: async (id: string): Promise<ApiResponse<EmailDraftItem[]>> => {
      return this.request<EmailDraftItem[]>(`/api/v1/email/accounts/${encodeURIComponent(id)}/drafts`, {
        method: 'GET',
      });
    },

    saveDraft: async (id: string, draft: EmailDraftParams): Promise<ApiResponse<EmailDraftItem>> => {
      return this.request<EmailDraftItem>(`/api/v1/email/accounts/${encodeURIComponent(id)}/drafts`, {
        method: 'POST',
        body: draft,
      });
    },

    deleteDraft: async (id: string, draftId: string): Promise<ApiResponse<EmailDeleteResult>> => {
      return this.request<EmailDeleteResult>(
        `/api/v1/email/accounts/${encodeURIComponent(id)}/drafts/${encodeURIComponent(draftId)}`,
        {
          method: 'DELETE',
        }
      );
    },

    listInbox: async (id: string): Promise<ApiResponse<EmailInboxResult>> => {
      return this.request<EmailInboxResult>(`/api/v1/email/accounts/${encodeURIComponent(id)}/inbox`, {
        method: 'GET',
      });
    },

    getInboxMessage: async (id: string, uid: string): Promise<ApiResponse<EmailMessageDetail>> => {
      return this.request<EmailMessageDetail>(
        `/api/v1/email/accounts/${encodeURIComponent(id)}/messages/${encodeURIComponent(uid)}`,
        {
          method: 'GET',
        }
      );
    },

    getMessageCodes: async (
      id: string,
      uid: string
    ): Promise<ApiResponse<EmailMessageCodesResult>> => {
      return this.request<EmailMessageCodesResult>(
        `/api/v1/email/accounts/${encodeURIComponent(id)}/messages/${encodeURIComponent(uid)}/codes`,
        {
          method: 'GET',
        }
      );
    },

    listCodes: async (id: string): Promise<ApiResponse<EmailAccountCodesResult>> => {
      return this.request<EmailAccountCodesResult>(`/api/v1/email/accounts/${encodeURIComponent(id)}/codes`, {
        method: 'GET',
      });
    },

    extractCodes: async (text = ''): Promise<ApiResponse<EmailExtractCodesResult>> => {
      return this.request<EmailExtractCodesResult>('/api/v1/email/extract-codes', {
        method: 'POST',
        body: { text },
      });
    },

    // Sub-namespaces for scoped access
    accounts: {
      list: (filter?: EmailAccountFilter) => this.email.listAccounts(filter),
      get: (id: string) => this.email.getAccount(id),
      create: (params: CreateEmailAccountParams) => this.email.createAccount(params),
      update: (id: string, params: UpdateEmailAccountParams) => this.email.updateAccount(id, params),
      delete: (id: string) => this.email.deleteAccount(id),
      bindProfile: (id: string, profileId?: string | null) => this.email.bindProfile(id, profileId),
      revealPassword: (id: string) => this.email.revealPassword(id),
    },
    folders: {
      list: (id: string) => this.email.listFolders(id),
    },
    messages: {
      list: (id: string, folder?: string, query?: EmailMessagesQuery) =>
        this.email.listMessages(id, folder, query),
      get: (id: string, folder: string, uid: string) => this.email.getMessage(id, folder, uid),
      search: (
        id: string,
        folder: string,
        query: string,
        options?: { unread?: boolean | string | number }
      ) => this.email.searchMessages(id, folder, query, options),
      setFlags: (
        id: string,
        uid: string,
        flags: EmailSetFlagsParams,
        options?: { folder?: string }
      ) => this.email.setMessageFlags(id, uid, flags, options),
      send: (id: string, params: EmailSendParams) => this.email.send(id, params),
    },
    outbox: {
      list: (id: string) => this.email.listOutbox(id),
    },
    drafts: {
      list: (id: string) => this.email.listDrafts(id),
      save: (id: string, draft: EmailDraftParams) => this.email.saveDraft(id, draft),
      delete: (id: string, draftId: string) => this.email.deleteDraft(id, draftId),
    },
    codes: {
      extract: (text?: string) => this.email.extractCodes(text),
      list: (id: string) => this.email.listCodes(id),
      getMessageCodes: (id: string, uid: string) => this.email.getMessageCodes(id, uid),
    },
  };

  /**
   * Standalone engine acquisition: download, verify SHA-256 digest, and cache patched Chromium.
   */
  public async ensureEngine(opts?: EnsureEngineOptions): Promise<{ executable: string; kernelDir: string }> {
    return ensureEngine(opts);
  }

  /**
   * Standalone profile launch: run Chromium directly without the desktop application or local API server.
   */
  public async launchStandaloneProfile(config?: StandaloneLaunchConfig): Promise<StandaloneProfileInstance> {
    return launchStandaloneProfile(config);
  }
}
