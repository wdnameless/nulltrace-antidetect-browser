import type { PreflightVerdict } from './preflight';
let apiKey = '';

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data: T;
}

export interface StartResult {
  ws: { puppeteer: string; selenium: string };
  debug_port: string;
  webdriver: string;
  pid: number;
}

export interface ProfileListItem {
  user_id: string;
  name: string | null;
  status: string;
  group_id: string | null;
  browser_type: string;
  proxy_type?: string | null;
  proxy_host?: string | null;
  proxy_port?: number | null;
  /** Bound proxy's id, so a row can be matched against a geo result arriving later. */
  proxy_id?: string | null;
  proxy_country?: string | null;
  /** ISO code for the flag and the two-letter label; `proxy_country` is the display name. */
  proxy_country_code?: string | null;
  proxy_city?: string | null;
  /** Proxy health from the last check: 'ok' | 'fail' | 'unknown'. */
  proxy_status?: string | null;
  fingerprint_seed?: number | null;
  platform?: string | null;
  device_name?: string | null;
  color?: string | null;
}

export interface ProfileDetails {
  user_id: string;
  name: string | null;
  status: string;
  group_id: string | null;
  device_id: string | null;
  browser_type: string;
  user_agent: string | null;
  timezone: string | null;
  /**
   * The pinned Android phone model, or null for "Auto (from seed)".
   *
   * The Edit modal loads this into its Phone Model select and sends it back on save, so leaving
   * it out of the type is what forced the read below into an `as any` — and the cast hid the real
   * defect underneath it: the server did not send the field at all, the select fell back to
   * "Auto", and saving any unrelated edit nulled a model the operator had pinned.
   */
  mobile_model_id?: string | null;
  /** Profile badge colour (canonical hex or null). Returned by the detail endpoint. */
  color?: string | null;
  notes?: string | null;
  launch_args?: string[];
  do_not_track?: 'off' | 'on' | 'auto' | null;
  blocked_ports?: number[] | null;
  webrtc_policy?: 'default' | 'disable_non_proxied_udp' | 'proxy' | null;
  /** Display mode from the detail endpoint: true = launches without a window. */
  headless?: boolean;
  proxy?: {
    id: string;
    type: 'http' | 'https' | 'socks5' | 'ssh';
    host: string;
    port: number;
    username: string | null;
    country: string | null;
    /** ISO 3166-1 alpha-2; `country` is the display name. */
    country_code: string | null;
    timezone: string | null;
    status: string;
  } | null;
  fingerprint?: {
    seed: number;
    platform: string;
    hardwareConcurrency?: number;
    brand?: string;
    config: Record<string, unknown>;
  } | null;
  device?: {
    id: string;
    name: string;
    platform: string;
    config: Record<string, unknown>;
  } | null;
}

export interface ProxyItem {
  proxy_id: string;
  type: string;
  host: string;
  port: number;
  username: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2; `country` is the display name. */
  country_code?: string | null;
  city?: string | null;
  timezone: string | null;
  latitude?: number | null;
  longitude?: number | null;
  status: string;
}

export interface GeoFillStatus {
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  current_proxy_id: string | null;
  started_at: number | null;
  pacing_ms: number;
}
export interface DeviceItem {
  device_id: string;
  name: string;
  platform: string;
  config: Record<string, unknown>;
}

export interface ExtensionItem {
  extension_id: string;
  name: string;
  path: string;
  version: string | null;
  enabled: boolean;
}

export interface GroupBookmark {
  title: string;
  url: string;
}

export interface GroupItem {
  id: string;
  name: string;
  created_at: number;
  profile_count: number;
  bookmarks?: string | null;
}

export interface ProxyTestResult {
  ok: boolean;
  ip?: string;
  country?: string;
  timezone?: string;
  latencyMs?: number;
  error?: string;
}

export interface CookieFarmConsent {
  domain: string;
  clicked: boolean;
  label?: string;
}

export interface CookieFarmReport {
  id: string;
  profileId: string;
  pagesVisited: number;
  cookiesSet: number;
  domainsTouched: string[];
  errors: string[];
  durationMs: number;
  status: 'completed' | 'aborted' | 'error';
  consents?: CookieFarmConsent[];
  managedProfile?: boolean;
  /**
   * Where the run's traffic exited, recorded when the report was created.
   *
   * Optional because a report written before this field existed will not carry it, and null when
   * the profile has no proxy or its country is unresolved — in either case there is nothing
   * truthful to show, so the header omits it rather than guessing.
   */
  exitGeo?: { code: string | null; country: string | null } | null;
}

export interface CookieFarmProgress {
  active: boolean;
  runId?: string;
  profileId?: string;
  status?: 'running' | 'completed' | 'aborted' | 'error';
  pagesVisited?: number;
  maxPages?: number;
  cookiesSet?: number;
  domainsTouched?: string[];
  currentDomain?: string | null;
  consentsAccepted?: number;
  startedAt?: number;
  elapsedMs?: number;
}

export function getApiKey(): string {
  return apiKey;
}

export function setApiKey(key: string): void {
  apiKey = key;
  if (key) {
    localStorage.setItem('apiKey', key);
  } else {
    localStorage.removeItem('apiKey');
  }
}
export function getApiOrigin(): string {
  return getApiBase();
}

export function checkHealth(): Promise<ApiEnvelope<{ status: string; version: string }>> {
  return api.status();
}

export function getMcpStatus(): Promise<ApiEnvelope<McpStatus>> {
  return api.mcpStatus();
}

export function buildMcpBundleIn(dir: string): Promise<ApiEnvelope<{
  ok: boolean;
  dir?: string;
  zip?: string;
  bytes?: number;
  toolCount?: number;
  scope?: string;
  config?: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
  error?: string;
}>> {
  return api.mcpBundle(dir);
}

export function startMcp(): Promise<ApiEnvelope<{ ok: boolean; message?: string; status?: McpStatus }>> {
  return api.mcpStart();
}

export function stopMcp(): Promise<ApiEnvelope<{ ok: boolean; message?: string; status?: McpStatus }>> {
  return api.mcpStop();
}


