import { protectSecret, revealSecret } from '../util/secretStore';
import { SHIPPED_GDRIVE_CLIENT_ID, SHIPPED_GDRIVE_CLIENT_SECRET } from '../config';

export interface GDriveClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface GDriveTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp ms
  scope?: string;
}

export interface GDriveStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  folderId: string | null;
  lastPush: number | null;
  lastPull: number | null;
  email?: string | null;
}

// In-memory / ephemeral access token cache
let inMemoryAccessToken: { token: string; expiresAt: number } | null = null;

// File/setting storage keys (values stored encrypted via protectSecret)
const SECRET_KEY_PREFIX = 'gdrive:';
const KEY_CLIENT_ID = `${SECRET_KEY_PREFIX}clientId`;
const KEY_CLIENT_SECRET = `${SECRET_KEY_PREFIX}clientSecret`;
const KEY_REFRESH_TOKEN = `${SECRET_KEY_PREFIX}refreshToken`;
const KEY_FOLDER_ID = `${SECRET_KEY_PREFIX}folderId`;
const KEY_LAST_PUSH = `${SECRET_KEY_PREFIX}lastPush`;
const KEY_LAST_PULL = `${SECRET_KEY_PREFIX}lastPull`;
const KEY_USER_EMAIL = `${SECRET_KEY_PREFIX}userEmail`;

// Storage adapter interface so tests can mock or use in-memory/custom store
export interface GDriveStorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

// In-memory backing store for settings or tests
class DefaultInMemoryStorage implements GDriveStorageAdapter {
  private map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

let activeStorage: GDriveStorageAdapter = new DefaultInMemoryStorage();

export function setGDriveStorage(storage: GDriveStorageAdapter): void {
  activeStorage = storage;
}

export function getGDriveStorage(): GDriveStorageAdapter {
  return activeStorage;
}

/**
 * Validates the client ID and optional client secret format.
 * Rejects empty or malformed strings.
 */
export function validateClientCredentials(creds: {
  clientId: string;
  clientSecret?: string;
}): { valid: boolean; error?: string } {
  if (!creds || typeof creds.clientId !== 'string') {
    return { valid: false, error: 'Client ID is required' };
  }
  const clientId = creds.clientId.trim();
  if (clientId.length < 5) {
    return { valid: false, error: 'Client ID must be at least 5 characters long' };
  }
  if (creds.clientSecret !== undefined && creds.clientSecret !== null) {
    if (typeof creds.clientSecret !== 'string') {
      return { valid: false, error: 'Client Secret must be a string' };
    }
  }
  return { valid: true };
}

/**
 * Stores OAuth client credentials using DPAPI-backed secret store.
 * Never writes unencrypted credentials to disk or settings.json.
 */
export function saveGDriveCredentials(creds: GDriveClientCredentials): void {
  const check = validateClientCredentials(creds);
  if (!check.valid) {
    throw new Error(check.error || 'Invalid credentials');
  }

  const encClientId = protectSecret(creds.clientId.trim());
  if (!encClientId) throw new Error('Failed to protect client ID');
  activeStorage.set(KEY_CLIENT_ID, encClientId);

  if (creds.clientSecret && creds.clientSecret.trim().length > 0) {
    const encSecret = protectSecret(creds.clientSecret.trim());
    if (encSecret) {
      activeStorage.set(KEY_CLIENT_SECRET, encSecret);
    }
  } else {
    activeStorage.delete(KEY_CLIENT_SECRET);
  }
}

/**
 * Retrieves client credentials, unprotecting them from the secret store.
 * When the operator has stored no credentials of their own, falls back to the
 * publisher's OAuth client ID injected at build time (`SHIPPED_GDRIVE_CLIENT_ID`).
 * Operator-stored credentials always take precedence over the shipped client.
 */
export function getCustomGDriveCredentials(): GDriveClientCredentials | null {
  const encClientId = activeStorage.get(KEY_CLIENT_ID);
  if (encClientId) {
    const clientId = revealSecret(encClientId);
    if (clientId && clientId.trim().length > 0) {
      const encSecret = activeStorage.get(KEY_CLIENT_SECRET);
      const clientSecret = encSecret ? revealSecret(encSecret) ?? undefined : undefined;
      return { clientId: clientId.trim(), clientSecret };
    }
  }
  return null;
}

export function getGDriveCredentials(): GDriveClientCredentials | null {
  const custom = getCustomGDriveCredentials();
  if (custom) return custom;

  if (SHIPPED_GDRIVE_CLIENT_ID && SHIPPED_GDRIVE_CLIENT_ID.trim().length > 0) {
    // The secret rides only when the build was given one: a Desktop client does consent over PKCE,
    // while a device-flow fallback against this same client would be rejected by Google without it.
    const secret = SHIPPED_GDRIVE_CLIENT_SECRET.trim();
    return secret.length > 0
      ? { clientId: SHIPPED_GDRIVE_CLIENT_ID.trim(), clientSecret: secret }
      : { clientId: SHIPPED_GDRIVE_CLIENT_ID.trim() };
  }

  return null;
}

/**
 * Saves refresh token into the secret store.
 */
export function saveGDriveRefreshToken(refreshToken: string): void {
  if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    throw new Error('Invalid refresh token');
  }
  const enc = protectSecret(refreshToken.trim());
  if (!enc) throw new Error('Failed to protect refresh token');
  activeStorage.set(KEY_REFRESH_TOKEN, enc);
}

