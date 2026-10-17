export interface ClientConfig {
  baseUrl?: string;
  token?: string;
  timeout?: number;
}

export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

export interface BrowserStartData {
  ws?: {
    puppeteer?: string;
    selenium?: string;
  };
  pid?: number;
  debug_port?: number;
  [key: string]: unknown;
}

export interface ProfileItem {
  user_id: string;
  name: string;
  group_id?: string;
  browser_type?: 'chrome' | 'firefox';
  proxy_id?: string;
  created_at?: number;
  updated_at?: number;
  [key: string]: unknown;
}

export interface ProfileListFilter {
  page?: number;
  page_size?: number;
  group_id?: string;
  name?: string;
}

export interface ProfileListResult {
  list: ProfileItem[];
  total?: number;
  page?: number;
  page_size?: number;
}

export interface CreateProfileParams {
  name: string;
  group_id?: string;
  proxy_id?: string;
  browser_type?: 'chrome' | 'firefox';
  os?: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  notes?: string;
  [key: string]: unknown;
}

export interface UpdateProfileParams {
  user_id: string;
  name?: string;
  group_id?: string;
  proxy_id?: string;
  notes?: string;
  [key: string]: unknown;
}

export interface TemporaryProfileParams {
  name?: string;
  browser_type?: 'chrome' | 'firefox';
  proxy_id?: string;
  os?: 'windows' | 'macos' | 'linux';
  ttl_minutes?: number;
  [key: string]: unknown;
}

export interface ProxyItem {
  proxy_id?: string;
  id?: string;
  type: 'http' | 'https' | 'socks5' | 'ssh' | string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

export interface CreateProxyParams {
  type: 'http' | 'https' | 'socks5' | 'ssh' | string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  name?: string;
  [key: string]: unknown;
}

export interface UpdateProxyParams {
  proxy_id: string;
  type?: 'http' | 'https' | 'socks5' | 'ssh' | string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ProxyCheckResult {
  ok?: boolean;
  status?: string;
  latency_ms?: number;
  ip?: string;
  country?: string;
  [key: string]: unknown;
}

export interface DiagnosticReport {
  profileId: string;
  timestamp?: number;
  checks?: Record<string, unknown>;
  [key: string]: unknown;
}

// ==========================================
// Email Types
// ==========================================

export interface EmailAccountMasked {
  id: string;
  label: string | null;
  email: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  created_at: number;
  updated_at: number;
  display_name: string | null;
  signature: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  profile_id: string | null;
}

export interface EmailAccountFilter {
  profile_id?: string | null;
}

export interface CreateEmailAccountParams {
  email: string;
  host: string;
  username: string;
  port?: number;
  password?: string;
  label?: string;
  display_name?: string | null;
  signature?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: boolean | number | null;
  profile_id?: string | null;
}

export interface UpdateEmailAccountParams {
  email?: string;
  host?: string;
  username?: string;
  port?: number;
  password?: string;
  label?: string;
  display_name?: string | null;
  signature?: string | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: boolean | number | null;
  profile_id?: string | null;
}

export interface BindEmailProfileParams {
  profile_id?: string | null;
}

export interface EmailFolderItem {
  name: string;
  unread: number;
}

export interface EmailMessageSummary {
  uid: string;
  subject: string;
  from: string;
  date: string;
  flags?: string[];
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  messageId?: string;
}

export interface EmailMessageDetail extends EmailMessageSummary {
  id?: string;
  accountId?: string;
  body: string;
  text?: string;
  html?: string;
  cached?: boolean;
  error?: string;
  folder?: string;
}

export interface EmailInboxResult {
  messages: EmailMessageSummary[];
  cached: boolean;
  error?: string;
  total?: number;
}

export interface EmailMessagesQuery {
  q?: string;
  unread?: boolean | string | number;
}

export interface EmailSetFlagsParams {
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  folder?: string;
}

export interface EmailSendParams {
  to: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[] | string;
}

export interface EmailSendResult {
  messageId: string;
}

export interface EmailOutboxItem {
  id: string;
  accountId?: string;
  account_id?: string;
  to: string[];
  to_addrs?: string;
  subject: string;
  status: string;
  providerMsgId?: string | null;
  provider_msg_id?: string | null;
  error?: string | null;
  createdAt?: number;
  created_at?: number;
}

export interface EmailDraftParams {
  id?: string;
  to?: string[] | string;
  to_addrs?: string[] | string;
  cc?: string[] | string;
  bcc?: string[] | string;
  subject?: string;
  bodyText?: string;
  body_text?: string;
  bodyHtml?: string;
  body_html?: string;
  inReplyTo?: string;
  in_reply_to?: string;
}

export interface EmailDraftItem {
  id: string;
  accountId?: string;
  account_id?: string;
  to: string[];
  to_addrs?: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  bodyText?: string | null;
  body_text?: string | null;
  bodyHtml?: string | null;
  body_html?: string | null;
  inReplyTo?: string | null;
  in_reply_to?: string | null;
  updatedAt?: number;
  updated_at?: number;
}

export interface EmailExtractCodesResult {
  codes: string[];
}

export interface EmailMessageCodesResult {
  codes: string[];
  message: EmailMessageDetail;
}

export interface EmailAccountCodesResult {
  codes: Array<{ uid: string; subject: string; codes: string[] }>;
}

export interface EmailDeleteResult {
  deleted: boolean;
}

export interface EmailPasswordResult {
  password: string;
}

export interface EmailSetFlagsResult {
  success: boolean;
}