export async function initApiKey(): Promise<string> {
  if (window.antidetect?.getApiKey) {
    const start = Date.now();
    const timeoutMs = 30000;
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      try {
        const key = await window.antidetect.getApiKey();
        if (key) {
          apiKey = key;
          return key;
        }
      } catch {
        // Wait and retry if IPC is not yet registered or service is starting up
      }
      attempt++;
      const delay = Math.min(100 * Math.pow(1.5, attempt), 1000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('apiKey') : null;
  if (stored) {
    apiKey = stored;
    return stored;
  }
  /**
   * No desktop bridge and no stored key: this is the install-free web panel, which the
   * backend itself served. Ask it for the key (`GET /ui/key`, same-origin only). There is
   * deliberately no password prompt any more — a browser client has no other way to
   * authenticate, and without this fallback every request would 401 forever.
   */
  try {
    const res = await fetch(`${getApiBase()}/ui/key`);
    const body = (await res.json()) as { code: number; data?: { key?: string } };
    const key = body?.code === 0 ? body.data?.key : undefined;
    if (key) {
      apiKey = key;
      try {
        localStorage.setItem('apiKey', key);
      } catch {
        // private mode: the key still works for this page's lifetime
      }
      return key;
    }
  } catch {
    // Backend unreachable or the page is not same-origin: fall through to an empty key so
    // requests fail with the backend's own 401 rather than a crash here.
  }
  return '';
}

export function resolveApiBase(
  location?: { protocol: string; host: string; origin: string },
  override?: string | null
): string {
  if (override && override.startsWith('http')) {
    return override.replace(/\/$/, '');
  }
  if (location && (location.protocol === 'http:' || location.protocol === 'https:')) {
    return location.origin;
  }
  return 'http://127.0.0.1:50325';
}

export function getApiBase(): string {
  // Dev/test override: localStorage.apiBase (e.g. a second service instance on another port).
  const override = typeof localStorage !== 'undefined' ? localStorage.getItem('apiBase') : null;
  const loc = typeof window !== 'undefined' && window.location ? window.location : undefined;
  return resolveApiBase(loc, override);
}
async function request<T>(path: string, options: RequestInit = {}, retries = 3): Promise<ApiEnvelope<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      ...options,
      headers,
    });
  } catch (fetchErr) {
    // If service is still spinning up, retry with exponential backoff up to retries
    if (retries > 0) {
      const delayMs = Math.min(250 * Math.pow(2, 3 - retries), 2000);
      await new Promise((r) => setTimeout(r, delayMs));
      return request<T>(path, options, retries - 1);
    }
    throw fetchErr;
  }

  if (res.status === 429 && retries > 0) {
    let delayMs = 250;
    try {
      const data = (await res.clone().json()) as { data?: { retry_after_ms?: number } };
      if (typeof data?.data?.retry_after_ms === 'number') {
        delayMs = Math.max(data.data.retry_after_ms + 50, 100);
      }
    } catch {
      // fallback delay
    }
    await new Promise((r) => setTimeout(r, delayMs));
    return request<T>(path, options, retries - 1);
  }

  return (await res.json()) as ApiEnvelope<T>;
}

export interface CloudStateData {
  configured: boolean;
  url?: string;
  hasToken?: boolean;
  connected?: boolean;
  version?: string;
  authorized?: boolean;
  error?: string;
}

export interface GDriveStatusData {
  configured: boolean;
  connected: boolean;
  userEmail: string | null;
  folderId: string | null;
  lastPushTimestamp: number | null;
  lastPullTimestamp: number | null;
  account?: string | null;
  unlocked?: boolean;
  syncing?: boolean;
  lastSyncAt?: number | null;
  lastError?: string | null;
  pendingRemoteChanges?: number;
  mirrorEnabled?: boolean;
}

export interface SyncResultRow {
  user_id: string;
  name: string;
  ok: boolean;
  new_id?: string;
  error?: string;
}

export interface TeamPermissions {
  can_run_profiles: boolean;
  can_add_profiles: boolean;
  can_remove_profiles: boolean;
  can_invite: boolean;
}

export interface TeamItem {
  id: string;
  name: string;
  owner_device_id: string;
  created_at: number;
  local_role: 'owner' | 'member' | null;
  local_status: 'pending' | 'active' | null;
  member_count: number;
}

export interface TeamMemberItem {
  team_id: string;
  member_id: string;
  email: string | null;
  role: 'owner' | 'member';
  permissions: TeamPermissions | null;
  status: 'pending' | 'active';
  joined_at: number | null;
  created_at: number;
}

export interface LicenseStateData {
  plan: 'free' | 'pro';
  email?: string;
  exp?: number;
  expired: boolean;
}

// ---- Sprint 2: vault / diagnostics / tags / trash ----

