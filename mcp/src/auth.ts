import * as crypto from 'node:crypto';

export interface TokenPayload {
  sub: string;
  aud: 'antidetect-mcp';
  scope: string;
  iat: number;
  exp: number;
  nonce?: string;
  jti?: string;
  [key: string]: unknown;
}

export const PROHIBITED_TOOL_NAMES = new Set<string>([
  'cdp.send',
  'cdp',
  'Runtime.evaluate',
  'runtime.evaluate',
  'Page.addScriptToEvaluateOnNewDocument',
  'process.exec',
  'child_process',
  'fs.read',
  'fs.write',
  'fs.delete',
  'credentials.dump',
  'credentials.extract',
  'evaluate_raw',
  'eval',
  'shell.exec',
]);

export const GATED_TOOL_NAMES = new Set<string>([
  'profiles.delete',
  'profiles.restore',
  'profiles.export_preserved',
  'profiles.cleanup_preserved',
  'browser.evaluate_allowlisted',
  'proxies.delete',
  'extensions.delete',
  'trash.delete_forever',
  'cookies.export',
  'cookies.import',
  'triggers.delete',
  'batch.delete',
  'email.messages.send',
  'email.accounts.delete',
]);

export const DEFAULT_TOOL_NAMES = new Set<string>([
  'profiles.list',
  'profiles.get',
  'profiles.create',
  'profiles.start',
  'profiles.stop',
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.human_type',
  'browser.human_click',
  'browser.screenshot',
  'android.start',
  'android.stop',
  'android.status',
  'android.tap',
  'android.swipe',
  'android.type',
  'android.key',
  'android.screencap',
  'android.install_apk',
  'browser.run_round',
  'browser.snapshot',
  'browser.tabs',
  'diagnostics.run',
  'proxies.list',
  'proxies.create',
  'proxies.check',
  'extensions.list',
  'extensions.install',
  'flows.list',
  'flows.get',
  'flows.run',
  'flows.validate',
  'task_groups.list',
  'task_groups.get',
  'task_groups.tasks',
  'task_groups.start',
  'task_groups.stop',
  'trash.list',
  'triggers.list',
  'triggers.create',
  'triggers.toggle',
  'tags.list',
  'tags.attach',
  'tags.detach',
  'batch.start',
  'batch.stop',
  'email.accounts.list',
  'email.accounts.get',
  'email.accounts.create',
  'email.accounts.update',
  'email.accounts.bind_profile',
  'email.folders.list',
  'email.messages.list',
  'email.messages.read',
  'email.messages.search',
  'email.messages.set_flags',
  'email.codes.extract',
  'email.drafts.save',
  'email.drafts.list',
  'email.drafts.delete',
  'email.outbox.list',
]);

export class NonceReplayDefense {
  private readonly seenNonces: Map<string, number> = new Map();
  private readonly windowMs: number;

  constructor(windowMs: number = 15 * 60 * 1000) {
    this.windowMs = windowMs;
  }

  public validateAndRecord(nonce: string, now: number = Date.now()): { valid: boolean; error?: string } {
    if (!nonce || typeof nonce !== 'string' || nonce.trim() === '') {
      return { valid: false, error: 'Nonce is required' };
    }

    this.cleanup(now);

    if (this.seenNonces.has(nonce)) {
      return { valid: false, error: `Replayed nonce detected: ${nonce}` };
    }

    this.seenNonces.set(nonce, now);
    return { valid: true };
  }

  private cleanup(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [n, ts] of this.seenNonces.entries()) {
      if (ts < cutoff) {
        this.seenNonces.delete(n);
      }
    }
  }

  public clear(): void {
    this.seenNonces.clear();
  }
}
export interface RevocationEntry {
  jti: string;
  exp: number; // expiry timestamp in seconds
  revokedAt: number; // revocation timestamp in seconds
  sub?: string;
  aud?: string;
}

export class TokenRevocationList {
  private readonly revoked = new Map<string, RevocationEntry>();
  // Map active sessions: `${sub}:${aud}` -> latest jti
  private readonly activeTokens = new Map<string, { jti: string; exp: number }>();

  public revoke(jti: string, exp?: number, sub?: string, aud?: string): void {
    const now = Math.floor(Date.now() / 1000);
    const expiry = exp !== undefined ? exp : now + 3600; // default 1 hour if unknown
    this.revoked.set(jti, {
      jti,
      exp: expiry,
      revokedAt: now,
      sub,
      aud,
    });
  }

  public isRevoked(jti: string): boolean {
    return this.revoked.has(jti);
  }

  public registerActiveToken(sub: string, aud: string, jti: string, exp: number): void {
    const key = `${sub}:${aud}`;
    const existing = this.activeTokens.get(key);
    if (existing && existing.jti !== jti) {
      // Revoke-on-refresh semantics: previous jti auto-revoked
      this.revoke(existing.jti, existing.exp, sub, aud);
    }
    this.activeTokens.set(key, { jti, exp });
  }

