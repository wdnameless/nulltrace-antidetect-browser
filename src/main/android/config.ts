import { getDb } from '../db';
import { revealSecret } from '../util/secretStore';
import { migrateLegacySeed } from '../fingerprints/derivation';
import { getMobilePreset, pickMobilePreset } from '../devices/mobilePresets';
import { generateAndroidFingerprint, type AndroidFingerprint } from './fingerprint';
import { geoIdentityFor } from './geoIdentity';

export interface ResolvedAndroidConfig {
  // Per-profile hardware, resolved from android_config JSON with fingerprint fallbacks.
  cores: number;
  ramMb: number;
  heapMb: number;
  profileId: string;
  name: string | null;
  fingerprint: AndroidFingerprint;
  screen: { width: number; height: number };
  densityDpi: number;
  proxy: { type: string; host: string; port: number; username: string | null; password: string | null } | null;
  timezone: string | null;
  geolocation: { latitude: number; longitude: number } | null;
  /** Geo-linked mobile identity (interfaces §C): proxy country drives locale + MCC/MNC. */
  locale: string;
  mccMnc: string;
  operatorAlpha: string;
  /** Opt into the fail-closed no-egress sandbox for proxy-less profiles. */
  blockNetwork?: boolean;
  /** Rotation counter (0 = never rotated). */
  identityEpoch: number;
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
              p.timezone, p.geolocation, p.mobile_model_id, p.android_config, p.deleted_at,
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
        android_config: string | null;
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

  // Seed: explicit android_config.seed wins, else legacy derivation. Fingerprint honors an
  // explicit preset (android_config.presetId, then legacy mobile_model_id); unknown ids fall
  // back to seed-picked — a typo must boot a phone, not throw.
  const hwEarly = parseAndroidHwConfig(profile.android_config);
  const seed = hwEarly.seed ?? migrateLegacySeed(profileId, profile.fingerprint_seed);
  const preset =
    (hwEarly.presetId ? getMobilePreset(hwEarly.presetId) : undefined) ??
    (profile.mobile_model_id ? getMobilePreset(profile.mobile_model_id) : undefined) ??
    pickMobilePreset(seed);
  const fingerprint = generateAndroidFingerprint(profileId, seed, preset.id, hwEarly.identityEpoch ?? 0);

  // Per-profile hw overrides from the same JSON. Invalid JSON or out-of-range values fall
  // back to fingerprint defaults — clamp, never throw.
  const hw = hwEarly;
  const clamp = (v: number | undefined, lo: number, hi: number, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fb;
  const screen = {
    width: clamp(hw.screenW, 320, 2160, fingerprint.screen.width),
    height: clamp(hw.screenH, 480, 4320, fingerprint.screen.height),
  };
  const densityDpi = clamp(hw.densityDpi, 120, 640, fingerprint.screen.densityDpi);
  const cores = clamp(hw.cores, 1, 16, 4);
  const ramMb = clamp(hw.ramMb, 1024, 16384, 6144);
  const heapMb = clamp(hw.heapMb, 128, 2048, 768);

  let proxy: ResolvedAndroidConfig['proxy'] = null;
  let pxTimezone: string | null = null;
  let pxGeo: { latitude: number; longitude: number } | null = null;
  let pxCountryCode: string | null = null;

  if (profile.proxy_id) {
    const px = db
      .prepare(
        `SELECT type, host, port, username, password, timezone, latitude, longitude, country_code
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
          country_code: string | null;
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
      pxCountryCode = px.country_code ?? null;
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

  const geo = geoIdentityFor(pxCountryCode);
  const locale = hwEarly.locale || geo.locale;
  const mccMnc = hwEarly.mccMnc || geo.mccMnc;
  const operatorAlpha = geo.operatorAlpha;
  const timezone = profile.timezone || pxTimezone || geo.timezone;

  return {
    profileId,
    name: profile.name ?? null,
    fingerprint,
    screen,
    densityDpi,
    cores,
    ramMb,
    heapMb,
    proxy,
    timezone,
    geolocation,
    locale,
    mccMnc,
    operatorAlpha,
    blockNetwork: hwEarly.blockNetwork,
    identityEpoch: hwEarly.identityEpoch ?? 0,
    seed,
  };
}

/** Per-profile Android hw overrides, interfaces §A. All optional, all validated at use. */
export interface AndroidHwConfig {
  presetId?: string;
  /** Explicit locale / MCC-MNC pins; absent = derived from the proxy country. */
  locale?: string;
  mccMnc?: string;
  /** Opt into the fail-closed no-egress sandbox for proxy-less profiles. */
  blockNetwork?: boolean;
  /** Rotation counter; bump to re-derive android_id/imei/serial/mac. */
  identityEpoch?: number;
  seed?: number;
  screenW?: number;
  screenH?: number;
  densityDpi?: number;
  cores?: number;
  ramMb?: number;
  heapMb?: number;
}

/** Parses profiles.android_config; invalid JSON yields {} (fallbacks apply, never throws). */
export function parseAndroidHwConfig(raw: string | null): AndroidHwConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;
    return {
      presetId: str(parsed.presetId),
      seed: num(parsed.seed),
      screenW: num(parsed.screenW),
      screenH: num(parsed.screenH),
      densityDpi: num(parsed.densityDpi),
      cores: num(parsed.cores),
      ramMb: num(parsed.ramMb),
      heapMb: num(parsed.heapMb),
      locale: str(parsed.locale),
      mccMnc: str(parsed.mccMnc),
      blockNetwork: parsed.blockNetwork === true ? true : undefined,
      identityEpoch: num(parsed.identityEpoch),
    };
  } catch {
    return {};
  }
}