export interface VaultEntry {
  id: string;
  profile_id: string;
  label: string | null;
  login: string | null;
  has_password: boolean;
  has_totp: boolean;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface DiagnosticsReport {
  profile_id: string;
  ip: string | null;
  geo: { country?: string; city?: string; timezone?: string; lat?: number; lon?: number } | null;
  timezone: string | null;
  ip_timezone: string | null;
  timezone_match: 'ok' | 'warn' | null;
  webrtc: 'ok' | 'warn' | null;
  webrtc_addresses: string[];
  consistency: 'ok' | 'warn' | null;
  consistency_detail: string | null;
  dns_leak: null;
  collected_at: number;
}

export interface TagItem {
  id: string;
  name: string;
  color: string | null;
  created_at: number;
  profile_count: number;
}

export interface ProfileTagBinding {
  tag_id: string;
  name: string;
  color: string | null;
}

export interface TrashItem {
  id: string;
  name: string | null;
  group_name: string | null;
  deleted_at: number;
  created_at: number;
}

// ---- Sprint 3: action syncer ----

export interface SyncSessionInfo {
  id: string;
  master_profile_id: string;
  created_at: number;
  status: string;
  members: string[];
}

export interface TileResult {
  tiled: string[];
  failed: Array<{ profile_id: string; error: string }>;
}

// ---- Sprint 4: script engine / keys / triggers / catalog ----

export interface ScriptItem {
  id: string;
  name: string;
  code: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_status: string | null;
}

export interface ScriptRunItem {
  id: string;
  script_id: string;
  profile_ids: string[];
  status: 'running' | 'done' | 'error' | 'timeout';
  log: string;
  started_at: number;
  finished_at: number | null;
}

export interface KeyItem {
  key: string;
  has_value: boolean;
  updated_at: number;
}

export interface TriggerItem {
  id: string;
  name: string;
  script_id: string;
  type: 'schedule' | 'event';
  schedule: string | null;
  event: 'profile_started' | 'profile_stopped' | null;
  enabled: number;
  last_fired_at: number | null;
  created_at: number;
}

export interface TaskGroupItem {
  id: string;
  name: string;
  workflow_id: string;
  workflow_name?: string;
  active_session_cap: number;
  randomize_profile_order: boolean | number;
  time_window_cron?: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

// ---- Email (read-only IMAP + code extraction) ----
export interface EmailAccount {
  id: string;
  label: string | null;
  email: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  created_at: number;
  updated_at: number;
}

export interface EmailMessageSummary {
  uid: string;
  subject: string;
  from: string;
  date: string;
}

export interface EmailMessageDetail extends EmailMessageSummary {
  id: string;
  accountId: string;
  body: string;
  cached?: boolean;
  /** Why the live fetch failed, when the body came from the cache instead. */
  error?: string;
}
export interface McpStatus {
  running: boolean;
  transport: 'http' | 'stdio';
  httpPort?: number | null;
  httpUrl?: string | null;
  toolCount: number;
  tier1Count: number;
  tier2Count: number;
  startedAt: string | null;
  /**
   * Whether a bundle has been produced before and its folder is still there.
   *
   * The operator's ask was that MCP read as a state, not a control: «если скачано и установлено,
   * то просто MCP будет показывать, что оно включено, и там столько-то тулзов». A folder the
   * operator deleted (or carried off on a USB stick) must stop counting as installed, so the
   * backend re-checks the path per request rather than caching this.
   */
  installed: boolean;
  bundleDir: string | null;
}

// ---- Android Emulator Integration (interfaces.md §2, §6, §7) ----
export interface AndroidPlatformInfo {
  host: 'windows' | 'macos' | 'linux';
  abi: 'x86_64' | 'arm64-v8a';
  backends: ('whpx' | 'aehd' | 'hvf' | 'kvm')[];
  emulatorSubpath: string;
}

export interface AndroidEngineStatus {
  installed: boolean;
  engineDir: string;
  emulatorPath: string | null;
  installedApiLevels: number[];
  unpinnedAssets: string[];
  platform: AndroidPlatformInfo | null;
  error?: { code: string; message: string };
}

export interface AndroidInstanceStatus {
  profileId: string;
  state: 'starting' | 'booting' | 'running' | 'stopped' | 'error';
  serial: string;
  consolePort: number;
  adbPort: number;
  screen: { width: number; height: number };
  stream: 'idle' | 'starting' | 'streaming' | 'error';
  startedAt: number;
  error?: { code: string; message: string };
  inject?: { applied: string[]; skipped: string[]; errors: string[] };
}

export interface AndroidStreamTicket {
  ticket: string;
  wsUrl: string;
  width: number;
  height: number;
  expiresAt: number;
}


export const api = {
  status: () => request<{ status: string; version: string }>('/status'),
  list: (opts?: { groupId?: string | null; page?: number; pageSize?: number; search?: string | null; platform?: string | null; status?: string | null; tagId?: string | null }) => {
    const q = new URLSearchParams();
    if (opts?.groupId) q.set('group_id', opts.groupId);
    if (opts?.page) q.set('page', String(opts.page));
    if (opts?.pageSize) q.set('page_size', String(opts.pageSize));
    if (opts?.search) q.set('search', opts.search);
    if (opts?.platform) q.set('platform', opts.platform);
    if (opts?.status) q.set('status', opts.status);
    if (opts?.tagId) q.set('tag_id', opts.tagId);
    const qs = q.toString();
    return request<{ list: ProfileListItem[]; total: number; page: number; page_size: number }>(
      `/api/v1/browser/list${qs ? `?${qs}` : ''}`
    );
  },
  profileDetail: (user_id: string) =>
    request<ProfileDetails>(`/api/v1/browser-profile/detail?user_id=${encodeURIComponent(user_id)}`),
  create: (body: {
    name?: string;
    group_id?: string;
    proxy_id?: string;
    proxy?: {
      type: 'http' | 'https' | 'socks5' | 'ssh';
      host: string;
      port: number;
      username?: string;
      password?: string;
    };
    device_id?: string;
    fingerprint_seed?: number;
    mobile_model_id?: string;
    user_agent?: string;
    timezone?: string;
    browser_type?: string;
    color?: string | null;
    notes?: string;
    do_not_track?: 'off' | 'on' | 'auto' | null;
    blocked_ports?: number[];
    webrtc_policy?: 'default' | 'disable_non_proxied_udp' | 'proxy' | null;
    /** Launch without a window. Owned by the launcher, not by launch_args. */
    headless?: boolean;
  }) =>
    request<{ user_id: string }>('/api/v1/browser-profile/create', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  start: (id: string, options?: { headless?: boolean; bypass_proxy_probe?: boolean }) => {
    const q = new URLSearchParams({ user_id: id });
    if (options?.headless !== undefined) q.set('headless', String(options.headless));
    if (options?.bypass_proxy_probe) q.set('bypass_proxy_probe', '1');
    return request<StartResult>(`/api/v1/browser/start?${q.toString()}`);
  },
  stop: (id: string) =>
    request<Record<string, never>>(`/api/v1/browser/stop?user_id=${encodeURIComponent(id)}`),
  profileUpdate: (body: {
    color?: string | null;
    notes?: string | null;
    user_id: string;
    name?: string;
    group_id?: string | null;
    proxy_id?: string | null;
    proxy?: {
      type: 'http' | 'https' | 'socks5' | 'ssh';
      host: string;
      port: number;
      username?: string;
      password?: string;
    } | null;
    device_id?: string | null;
    mobile_model_id?: string | null;
    user_agent?: string | null;
    timezone?: string | null;
    browser_type?: string;
    do_not_track?: 'off' | 'on' | 'auto' | null;
    blocked_ports?: number[] | null;
    webrtc_policy?: 'default' | 'disable_non_proxied_udp' | 'proxy' | null;
    /** Launch without a window. Owned by the launcher, not by launch_args. */
    headless?: boolean;
  }) =>
    request<Record<string, never>>('/api/v1/browser-profile/update', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  profileDelete: (user_id: string) =>
    request<Record<string, never>>('/api/v1/browser-profile/delete', {
      method: 'POST',
      body: JSON.stringify({ user_id }),
    }),
  profileDuplicate: (user_id: string, name?: string) =>
    request<{ user_id: string }>('/api/v1/browser-profile/duplicate', {
      method: 'POST',
      body: JSON.stringify({ user_id, name }),
    }),
  profileExport: (user_id: string) =>
    request<{ bundle: Record<string, unknown> }>(
      `/api/v1/browser-profile/export?user_id=${encodeURIComponent(user_id)}`
    ),
  profileImportBundle: (bundle: Record<string, unknown>) =>
    request<{ user_id: string }>('/api/v1/browser-profile/import-bundle', {
      method: 'POST',
      body: JSON.stringify({ bundle }),
    }),
  logsList: () =>
    request<{ dir: string; list: Array<{ name: string; size: number; modified: number }> }>(
      '/api/v1/logs/list'
    ),
  logsGet: (name: string, tail = 500) =>
    request<{ name: string; content: string }>(
      `/api/v1/logs/get?name=${encodeURIComponent(name)}&tail=${tail}`
    ),
  kernelInfo: () => request<{ installed: string | null }>('/api/v1/kernel/info'),
  /** Install progress for the one-time kernel download (~425 MB, SHA-256 verified). */
  kernelStatus: () =>
    request<{
      status: 'idle' | 'downloading' | 'verifying' | 'done' | 'error';
      received: number;
      total: number;
      error?: string;
      installed: string | null;
      pinned: string;
      installing: boolean;
    }>('/api/v1/kernel/status'),
  /** Download and verify the kernel. Idempotent; joins an in-flight download. */
  kernelInstall: () =>
    request<{ ok: boolean; installed: string | null; alreadyInstalled?: boolean }>('/api/v1/kernel/install', {
      method: 'POST',
    }),
  kernelCheckUpdate: () =>
    request<{ installed: string | null; latest: string | null; updateAvailable: boolean; releaseUrl?: string; error?: string }>(
      '/api/v1/kernel/check-update'
    ),
  bulkStart: (user_ids: string[]) =>
    request<{ succeeded: Array<{ user_id: string }>; failed: Array<{ user_id: string; error: string }>; total: number }>(
      '/api/v1/browser-profile/bulk-start',
      { method: 'POST', body: JSON.stringify({ user_ids }) }
    ),
  bulkStop: (user_ids: string[]) =>
    request<{ succeeded: string[]; failed: Array<{ user_id: string; error: string }>; total: number }>(
      '/api/v1/browser-profile/bulk-stop',
      { method: 'POST', body: JSON.stringify({ user_ids }) }
    ),
  bulkDelete: (user_ids: string[]) =>
    request<{ succeeded: string[]; failed: Array<{ user_id: string; error: string }>; total: number }>(
      '/api/v1/browser-profile/bulk-delete',
      { method: 'POST', body: JSON.stringify({ user_ids }) }
    ),
  bulkGroup: (user_ids: string[], group_id: string | null) =>
    request<{ succeeded: string[]; failed: Array<{ user_id: string; error: string }>; total: number }>(
      '/api/v1/browser-profile/bulk-group',
      { method: 'POST', body: JSON.stringify({ user_ids, group_id }) }
    ),
  randomizeFingerprint: (user_id: string) =>
    request<{ seed: number }>('/api/v1/browser-profile/randomize-fingerprint', {
      method: 'POST',
      body: JSON.stringify({ user_id }),
    }),
  groupList: () => request<{ list: GroupItem[] }>('/api/v1/group/list'),
  groupCreate: (name: string) =>
    request<{ group_id: string }>('/api/v1/group/create', { method: 'POST', body: JSON.stringify({ name }) }),
  groupUpdate: (group_id: string, name?: string, bookmarks?: GroupBookmark[]) =>
    request<Record<string, never>>('/api/v1/group/update', {
      method: 'POST',
      body: JSON.stringify({ group_id, ...(name !== undefined ? { name } : {}), ...(bookmarks !== undefined ? { bookmarks } : {}) }),
    }),
  groupDelete: (group_id: string) =>
    request<Record<string, never>>('/api/v1/group/delete', { method: 'POST', body: JSON.stringify({ group_id }) }),
  proxyList: () => request<{ list: ProxyItem[]; total: number }>('/api/v1/proxy/list'),
  proxyCreate: (body: Record<string, unknown>) =>
    request<{ proxy_id: string }>('/api/v1/proxy/create', { method: 'POST', body: JSON.stringify(body) }),
  proxyImportList: (text: string, defaultProtocol: 'http' | 'https' | 'socks5') =>
    request<{ created: number; duplicates: number; invalid: number; proxy_ids: string[] }>(
      '/api/v1/proxy/import-list',
      { method: 'POST', body: JSON.stringify({ text, defaultProtocol }) }
    ),
  backupsList: () =>
    request<{ list: Array<{ name: string; size: number; modified: number }> }>('/api/v1/backups/list'),
  backupRestore: (name: string) =>
    request<{ restart_required: boolean }>('/api/v1/backups/restore', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  dataScan: () =>
    request<{ current: string; found: Array<{ dir: string; isCurrent: boolean; dbSize: number; modified: number; profiles: number }> }>(
      '/api/v1/data/scan'
    ),
  dataTransfer: (from: string) =>
    request<{ ok: boolean; from: string; created: number; skipped: number; dependencies: number; workspaces: number; workspace_failures: Array<{ id: string; error: string }>; error?: string }>(
      '/api/v1/data/transfer',
      { method: 'POST', body: JSON.stringify({ from }) }
    ),
  /**
   * Remove an old data folder after its profiles are in the folder in use.
   *
   * The server refuses unless every profile in that folder already exists here, so the
   * `reason` it answers with is what the message should say — the UI does not need to
   * re-derive the rule, only to report it.
   */
  dataDelete: (dir: string) =>
    request<{ ok: boolean; dir: string; reason: string; recycled?: boolean; missing?: number }>(
      '/api/v1/data/delete',
      { method: 'POST', body: JSON.stringify({ dir }) }
    ),
  // First-run data location. The backend owns both the "is a choice due?" rule and the
  // writability check, so the UI never has to second-guess where data will land.
  firstRunData: () =>
    request<{ needed: boolean; defaultDir: string; currentDir: string; portable: boolean }>(
      '/api/v1/data/first-run'
    ),
  setFirstRunData: (dir: string) =>
    request<{ ok: boolean; dir: string; restartRequired: boolean; error?: string }>('/api/v1/data/first-run', {
      method: 'POST',
      body: JSON.stringify({ dir }),
    }),
  checkFirstRunData: (dir: string) =>
    request<{ ok: boolean; dir?: string; error?: string }>('/api/v1/data/first-run/check', {
      method: 'POST',
      body: JSON.stringify({ dir }),
    }),
  proxyTest: (body: { type: string; host: string; port: number; username?: string; password?: string }) =>
    request<ProxyTestResult>('/api/v1/proxy/test', { method: 'POST', body: JSON.stringify(body) }),
  proxyCheck: (proxy_id: string) =>
    request<{ ok: boolean; ip?: string; country?: string; city?: string; timezone?: string; latencyMs?: number; error?: string }>(
      '/api/v1/proxy/check',
      { method: 'POST', body: JSON.stringify({ proxy_id }) }
    ),
  proxyDelete: (proxy_id: string) =>
    request<Record<string, never>>('/api/v1/proxy/delete', {
      method: 'POST',
      body: JSON.stringify({ proxy_id }),
    }),
  proxyGeoFillStart: (options?: { force?: boolean }) =>
    request<GeoFillStatus>('/api/v1/proxy/geo-fill/start', {
      method: 'POST',
      body: JSON.stringify(options ?? {}),
    }),
  proxyGeoFillStatus: () =>
    request<GeoFillStatus>('/api/v1/proxy/geo-fill/status'),
  proxyGeoFillStop: () =>
    request<GeoFillStatus>('/api/v1/proxy/geo-fill/stop', {
      method: 'POST',
    }),
  deviceList: () => request<{ list: DeviceItem[]; total: number }>('/api/v1/device/list'),
  mobilePresets: () =>
    request<{ list: Array<{ id: string; name: string; model: string; androidVersion: string; gpu: string }> }>(
      '/api/v1/device/mobile-presets'
    ),
  /**
   * Every browser language the fingerprint catalog can assign.
   *
   * Read from the backend rather than hard-coded in the modal: the catalog is the single source of
   * truth, and a hand-written list had already fallen 14 locales behind it — which made a real
   * profile's stored language unrepresentable in the select.
   */
  browserLanguages: () => request<{ list: string[] }>('/api/v1/browser-profile/languages'),
  extensionList: () => request<{ list: ExtensionItem[]; total: number }>('/api/v1/extension/list'),
  extensionImport: (name: string, path: string) =>
    request<{ extension_id: string }>('/api/v1/extension/import', {
      method: 'POST',
      body: JSON.stringify({ name, path }),
    }),
  extensionDelete: (extension_id: string) =>
    request<Record<string, never>>('/api/v1/extension/delete', {
      method: 'POST',
      body: JSON.stringify({ extension_id }),
    }),
  extensionInstall: (target: { url?: string; id?: string; path?: string }) =>
    request<{ extension_id: string; name: string; version: string; reused: boolean }>('/api/v1/extension/install', {
      method: 'POST',
      body: JSON.stringify(target),
    }),
  profileBindExtensions: (user_id: string, extension_ids: string[]) =>
    request<{ count: number }>('/api/v1/browser-profile/extensions/bind', {
      method: 'POST',
      body: JSON.stringify({ user_id, extension_ids }),
    }),
  profileExtensionsBind: (user_id: string, extension_ids: string[]) =>
    request<{ count: number }>('/api/v1/browser-profile/extensions/bind', {
      method: 'POST',
      body: JSON.stringify({ user_id, extension_ids }),
    }),
  profileExtensions: (user_id: string) =>
    request<{ extension_ids: string[] }>(
      `/api/v1/browser-profile/extensions?user_id=${encodeURIComponent(user_id)}`
    ),
  cookiesImport: (user_id: string, cookies: Array<Record<string, unknown>>) =>
    request<{ count: number }>('/api/v1/browser-profile/cookies/import', {
      method: 'POST',
      body: JSON.stringify({ user_id, cookies }),
    }),
  cookiesExport: (user_id: string) =>
    request<{ cookies: Array<Record<string, unknown>>; source: string }>(
      `/api/v1/browser-profile/cookies/export?user_id=${encodeURIComponent(user_id)}`
    ),
  profileUpdateFingerprint: (user_id: string, config: Record<string, unknown>) =>
    request<Record<string, never>>('/api/v1/browser-profile/fingerprint', {
      method: 'POST',
      body: JSON.stringify({ user_id, config }),
    }),
  batchCreate: (body: { count: number; name_prefix?: string; proxy_ids?: string[]; device_id?: string }) =>
    request<{ user_ids: string[]; count: number }>('/api/v1/browser-profile/batch-create', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  batchDelete: (user_ids: string[]) =>
    request<{ deleted: number }>('/api/v1/browser-profile/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ user_ids }),
    }),
  batchBindProxy: (user_ids: string[], proxy_ids: string[]) =>
    request<{ updated: number }>('/api/v1/browser-profile/batch-bind-proxy', {
      method: 'POST',
      body: JSON.stringify({ user_ids, proxy_ids }),
    }),
  importCsv: (csv: string) =>
    request<{ user_ids: string[]; count: number }>('/api/v1/browser-profile/import', {
      method: 'POST',
      body: JSON.stringify({ csv }),
    }),
  // ---- Cloud Sync (bridge endpoints on the LOCAL service) ----
  cloudState: () => request<CloudStateData>('/api/v1/cloud/state'),
  cloudConnect: (url: string, key?: string) =>
    request<CloudStateData>('/api/v1/cloud/connect', {
      method: 'POST',
      body: JSON.stringify(key ? { url, key } : { url }),
    }),
  cloudDisconnect: () => request<Record<string, never>>('/api/v1/cloud/disconnect', { method: 'POST' }),
  cloudRemoteList: () => request<{ list: ProfileListItem[]; total: number }>('/api/v1/cloud/remote-list'),
  cloudPush: (user_ids?: string[]) =>
    request<{ pushed: number; failed: number; results: SyncResultRow[] }>('/api/v1/cloud/push', {
      method: 'POST',
      body: JSON.stringify({ user_ids: user_ids ?? null }),
    }),
  cloudPull: (user_ids?: string[]) =>
    request<{ pulled: number; failed: number; results: SyncResultRow[] }>('/api/v1/cloud/pull', {
      method: 'POST',
      body: JSON.stringify({ user_ids: user_ids ?? null }),
    }),
  // ---- Google Drive Sync (nulltrace-gdrive) ----
  gdriveStatus: () => request<GDriveStatusData>('/api/v1/cloud/gdrive/status'),
  cloudGdriveStatus: () => request<GDriveStatusData>('/api/v1/cloud/gdrive/status'),
  cloudGdriveConnect: (passphrase: string) =>
    request<{
      email?: string;
      userCode?: string;
      verificationUrl?: string;
      deviceCode?: string;
      interval?: number;
      status?: string;
    }>('/api/v1/cloud/gdrive/connect', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  cloudGdriveUnlock: (passphrase: string) =>
    request<{ ok: boolean }>('/api/v1/cloud/gdrive/unlock', {
      method: 'POST',
      body: JSON.stringify({ passphrase }),
    }),
  cloudGdriveSyncNow: () =>
    request<GDriveStatusData>('/api/v1/cloud/gdrive/sync-now', {
      method: 'POST',
    }),
  cloudGdriveMirrorEnable: (enabled: boolean) =>
    request<{ enabled: boolean }>('/api/v1/cloud/gdrive/mirror/enable', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  cloudGdriveMirrorRun: () =>
    request<{ bytes: number }>('/api/v1/cloud/gdrive/mirror/run', {
      method: 'POST',
    }),
  gdriveSaveCredentials: (clientId: string, clientSecret?: string) =>
    request<Record<string, unknown>>('/api/v1/cloud/gdrive/credentials', {
      method: 'POST',
      body: JSON.stringify({ clientId, clientSecret }),
    }),
  gdriveStartDeviceAuth: () =>
    request<{
      userCode: string;
      verificationUrl: string;
      deviceCode: string;
      expiresIn: number;
      interval: number;
    }>('/api/v1/cloud/gdrive/auth/device-code', { method: 'POST' }),
  gdrivePollDeviceAuth: (deviceCode: string) =>
    request<{
      status: string;
      email?: string;
    }>('/api/v1/cloud/gdrive/auth/poll', {
      method: 'POST',
      body: JSON.stringify({ deviceCode }),
    }),
  gdriveDisconnect: () =>
    request<Record<string, unknown>>('/api/v1/cloud/gdrive/disconnect', { method: 'POST' }),
  gdrivePush: () =>
    request<{ pushedProfiles: number; pushedScripts: number; timestamp: number }>(
      '/api/v1/cloud/gdrive/push',
      { method: 'POST' }
    ),
  gdriveInspectPull: () =>
    request<{
      remoteTimestamp: number;
      profileCount: number;
      scriptCount: number;
      newProfiles: number;
      newScripts: number;
      conflicts: Array<{
        type: 'profile' | 'script';
        id: string;
        name: string;
        localUpdatedAt: number;
        remoteUpdatedAt: number;
      }>;
      unchanged: boolean;
    }>('/api/v1/cloud/gdrive/inspect-pull'),
  gdrivePull: (conflictResolution?: 'keep_local' | 'overwrite_remote' | 'cancel') =>
    request<{
      pulledProfiles: number;
      pulledScripts: number;
      appliedSettings: boolean;
      timestamp: number;
    }>('/api/v1/cloud/gdrive/pull', {
      method: 'POST',
      body: JSON.stringify({ conflictResolution }),
    }),
  // ---- Teams / RBAC (Pro) ----
  teamsList: () =>
    request<{ list: TeamItem[]; active_workspace: string }>('/api/v1/teams'),
  teamCreate: (name: string) =>
    request<{ team_id: string; name: string; role: string }>('/api/v1/teams', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  teamUpdate: (teamId: string, name: string) =>
    request<{ team_id: string; name: string }>(`/api/v1/teams/${encodeURIComponent(teamId)}/update`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  teamDelete: (teamId: string) =>
    request<{ team_id: string; deleted: boolean }>(`/api/v1/teams/${encodeURIComponent(teamId)}/delete`, {
      method: 'POST',
    }),
  teamMembers: (teamId: string) =>
    request<{ list: TeamMemberItem[] }>(`/api/v1/teams/${encodeURIComponent(teamId)}/members`),
  teamInvite: (teamId: string, email: string, permissions: TeamPermissions) =>
    request<{ member_id: string; activation_code?: string }>(`/api/v1/teams/${encodeURIComponent(teamId)}/invites`, {
      method: 'POST',
      body: JSON.stringify({ email, permissions }),
    }),
  inviteAccept: (teamId: string, email: string, activation_code: string) =>
    request<{ team_id: string; status: string }>('/api/v1/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId, email, activation_code }),
    }),
  teamInviteCancel: (teamId: string, member_id: string) =>
    request<{ cancelled: boolean }>(`/api/v1/teams/${encodeURIComponent(teamId)}/invites/cancel`, {
      method: 'POST',
      body: JSON.stringify({ member_id }),
    }),
  teamMemberRemove: (teamId: string, member_id: string) =>
    request<{ removed: boolean }>(`/api/v1/teams/${encodeURIComponent(teamId)}/members/remove`, {
      method: 'POST',
      body: JSON.stringify({ member_id }),
    }),
  teamMemberPermissions: (teamId: string, member_id: string, permissions: Partial<TeamPermissions>) =>
    request<{ permissions: TeamPermissions }>(`/api/v1/teams/${encodeURIComponent(teamId)}/members/permissions`, {
      method: 'POST',
      body: JSON.stringify({ member_id, permissions }),
    }),
  teamProfiles: (teamId: string) =>
    request<{ list: string[] }>(`/api/v1/teams/${encodeURIComponent(teamId)}/profiles`),
  workspaceSetActive: (workspace: string) =>
    request<{ workspace: string }>('/api/v1/workspace/active', {
      method: 'POST',
      body: JSON.stringify({ workspace }),
    }),
  // ---- Sync (Pro) ----
  syncEndpoint: () =>
    request<{ mode: 'cloud' | 'custom'; url: string; default_url: string; customUrl?: string }>('/api/v1/sync/endpoint'),
  syncEndpointSet: (mode: 'cloud' | 'custom', url?: string) =>
    request<{ mode: string; url: string }>('/api/v1/sync/endpoint', {
      method: 'POST',
      body: JSON.stringify({ mode, url }),
    }),
  syncStatus: () =>
    request<{ connected: boolean; url: string; error?: string; version?: string; token: boolean }>('/api/v1/sync/status'),
  teamPush: (teamId: string, user_ids?: string[]) =>
    request<{ pushed: number; failed: number; results: Array<{ bundle_id: string; ok: boolean; error?: string }> }>(
      `/api/v1/teams/${encodeURIComponent(teamId)}/push`,
      { method: 'POST', body: JSON.stringify({ user_ids: user_ids ?? null }) }
    ),
  teamPull: (teamId: string, user_ids?: string[]) =>
    request<{ pulled: number; failed: number; errors: string[] }>(
      `/api/v1/teams/${encodeURIComponent(teamId)}/pull`,
      { method: 'POST', body: JSON.stringify({ user_ids: user_ids ?? null }) }
    ),
  // ---- License ----
  licenseState: () => request<LicenseStateData>('/api/v1/license/state'),
  licenseActivate: (key: string) =>
    request<LicenseStateData>('/api/v1/license/activate', { method: 'POST', body: JSON.stringify({ key }) }),
  licenseDeactivate: () => request<LicenseStateData>('/api/v1/license/deactivate', { method: 'POST' }),
  // ---- Vault (Sprint 2.1) ----
  vaultList: (profileId: string) =>
    request<{ list: VaultEntry[] }>(`/api/v1/accounts/${encodeURIComponent(profileId)}`),
  vaultCreate: (profileId: string, body: { label?: string; login?: string; password?: string; totp_secret?: string; notes?: string }) =>
    request<{ id: string }>(`/api/v1/accounts/${encodeURIComponent(profileId)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  vaultUpdate: (profileId: string, entryId: string, body: { label?: string; login?: string; password?: string; totp_secret?: string; notes?: string }) =>
    request<{ id: string }>(`/api/v1/accounts/${encodeURIComponent(profileId)}/${encodeURIComponent(entryId)}/update`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  vaultDelete: (profileId: string, entryId: string) =>
    request<{ deleted: boolean }>(`/api/v1/accounts/${encodeURIComponent(profileId)}/${encodeURIComponent(entryId)}/delete`, {
      method: 'POST',
    }),
  vaultReveal: (profileId: string, entryId: string, field: 'password' | 'totp_secret') =>
    request<{ value: string }>(
      `/api/v1/accounts/${encodeURIComponent(profileId)}/${encodeURIComponent(entryId)}/reveal?field=${field}`
    ),
  // ---- Diagnostics (Sprint 2.2) ----
  diagnosticsRun: (profileId: string) =>
    request<DiagnosticsReport>(`/api/v1/diagnostics/${encodeURIComponent(profileId)}`),
  // ---- Tags (Sprint 2.3) ----
  tagsList: () => request<{ list: TagItem[] }>('/api/v1/tags'),
  tagCreate: (name: string, color?: string) =>
    request<{ id: string }>('/api/v1/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),
  tagUpdate: (tagId: string, body: { name?: string; color?: string | null }) =>
    request<{ id: string }>(`/api/v1/tags/${encodeURIComponent(tagId)}/update`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  tagDelete: (tagId: string) =>
    request<{ deleted: boolean }>(`/api/v1/tags/${encodeURIComponent(tagId)}/delete`, { method: 'POST' }),
  tagAttach: (tagId: string, userIds: string[]) =>
    request<{ attached: number }>(`/api/v1/tags/${encodeURIComponent(tagId)}/attach`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: userIds }),
    }),
  tagDetach: (tagId: string, userIds: string[]) =>
    request<{ detached: number }>(`/api/v1/tags/${encodeURIComponent(tagId)}/detach`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: userIds }),
    }),
  profileTags: (userId: string) =>
    request<{ tags: ProfileTagBinding[] }>(
      `/api/v1/browser-profile/tags?user_id=${encodeURIComponent(userId)}`
    ),
  // ---- Trash (Sprint 2.4) ----
  trashList: () => request<{ list: TrashItem[] }>('/api/v1/trash'),
  trashRestore: (id: string) =>
    request<{ restored: boolean }>(`/api/v1/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  trashDeleteForever: (id: string) =>
    request<{ deleted: boolean }>(`/api/v1/trash/${encodeURIComponent(id)}/delete`, { method: 'POST' }),
  // ---- Export (Sprint 2.5) ----
  exportCsvUrl: () => `${getApiBase()}/api/v1/profiles/export-csv`,
  // ---- Action syncer (Sprint 3) ----
  syncCreate: (profileIds: string[]) =>
    request<SyncSessionInfo>('/api/v1/sync/sessions', {
      method: 'POST',
      body: JSON.stringify({ profile_ids: profileIds }),
    }),
  syncList: () => request<{ list: SyncSessionInfo[] }>('/api/v1/sync/sessions'),
  syncStop: (sessionId: string) =>
    request<{ stopped: boolean }>(`/api/v1/sync/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' }),
  syncJoin: (sessionId: string, profileId: string) =>
    request<SyncSessionInfo>(`/api/v1/sync/sessions/${encodeURIComponent(sessionId)}/join`, {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    }),
  syncLeave: (sessionId: string, profileId: string) =>
    request<SyncSessionInfo>(`/api/v1/sync/sessions/${encodeURIComponent(sessionId)}/leave`, {
      method: 'POST',
      body: JSON.stringify({ profile_id: profileId }),
    }),
  syncTile: (sessionId: string, layout: '2x2' | '3x3' | 'auto') =>
    request<TileResult>('/api/v1/sync/tile', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, layout }),
    }),
  // ---- Scripts (Sprint 4) ----
  scriptsList: () => request<{ list: ScriptItem[] }>('/api/v1/scripts'),
  scriptGet: (id: string) => request<ScriptItem>(`/api/v1/scripts/${encodeURIComponent(id)}`),
  scriptCreate: (name: string, code: string) =>
    request<{ id: string }>('/api/v1/scripts', { method: 'POST', body: JSON.stringify({ name, code }) }),
  scriptUpdate: (id: string, body: { name?: string; code?: string }) =>
    request<Record<string, never>>(`/api/v1/scripts/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  scriptDelete: (id: string) =>
    request<Record<string, never>>(`/api/v1/scripts/${encodeURIComponent(id)}/delete`, { method: 'POST' }),
  scriptRun: (id: string, profileIds: string[]) =>
    request<{ run_ids: string[]; queued: number }>(`/api/v1/scripts/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify({ profile_ids: profileIds }),
    }),
  scriptRuns: (id: string) =>
    request<{ list: ScriptRunItem[] }>(`/api/v1/scripts/${encodeURIComponent(id)}/runs`),
  // ---- Keys (Sprint 4.2) ----
  keysList: () => request<{ list: KeyItem[] }>('/api/v1/keys'),
  keySet: (key: string, value: string) =>
    request<{ key: string }>('/api/v1/keys', { method: 'POST', body: JSON.stringify({ key, value }) }),
  keyDelete: (key: string) =>
    request<Record<string, never>>(`/api/v1/keys/${encodeURIComponent(key)}/delete`, { method: 'POST' }),
  keyReveal: (key: string) =>
    request<{ value: string }>(`/api/v1/keys/${encodeURIComponent(key)}/reveal`),
  // ---- Triggers (Sprint 4.3) ----
  triggersList: () => request<{ list: TriggerItem[] }>('/api/v1/triggers'),
  triggerCreate: (body: { name: string; script_id: string; type: 'schedule' | 'event'; schedule?: string; event?: string }) =>
    request<{ id: string }>('/api/v1/triggers', { method: 'POST', body: JSON.stringify(body) }),
  triggerUpdate: (id: string, body: { name?: string; schedule?: string; event?: string }) =>
    request<Record<string, never>>(`/api/v1/triggers/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  triggerToggle: (id: string, enabled: boolean) =>
    request<{ enabled: boolean }>(`/api/v1/triggers/${encodeURIComponent(id)}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  triggerDelete: (id: string) =>
    request<Record<string, never>>(`/api/v1/triggers/${encodeURIComponent(id)}/delete`, { method: 'POST' }),
  // ---- Preflight & Launch Guard (Task 3.1 & 3.2) ----
  preflightRun: (profileId: string) =>
    request<PreflightVerdict>(`/api/profiles/${encodeURIComponent(profileId)}/preflight`, {
      method: 'POST',
    }),
  preflightLast: (profileId: string) =>
    request<PreflightVerdict>(`/api/profiles/${encodeURIComponent(profileId)}/preflight/last`),
  startWithPreflight: (profileId: string, blockOnFail: boolean = false) =>
    request<{ profileId: string; allowed: boolean; verdict?: PreflightVerdict }>(
      `/api/profiles/${encodeURIComponent(profileId)}/start-with-preflight`,
      {
        method: 'POST',
        body: JSON.stringify({ blockOnFail }),
      }
    ),
  // ---- Cookie Farm (Task 4) ----
  runCookieFarm: (profileId: string) =>
    request<CookieFarmReport>('/api/cookie-robot/run', {
      method: 'POST',
      body: JSON.stringify({ profileId }),
    }),
  startCookieFarm: (profileId: string) =>
    request<{ runId: string; taskUuid: string; profileId: string }>('/api/cookie-robot/run?async=true', {
      method: 'POST',
      body: JSON.stringify({ profileId, async: true }),
    }),
  stopCookieFarm: (params: { runId?: string; profileId?: string }) =>
    request<{ runId: string; stopped: boolean; aborted: boolean }>('/api/cookie-robot/stop', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  cookieFarmProgress: (params: { runId?: string; profileId?: string }) => {
    const qs = new URLSearchParams();
    if (params.runId) qs.set('runId', params.runId);
    if (params.profileId) qs.set('profileId', params.profileId);
    const q = qs.toString();
    return request<CookieFarmProgress>(`/api/cookie-robot/progress${q ? `?${q}` : ''}`);
  },
  cookieFarmReport: (runId: string) =>
    request<CookieFarmReport>(`/api/cookie-robot/reports/${encodeURIComponent(runId)}`),
  cookieFarmReports: (profileId?: string) =>
    request<CookieFarmReport[]>(
      `/api/cookie-robot/reports${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`
    ),
  cookieFarmSites: () =>
    request<{ sites: Array<{ url: string; category: string; weight: number }>; count: number }>(
      '/api/cookie-robot/sites'
    ),
  // ---- Task Groups ----
  securitySettingsGet: () =>
    request<{ captureProtection: boolean; autoLockMinutes: number; mcpScope: 'standard' | 'admin' }>(
      '/api/v1/settings/security'
    ),
  securitySettingsSet: (body: {
    captureProtection?: boolean;
    autoLockMinutes?: number | null;
    mcpScope?: 'standard' | 'admin';
  }) =>
    request<{ captureProtection: boolean; autoLockMinutes: number; mcpScope: 'standard' | 'admin' }>(
      '/api/v1/settings/security',
      {
        method: 'PUT',
        body: JSON.stringify(body),
      }
    ),
  taskGroupsList: () => request<{ list: TaskGroupItem[] }>('/api/task-groups'),
  taskGroupGet: (id: string) => request<TaskGroupItem>(`/api/task-groups/${encodeURIComponent(id)}`),
  taskGroupTasks: (id: string) =>
    request<{
      list: Array<{
        uuid: string;
        group_id: string;
        profile_id: string;
        script_id?: string;
        status: string;
        attempts?: number;
        repeat_count?: number;
        timeout_ms?: number;
        next_run_at?: number;
        created_at?: number;
        updated_at?: number;
        finished_at?: number | null;
        error?: string | null;
      }>;
    }>(`/api/task-groups/${encodeURIComponent(id)}/tasks`),
  taskGroupStop: (id: string) =>
    request<{ status: string }>(`/api/task-groups/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
  // ---- Flows (fleet run view) ----
  flowRun: (id: string, profileIds: string[], concurrency?: number) =>
    request<{
      flowId: string;
      taskGroupId: string;
      group: {
        id: string;
        name: string;
        script_id: string;
        profile_ids: string[];
        active_session_cap: number;
        status: string;
      };
    }>(`/api/flows/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify({
        profile_ids: profileIds,
        ...(concurrency !== undefined ? { concurrency } : {}),
      }),
    }),
  // ---- Email (read-only IMAP + code extraction) ----
  emailAccountsList: () => request<EmailAccount[]>('/api/v1/email/accounts'),
  emailAccountCreate: (body: { label?: string; email: string; host: string; port?: number; username: string; password?: string }) =>
    request<EmailAccount>('/api/v1/email/accounts', { method: 'POST', body: JSON.stringify(body) }),
  emailAccountDelete: (accountId: string) =>
    request<{ deleted: boolean }>(`/api/v1/email/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }),
  emailInboxList: (accountId: string) =>
    request<{ messages: EmailMessageSummary[]; cached: boolean; error?: string }>(
      `/api/v1/email/accounts/${encodeURIComponent(accountId)}/inbox`
    ),
  emailMessageGet: (accountId: string, uid: string) =>
    request<EmailMessageDetail>(`/api/v1/email/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(uid)}`),
  emailExtractCodes: (text: string) =>
    request<{ codes: string[] }>('/api/v1/email/extract-codes', { method: 'POST', body: JSON.stringify({ text }) }),
  // ---- Flow recorder (Wave 2b) ----
  // WebSocket endpoint for the recorder bridge (auth: tunnel key query param,
  // same contract the CDP tunnel uses — WS clients cannot send headers).
  recorderWsUrl: (profileId: string) =>
    `${getApiBase().replace(/^http/, 'ws')}/recorder/${encodeURIComponent(profileId)}${
      apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''
    }`,
  // ---- MCP service endpoints (ShardX sidebar footer) ----
  mcpStatus: () =>
    request<McpStatus>('/api/v1/mcp/status'),
  /** Produce a ready-to-use MCP server in `dir` and return the agent config to paste. */
  mcpBundle: (dir: string) =>
    request<{
      ok: boolean;
      dir?: string;
      zip?: string;
      bytes?: number;
      toolCount?: number;
      scope?: string;
      config?: { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
      error?: string;
    }>('/api/v1/mcp/bundle', { method: 'POST', body: JSON.stringify({ dir }) }),
  mcpStart: () =>
    request<{ ok: boolean; message?: string; status?: McpStatus }>('/api/v1/mcp/start', { method: 'POST' }),
  mcpStop: () =>
    request<{ ok: boolean; message?: string; status?: McpStatus }>('/api/v1/mcp/stop', { method: 'POST' }),
  // ---- Android emulator integration ----
  androidEngine: () =>
    request<AndroidEngineStatus>('/api/v1/android/engine'),
  androidEngineInstall: (apiLevel?: number | { apiLevel?: number }) => {
    const payload = typeof apiLevel === 'number' ? { apiLevel } : (apiLevel ?? {});
    return request<AndroidEngineStatus>('/api/v1/android/engine/install', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  androidInstances: () =>
    request<AndroidInstanceStatus[]>('/api/v1/android/instances'),
  androidStart: (profileId: string) =>
    request<AndroidInstanceStatus>(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/start`, {
      method: 'POST',
    }),
  androidStop: (profileId: string) =>
    request<{ ok: boolean }>(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/stop`, {
      method: 'POST',
    }),
  androidStatus: (profileId: string) =>
    request<AndroidInstanceStatus>(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/status`),
  androidStreamTicket: (profileId: string) =>
    request<AndroidStreamTicket>(`/api/v1/android/profiles/${encodeURIComponent(profileId)}/stream-ticket`, {
      method: 'POST',
    }),
};

export function androidEngine(): Promise<ApiEnvelope<AndroidEngineStatus>> {
  return api.androidEngine();
}
export function androidEngineInstall(apiLevel?: number | { apiLevel?: number }): Promise<ApiEnvelope<AndroidEngineStatus>> {
  return api.androidEngineInstall(apiLevel);
}
export function androidInstances(): Promise<ApiEnvelope<AndroidInstanceStatus[]>> {
  return api.androidInstances();
}
export function androidStart(profileId: string): Promise<ApiEnvelope<AndroidInstanceStatus>> {
  return api.androidStart(profileId);
}
export function androidStop(profileId: string): Promise<ApiEnvelope<{ ok: boolean }>> {
  return api.androidStop(profileId);
}
export function androidStatus(profileId: string): Promise<ApiEnvelope<AndroidInstanceStatus>> {
  return api.androidStatus(profileId);
}
export function androidStreamTicket(profileId: string): Promise<ApiEnvelope<AndroidStreamTicket>> {
  return api.androidStreamTicket(profileId);
}

export function runCookieFarm(profileId: string): Promise<ApiEnvelope<CookieFarmReport>> {
  return api.runCookieFarm(profileId);
}
export function startCookieFarm(
  profileId: string
): Promise<ApiEnvelope<{ runId: string; taskUuid: string; profileId: string }>> {
  return api.startCookieFarm(profileId);
}
export function stopCookieFarm(params: {
  runId?: string;
  profileId?: string;
}): Promise<ApiEnvelope<{ runId: string; stopped: boolean; aborted: boolean }>> {
  return api.stopCookieFarm(params);
}
export function cookieFarmProgress(params: {
  runId?: string;
  profileId?: string;
}): Promise<ApiEnvelope<CookieFarmProgress>> {
  return api.cookieFarmProgress(params);
}
export function cookieFarmReport(runId: string): Promise<ApiEnvelope<CookieFarmReport>> {
  return api.cookieFarmReport(runId);
}
export function cookieFarmReports(profileId?: string): Promise<ApiEnvelope<CookieFarmReport[]>> {
  return api.cookieFarmReports(profileId);
}
export function cookieFarmSites(): Promise<
  ApiEnvelope<{ sites: Array<{ url: string; category: string; weight: number }>; count: number }>
> {
  return api.cookieFarmSites();
}