/**
 * Retrieves refresh token from the secret store.
 */
export function getGDriveRefreshToken(): string | null {
  const enc = activeStorage.get(KEY_REFRESH_TOKEN);
  if (!enc) return null;
  // revealSecret reports a failure to decrypt as undefined; the contract here is
  // null, so an unreadable token reads as "not connected" rather than a blank string.
  return revealSecret(enc) ?? null;
}

/**
 * Saves in-memory access token.
 */
export function setCachedAccessToken(token: string, expiresInSec: number): void {
  inMemoryAccessToken = {
    token,
    expiresAt: Date.now() + expiresInSec * 1000,
  };
}

export function getCachedAccessToken(): string | null {
  if (!inMemoryAccessToken) return null;
  if (Date.now() >= inMemoryAccessToken.expiresAt - 30_000) {
    // Expired or about to expire in 30 seconds
    return null;
  }
  return inMemoryAccessToken.token;
}

export function saveGDriveFolderId(folderId: string): void {
  activeStorage.set(KEY_FOLDER_ID, folderId);
}

export function getGDriveFolderId(): string | null {
  return activeStorage.get(KEY_FOLDER_ID);
}

/**
 * Forget the remembered folder id without touching the connection.
 *
 * Needed when Drive stops knowing the folder — deleted by hand, or the operator pointed the app at
 * a different account. Returning the stale id would make every later call fail with a 404 the
 * operator cannot interpret, so discovery re-runs from the folder name instead.
 */
export function clearGDriveFolderId(): void {
  activeStorage.delete(KEY_FOLDER_ID);
}

export function saveGDriveUserEmail(email: string): void {
  activeStorage.set(KEY_USER_EMAIL, email);
}

export function getGDriveUserEmail(): string | null {
  return activeStorage.get(KEY_USER_EMAIL);
}

export function recordGDrivePushTimestamp(ts: number = Date.now()): void {
  activeStorage.set(KEY_LAST_PUSH, String(ts));
}

export function recordGDrivePullTimestamp(ts: number = Date.now()): void {
  activeStorage.set(KEY_LAST_PULL, String(ts));
}

export function getGDriveTimestamps(): { lastPush: number | null; lastPull: number | null } {
  const pushStr = activeStorage.get(KEY_LAST_PUSH);
  const pullStr = activeStorage.get(KEY_LAST_PULL);
  return {
    lastPush: pushStr ? parseInt(pushStr, 10) : null,
    lastPull: pullStr ? parseInt(pullStr, 10) : null,
  };
}

/**
 * Clears stored tokens and resets active connection state.
 */
export function disconnectGDrive(): void {
  inMemoryAccessToken = null;
  activeStorage.delete(KEY_REFRESH_TOKEN);
}

/**
 * Complete purge of GDrive configuration and state.
 */
export function purgeGDriveConfiguration(): void {
  inMemoryAccessToken = null;
  activeStorage.delete(KEY_CLIENT_ID);
  activeStorage.delete(KEY_CLIENT_SECRET);
  activeStorage.delete(KEY_REFRESH_TOKEN);
  activeStorage.delete(KEY_FOLDER_ID);
  activeStorage.delete(KEY_LAST_PUSH);
  activeStorage.delete(KEY_LAST_PULL);
  activeStorage.delete(KEY_USER_EMAIL);
}

/**
 * Returns safe status object for API responses.
 * GUARANTEE: Never includes raw tokens, refresh tokens, or client secrets.
 */
export function getGDriveStatus(): GDriveStatus {
  const creds = getGDriveCredentials();
  const configured = Boolean(creds && creds.clientId);
  const refreshToken = getGDriveRefreshToken();
  const connected = Boolean(configured && refreshToken);
  const folderId = getGDriveFolderId();
  const { lastPush, lastPull } = getGDriveTimestamps();
  const email = getGDriveUserEmail();

  return {
    enabled: configured,
    configured,
    connected,
    folderId,
    lastPush,
    lastPull,
    email,
  };
}
