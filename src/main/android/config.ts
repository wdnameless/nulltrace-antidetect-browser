import { getDb } from '../db';
import { revealSecret } from '../util/secretStore';
import { migrateLegacySeed } from '../fingerprints/derivation';
import { getMobilePreset, pickMobilePreset } from '../devices/mobilePresets';
import { generateAndroidFingerprint, type AndroidFingerprint } from './fingerprint';

export interface ResolvedAndroidConfig {
  profileId: string;
  name: string | null;
  fingerprint: AndroidFingerprint;
  screen: { width: number; height: number };
  densityDpi: number;
  proxy: { type: string; host: string; port: number; username: string | null; password: string | null } | null;
  timezone: string | null;
  geolocation: { latitude: number; longitude: number } | null;
  seed: number;
}

export class AndroidConfigError extends Error {
  constructor(
    message: string,
    public readonly code: 'ERR_ANDROID_PROFILE_NOT_FOUND' | 'ERR_ANDROID_PROFILE_TYPE'
  ) {
    super(message);
    this.name = 'AndroidConfigError';
  }
}

/**
 * Reads the LIVE profile row (deleted_at IS NULL) and its proxy row with its own
 * prepared statements. Does NOT touch resolveLaunchConfig, preserving byte-identical
 * desktop launch isolation (R18).
 */
export function resolveAndroidConfig(profileId: string): ResolvedAndroidConfig {
  const db = getDb();

  const profile = db
    .prepare(
      `SELECT p.id, p.name, p.proxy_id, p.fingerprint_id, p.browser_type,
              p.timezone, p.geolocation, p.mobile_model_id, p.deleted_at,
              fp.seed AS fingerprint_seed
       FROM profiles p
       LEFT JOIN fingerprints fp ON fp.id = p.fingerprint_id
       WHERE p.id = ?`
    )
    .get(profileId) as
    | {
        id: string;
        name: string | null;
        proxy_id: string | null;
        fingerprint_id: string | null;
        browser_type: string | null;
        timezone: string | null;
        geolocation: string | null;
        mobile_model_id: string | null;
        deleted_at: number | null;
        fingerprint_seed: number | null;
      }
    | undefined;

  if (!profile || profile.deleted_at !== null) {
    throw new AndroidConfigError(`Android profile not found: ${profileId}`, 'ERR_ANDROID_PROFILE_NOT_FOUND');
  }

  if (profile.browser_type !== 'android') {
    throw new AndroidConfigError(
      `Profile ${profileId} has browser_type '${profile.browser_type}', expected 'android'`,
      'ERR_ANDROID_PROFILE_TYPE'
    );
  }

  // Re-uses fingerprint seed derivation from profile row / fingerprints table
  const seed = migrateLegacySeed(profileId, profile.fingerprint_seed);
  const fingerprint = generateAndroidFingerprint(profileId, seed);

  // Screen + density from the fingerprint (single source, physical px). The preset dims
  // are dp; generateAndroidFingerprint multiplies by deviceScaleFactor already.
  const preset = profile.mobile_model_id
    ? getMobilePreset(profile.mobile_model_id)
    : pickMobilePreset(seed);

  const screen = { width: fingerprint.screen.width, height: fingerprint.screen.height };
  const densityDpi = fingerprint.screen.densityDpi;

  let proxy: ResolvedAndroidConfig['proxy'] = null;
  let pxTimezone: string | null = null;
  let pxGeo: { latitude: number; longitude: number } | null = null;

  if (profile.proxy_id) {
    const px = db
      .prepare(
        `SELECT type, host, port, username, password, timezone, latitude, longitude
         FROM proxies
         WHERE id = ?`
      )
      .get(profile.proxy_id) as
      | {
          type: string;
          host: string;
          port: number;
          username: string | null;
          password: string | null;
          timezone: string | null;
          latitude: number | null;
          longitude: number | null;
        }
      | undefined;

    if (px) {
      proxy = {
        type: px.type,
        host: px.host,
        port: px.port,
        username: px.username ?? null,
        password: revealSecret(px.password) ?? null,
      };
      pxTimezone = px.timezone ?? null;
      if (typeof px.latitude === 'number' && typeof px.longitude === 'number') {
        pxGeo = { latitude: px.latitude, longitude: px.longitude };
      }
    }
  }

  let geolocation: { latitude: number; longitude: number } | null = null;
  if (profile.geolocation) {
    try {
      const parsed = JSON.parse(profile.geolocation) as { latitude?: number; longitude?: number };
      if (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
        geolocation = { latitude: parsed.latitude, longitude: parsed.longitude };
      }
    } catch {
      // ignore JSON parse failure, fallback to proxy coordinates
    }
  }
  if (!geolocation) {
    geolocation = pxGeo;
  }

  const timezone = profile.timezone || pxTimezone || null;

  return {
    profileId,
    name: profile.name ?? null,
    fingerprint,
    screen,
    densityDpi,
    proxy,
    timezone,
    geolocation,
    seed,
  };
}
