import fetch from 'node-fetch';
import {
  GDriveClientCredentials,
  getGDriveCredentials,
  getGDriveRefreshToken,
  saveGDriveRefreshToken,
  setCachedAccessToken,
  getCachedAccessToken,
  saveGDriveUserEmail,
} from './gdriveAuth';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface TokenExchangeResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

export interface UserInfoResponse {
  email?: string;
  name?: string;
}

export interface OAuthTransport {
  requestDeviceCode(clientId: string, scope: string): Promise<DeviceCodeResponse>;
  pollDeviceToken(
    clientId: string,
    clientSecret: string | undefined,
    deviceCode: string
  ): Promise<{ status: 'pending' | 'slow_down' | 'success'; data?: TokenExchangeResponse }>;
  exchangeAuthCode(
    clientId: string,
    clientSecret: string | undefined,
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<TokenExchangeResponse>;
  refreshAccessToken(
    clientId: string,
    clientSecret: string | undefined,
    refreshToken: string
  ): Promise<{ accessToken: string; expiresInSec: number; scope?: string }>;
  fetchUserInfo(accessToken: string): Promise<UserInfoResponse>;
}

export const GDRIVE_REQUIRED_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'EXPIRED_GRANT' | 'REVOKED_CLIENT' | 'MISSING_SCOPE' | 'NETWORK_ERROR' | 'AUTH_FAILED',
    public readonly userActionableMessage: string
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

/**
 * Standard HTTP transport implementing Google OAuth 2.0 endpoints
 */
export class HttpOAuthTransport implements OAuthTransport {
  async requestDeviceCode(clientId: string, scope: string): Promise<DeviceCodeResponse> {
    const res = await fetch('https://oauth2.googleapis.com/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        scope,
      }).toString(),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw parseOAuthHttpError(res.status, errBody);
    }
    return (await res.json()) as DeviceCodeResponse;
  }

  async pollDeviceToken(
    clientId: string,
    clientSecret: string | undefined,
    deviceCode: string
  ): Promise<{ status: 'pending' | 'slow_down' | 'success'; data?: TokenExchangeResponse }> {
    const params: Record<string, string> = {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    };
    if (clientSecret) params.client_secret = clientSecret;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    const json = (await res.json()) as Record<string, any>;
    if (json.error === 'authorization_pending') {
      return { status: 'pending' };
    }
    if (json.error === 'slow_down') {
      return { status: 'slow_down' };
    }
    if (!res.ok || json.error) {
      throw parseOAuthTokenError(json);
    }
    return { status: 'success', data: json as TokenExchangeResponse };
  }

  /**
   * Exchange an authorization code for tokens.
   *
   * `codeVerifier` is the PKCE half of the pair whose challenge went out with the authorization
   * request. Google requires it for a Desktop client and rejects the exchange without it, which is
   * also what makes a stolen code useless: the verifier never left this process until now.
   */
  async exchangeAuthCode(
    clientId: string,
    clientSecret: string | undefined,
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<TokenExchangeResponse> {
    const params: Record<string, string> = {
      client_id: clientId,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    };
    if (clientSecret) params.client_secret = clientSecret;
    if (codeVerifier) params.code_verifier = codeVerifier;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    const json = (await res.json()) as Record<string, any>;
    if (!res.ok || json.error) {
      throw parseOAuthTokenError(json);
    }
    return json as TokenExchangeResponse;
  }

  async refreshAccessToken(
    clientId: string,
    clientSecret: string | undefined,
    refreshToken: string
  ): Promise<{ accessToken: string; expiresInSec: number; scope?: string }> {
    const params: Record<string, string> = {
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    if (clientSecret) params.client_secret = clientSecret;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    const json = (await res.json()) as Record<string, any>;
    if (!res.ok || json.error) {
      throw parseOAuthTokenError(json);
    }
    return {
      accessToken: json.access_token,
      expiresInSec: json.expires_in || 3600,
      scope: json.scope,
    };
  }

  async fetchUserInfo(accessToken: string): Promise<UserInfoResponse> {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return {};
    return (await res.json()) as UserInfoResponse;
  }
}

function parseOAuthHttpError(status: number, body: string): GoogleOAuthError {
  let parsed: any = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // raw text
  }
  return parseOAuthTokenError(parsed.error ? parsed : { error: `http_${status}`, error_description: body });
}