  public prune(nowSec: number = Math.floor(Date.now() / 1000)): number {
    let removedCount = 0;
    for (const [jti, entry] of this.revoked.entries()) {
      if (entry.exp < nowSec) {
        this.revoked.delete(jti);
        removedCount++;
      }
    }
    for (const [key, entry] of this.activeTokens.entries()) {
      if (entry.exp < nowSec) {
        this.activeTokens.delete(key);
      }
    }
    return removedCount;
  }

  public size(): number {
    return this.revoked.size;
  }

  public clear(): void {
    this.revoked.clear();
    this.activeTokens.clear();
  }
}

export class SessionTokenManager {
  private readonly secret: string;
  private readonly maxTtlSeconds: number;
  private readonly revocationList: TokenRevocationList;

  constructor(
    secret: string = process.env.ANTIDETECT_MCP_SECRET || 'antidetect-mcp-default-secret',
    maxTtlSeconds: number = 900,
    revocationList?: TokenRevocationList
  ) {
    this.secret = secret;
    this.maxTtlSeconds = Math.min(maxTtlSeconds, 900); // 15 mins max
    this.revocationList = revocationList ?? new TokenRevocationList();
  }

  public getRevocationList(): TokenRevocationList {
    return this.revocationList;
  }

  public generateToken(
    sub: string,
    scope: string = 'standard',
    ttlSeconds?: number,
    nonce?: string,
    jti?: string
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const ttl = ttlSeconds !== undefined ? Math.min(ttlSeconds, this.maxTtlSeconds) : this.maxTtlSeconds;
    const exp = now + ttl;
    const tokenJti = jti || crypto.randomUUID();
    const payload: TokenPayload = {
      sub,
      aud: 'antidetect-mcp',
      scope,
      iat: now,
      exp,
      jti: tokenJti,
      ...(nonce ? { nonce } : {}),
    };

    // Revoke-on-refresh semantics: when a new token is issued for the same sub+audience, previous jti auto-revoked
    this.revocationList.registerActiveToken(sub, 'antidetect-mcp', tokenJti, exp);

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(`${header}.${body}`)
      .digest('base64url');

    return `${header}.${body}.${signature}`;
  }

  public verifyToken(
    token: string,
    nowSec: number = Math.floor(Date.now() / 1000)
  ): { valid: boolean; payload?: TokenPayload; error?: string } {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Token missing or invalid format' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWT structure' };
    }

    const [headerB64, bodyB64, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.secret)
      .update(`${headerB64}.${bodyB64}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, error: 'Invalid token signature' };
    }

    try {
      const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as TokenPayload;

      if (payload.aud !== 'antidetect-mcp') {
        return { valid: false, error: `Invalid audience: expected antidetect-mcp, got ${payload.aud}` };
      }

      if (payload.exp && payload.exp < nowSec) {
        return { valid: false, error: `Token expired at ${payload.exp}, current ${nowSec}` };
      }

      // Check token revocation list
      if (payload.jti && this.revocationList.isRevoked(payload.jti)) {
        return { valid: false, error: `Token revoked (jti: ${payload.jti})` };
      }

      return { valid: true, payload };
    } catch (err) {
      return { valid: false, error: `Malformed token payload: ${String(err)}` };
    }
  }
}

export function isProhibitedTool(toolName: string): boolean {
  if (PROHIBITED_TOOL_NAMES.has(toolName)) {
    return true;
  }
  const lower = toolName.toLowerCase();
  if (
    lower.includes('cdp') ||
    lower.includes('runtime.eval') ||
    lower.includes('child_process') ||
    lower.includes('process.exec') ||
    lower.includes('credentials') ||
    lower.includes('fs.read') ||
    lower.includes('fs.write')
  ) {
    return true;
  }
  return false;
}

export function isAuthorized(toolName: string, callerScope: string = 'standard', allowedGatedEnv?: string): boolean {
  if (isProhibitedTool(toolName)) {
    return false;
  }

  if (DEFAULT_TOOL_NAMES.has(toolName)) {
    return true;
  }

  if (GATED_TOOL_NAMES.has(toolName)) {
    const scopes = callerScope.split(/[\s,]+/).filter(Boolean);
    if (scopes.includes('admin') || scopes.includes('profile:write_danger')) {
      return true;
    }
    // email:send authorizes ONLY the send tool — it must not imply delete.
    if (toolName === 'email.messages.send' && (scopes.includes('email:send') || scopes.includes('mail:send'))) {
      return true;
    }
    const envList = allowedGatedEnv !== undefined ? allowedGatedEnv : (process.env.ANTIDETECT_MCP_GATED || '');
    if (envList) {
      const allowed = envList.split(',').map((s) => s.trim().toLowerCase());
      if (allowed.includes('*') || allowed.includes(toolName.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  // Unknown tools are unauthorized by default
  return false;
}