export function parseOAuthTokenError(json: Record<string, any>): GoogleOAuthError {
  const err = String(json.error || '').toLowerCase();
  const desc = String(json.error_description || '');

  if (err === 'invalid_grant' || desc.includes('revoked') || desc.includes('expired')) {
    return new GoogleOAuthError(
      `Grant expired or revoked: ${desc || err}`,
      'EXPIRED_GRANT',
      'Google authorization has expired or was revoked. Please reconnect in Cloud Sync settings.'
    );
  }
  if (err === 'invalid_client' || err === 'unauthorized_client') {
    return new GoogleOAuthError(
      `Invalid client: ${desc || err}`,
      'REVOKED_CLIENT',
      'OAuth Client ID or Secret is invalid or disabled in Google Cloud Console. Verify your credentials.'
    );
  }
  if (err === 'invalid_scope' || desc.includes('scope')) {
    return new GoogleOAuthError(
      `Missing or invalid scope: ${desc || err}`,
      'MISSING_SCOPE',
      'The OAuth client is missing the required Google Drive scope (drive.file). Enable Drive API and configure scopes in your Google Cloud Console.'
    );
  }

  return new GoogleOAuthError(
    `OAuth error: ${err} - ${desc}`,
    'AUTH_FAILED',
    `Authentication failed: ${desc || err}. Check console and reconnect.`
  );
}

// Active transport instance (swappable for testing)
let activeTransport: OAuthTransport = new HttpOAuthTransport();

export function setOAuthTransport(transport: OAuthTransport): void {
  activeTransport = transport;
}

export function getOAuthTransport(): OAuthTransport {
  return activeTransport;
}

/**
 * Ensures a valid access token exists, refreshing using the stored refresh token if expired.
 * Failures report clear operator-actionable errors.
 */
export async function ensureValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh) {
    const cached = getCachedAccessToken();
    if (cached) return cached;
  }

  const creds = getGDriveCredentials();
  if (!creds || !creds.clientId) {
    throw new GoogleOAuthError(
      'No OAuth client credentials configured',
      'REVOKED_CLIENT',
      'No Google OAuth Client configured. Please enter your OAuth Client ID in Cloud Sync settings.'
    );
  }

  const refreshToken = getGDriveRefreshToken();
  if (!refreshToken) {
    throw new GoogleOAuthError(
      'Not connected to Google Drive',
      'EXPIRED_GRANT',
      'Not connected to Google Drive. Please complete authorization in Cloud Sync settings.'
    );
  }

  try {
    const refreshed = await activeTransport.refreshAccessToken(
      creds.clientId,
      creds.clientSecret,
      refreshToken
    );

    if (refreshed.scope && !refreshed.scope.includes('drive')) {
      throw new GoogleOAuthError(
        'Granted scope lacks Drive permissions',
        'MISSING_SCOPE',
        'Authorization lacks Google Drive scope. Please reconnect and grant Drive permissions.'
      );
    }

    setCachedAccessToken(refreshed.accessToken, refreshed.expiresInSec);
    return refreshed.accessToken;
  } catch (err) {
    if (err instanceof GoogleOAuthError) {
      throw err;
    }
    throw new GoogleOAuthError(
      `Token refresh network failure: ${(err as Error).message}`,
      'NETWORK_ERROR',
      `Cannot connect to Google servers: ${(err as Error).message}. Check internet connection.`
    );
  }
}

/**
 * Completes token exchange and saves credentials/refresh token.
 */
export async function finalizeTokenExchange(tokens: TokenExchangeResponse): Promise<{ email?: string }> {
  if (!tokens.access_token) {
    throw new GoogleOAuthError('No access token received', 'AUTH_FAILED', 'Failed to receive access token from Google.');
  }

  if (tokens.refresh_token) {
    saveGDriveRefreshToken(tokens.refresh_token);
  } else {
    // If no refresh token returned, verify we already have one
    const existing = getGDriveRefreshToken();
    if (!existing) {
      throw new GoogleOAuthError(
        'No refresh token received from Google',
        'EXPIRED_GRANT',
        'Google did not return an offline refresh token. In Google Cloud Console, ensure offline access prompt is enabled.'
      );
    }
  }

  setCachedAccessToken(tokens.access_token, tokens.expires_in || 3600);

  let email: string | undefined;
  try {
    const userInfo = await activeTransport.fetchUserInfo(tokens.access_token);
    if (userInfo.email) {
      email = userInfo.email;
      saveGDriveUserEmail(userInfo.email);
    }
  } catch {
    // optional info
  }

  return { email };
}
