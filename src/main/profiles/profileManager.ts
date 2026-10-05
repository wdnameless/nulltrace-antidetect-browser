import { randomUUID, randomInt } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getDb } from '../db';
import { PROFILES_DIR } from '../config';
import { logger } from '../util/logger';
import { getEnabledExtensionPaths } from '../extensions/extensionManager';
import { pickMobilePreset, buildMobileUa, getMobilePreset, type MobilePreset } from '../devices/mobilePresets';
import { protectSecret, revealSecret } from '../util/secretStore';
import { deleteEntriesForProfile } from '../vault/accountVault';
import { removeBindingsForProfile, tagsForProfile, createTag, attachTag } from '../tags/tagManager';
import { deriveHardwareVector, migrateLegacySeed, selectFamilyBySeed } from '../fingerprints/derivation';
import { EXTENDED_FINGERPRINT_CATALOG } from '../fingerprints/catalog';
import { queueGeoChecks, findProxyByEndpoint } from '../proxy/proxyManager';

export type ProxyType = 'http' | 'https' | 'socks5' | 'ssh';

export interface ProxyInput {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
}

export type BrowserType = 'chromium' | 'firefox' | 'android';

export interface CreateProfileInput {
  name?: string;
  group_id?: string;
  proxy_id?: string;
  proxy?: ProxyInput;
  device_id?: string;
  fingerprint_seed?: number;
  user_agent?: string;
  timezone?: string;
  browser_type?: BrowserType;
  geolocation?: string;
  start_urls?: string[];
  /** Explicit mobile model from the pool (fixed "phone" for long-lived accounts). */
  mobile_model_id?: string;
  /** Extra Chromium switches appended LAST (after all launcher defaults). */
  launch_args?: string[];
  /** Profile badge color (3/6-digit hex; null clears). */
  color?: string | null;
  /** Free-form per-profile operator note. */
  notes?: string;
  /**
   * Do Not Track: `'off'` sends nothing, `'on'` sends DNT: 1. A string rather than a
   * boolean because the form also offers `'auto'`, which means "let the fingerprint
   * decide" and is materially different from an explicit "off".
   */
  do_not_track?: 'off' | 'on' | 'auto' | null;
  /** Ports to block from the page (e.g. 3389, 5900). Empty clears. */
  blocked_ports?: number[];
  /** WebRTC IP handling policy; null uses Chromium's default. */
  webrtc_policy?: 'default' | 'disable_non_proxied_udp' | 'proxy' | null;
  /**
   * Launch without a window (`--headless=new`). Agent/automation profiles want this; a
   * profile an operator drives by hand does not. Persisted per profile so a script that
   * starts the same profile twice gets the same display mode both times.
   */
  headless?: boolean;
}

export interface ProfileRow {
  id: string;
  name: string | null;
  group_id: string | null;
  proxy_id: string | null;
  fingerprint_id: string | null;
  device_id: string | null;
  browser_type: string | null;
  user_agent: string | null;
  timezone: string | null;
  geolocation: string | null;
  mobile_model_id: string | null;
  start_urls: string | null;
  cookies_json: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  /** Trash (Sprint 2.4): NULL = live, timestamp = moved to trash. */
  deleted_at: number | null;
  /** Extra per-profile Chromium switches (JSON array; appended last at launch). */
  launch_args: string | null;
  /** Profile badge color (canonical 6-digit hex or null). */
  color: string | null;
  /** Free-form per-profile operator note (null when unset). */
  notes: string | null;
  /** Do Not Track mode (`off` | `on` | `auto`); null = not set. */
  do_not_track: string | null;
  /** Ports to block, stored as a JSON array string. */
  blocked_ports: string | null;
  /** WebRTC IP handling policy; null = Chromium default. */
  webrtc_policy: string | null;
  /** Headless launch flag: 1 = `--headless=new`, 0/NULL = headed. */
  headless: number | null;
}

export interface ProxyRow {
  id: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  private_key: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2 ("DE"); `country` holds the display name ("Germany"). */
  country_code: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
}

export interface FingerprintLaunch {
  seed: number;
  platform: string;
  platformVersion?: string;
  brand: string;
  brandVersion?: string;
  hardwareConcurrency?: number;
  timezone?: string;
  lang?: string;
  disableSpoofing?: string;
}

export interface DeviceEmulationConfig {
  mobile: boolean;
  ua?: string;
  screen?: { width: number; height: number; deviceScaleFactor?: number };
  touch?: boolean;
  maxTouchPoints?: number;
}

export interface StealthConfig {
  mobile: boolean;
  logicalPlatform: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  ua?: string;
  model?: string;
  platformVersion?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
  seed?: number;
  locale?: string;
  canvasNoise?: boolean;
  audioNoise?: boolean;
  rectsNoise?: boolean;
  webglNoise?: boolean;
  webglVendor?: string;
  webglRenderer?: string;
  fontList?: string[];
  /**
   * Surfaces the kernel already spoofs natively for this launch, so the JavaScript layer stands
   * down on them instead of overwriting the engine on the main thread only. See
   * `StealthOptions.engineCovers` for the measurements that motivated it.
   */
  engineCovers?: { canvas?: boolean; deviceMemory?: boolean; clientHints?: boolean; webgl?: boolean };
}

export interface SshTunnelConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
}

export interface LaunchConfig {
  profileId: string;
  userDataDir: string;
  browserType?: 'chromium' | 'firefox';
  proxyServer?: string;
  proxyAuth?: { username: string; password: string };
  sshTunnel?: SshTunnelConfig;
  proxyTimezone?: string;
  fingerprintSeed: number;
  fingerprint?: FingerprintLaunch;
  deviceEmulation?: DeviceEmulationConfig;
  stealth?: StealthConfig;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  cookies?: Array<Record<string, unknown>>;
  extensionPaths?: string[];
  startUrls?: string[];
  userAgent?: string;
  timezone?: string;
  /** Desktop screen resolution override (AdsPower-style), from fingerprint config. */
  screenOverride?: { width: number; height: number };
  headless?: boolean;
  temporary?: boolean;
  /** Extra per-profile Chromium switches (appended last). */
  launch_args?: string[];
  /** Window badge color (parity program: profile-window-badge). */
  color?: string | null;
  /** Profile display name (badge prefix source). */
  profileName?: string | null;
  /** Set when a stealth-engine build is selected: id passed as --stealth-engine-profile. */
  stealthEngineProfileId?: string;
  /** Do Not Track mode (`off` | `on` | `auto`); null/absent leaves Chromium's default. */
  do_not_track?: string | null;
  /** Ports to block from the page. */
  blocked_ports?: number[];
  /** WebRTC IP handling policy. */
  webrtc_policy?: string | null;
  /** Skip synthetic TCP/HTTP pre-connect transport probe when launching (operator forced launch). */
  bypassProxyProbe?: boolean;
}
export * from './temporaryRegistry';

export interface ProfileListItem {
  user_id: string;
  name: string | null;
  status: string;
  group_id: string | null;
  browser_type?: string;
  /** Bound proxy id, so a row can be matched to a geo result that arrives after it rendered. */
  proxy_id?: string | null;
  proxy_type?: string | null;
  proxy_host?: string | null;
  proxy_port?: number | null;
  proxy_country?: string | null;
  /** ISO code for the flag and the short label; `proxy_country` is the display name. */
  proxy_country_code?: string | null;
  proxy_city?: string | null;
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
   * The fixed Android phone model, or null for "Auto (from seed)".
   *
   * It MUST be part of this payload: the Edit modal reads it back into its select and then sends
   * `mobile_model_id: mobileModelId || null` on save. Omitting it here made the field read as
   * `undefined` → the select showed "Auto" → saving ANY unrelated edit (a rename) wrote null over
   * a model the operator had deliberately pinned. Verified: a profile created with `pixel-7` came
   * back null after a rename.
   */
  mobile_model_id: string | null;
  launch_args: string[];
  color: string | null;
  notes: string | null;
  do_not_track: string | null;
  blocked_ports: number[];
  webrtc_policy: string | null;
  /** Display mode: true when the profile launches without a window. NULL/0 means headed. */
  headless: boolean;
  proxy?: {
    id: string;
    type: ProxyType;
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

// ---------------------------------------------------------------------------
// Profile window badge (parity program: profile-window-badge)
// ---------------------------------------------------------------------------

/** Canonicalizes a user color to 6-digit lowercase hex; null when invalid. */
export function normalizeProfileColor(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let hex = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) {
    hex = hex.split('').map((c) => c + c).join('');
  }
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null;
}

/** First two alphanumeric characters uppercased; 'P' fallback. */
export function deriveBadgeInitials(name: string | null | undefined): string {
  const alnum = (name ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  if (alnum.length === 0) return 'P';
  return alnum.slice(0, 2).toUpperCase();
}

/**
 * Do Not Track mode, or null when unset.
 *
 * Rejects anything outside the three known modes rather than coercing: a typo silently
 * becoming "off" would tell the operator they configured privacy they did not.
 */
export function normalizeDoNotTrack(input: string | null | undefined): string | null {
  if (input === 'off' || input === 'on' || input === 'auto') return input;
  if (input === null || input === undefined) return null;
  throw new Error(`invalid do-not-track mode: '${String(input)}'`);
}

/**
 * Normalizes a free-form profile note: trims leading/trailing whitespace,
 * mapping empty/whitespace-only input to null.
 */
export function normalizeProfileNotes(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Ports to block, deduplicated and sorted, or [] when unset.
 *
 * Validates the 1..65535 range: a stray 0 or a value above 65535 cannot be expressed as a
 * port, so accepting it would produce a Chromium switch that silently does nothing.
 */
export function normalizeBlockedPorts(input: number[] | null | undefined): number[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('blocked_ports must be an array of numbers');
  const seen = new Set<number>();
  for (const raw of input) {
    const port = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port: '${String(raw)}' (expected an integer 1-65535)`);
    }
    seen.add(port);
  }
  return [...seen].sort((a, b) => a - b);
}

/** WebRTC IP handling policy, or null for Chromium's default. */
export function normalizeWebrtcPolicy(input: string | null | undefined): string | null {
  if (input === 'default' || input === 'disable_non_proxied_udp' || input === 'proxy') return input;
  if (input === null || input === undefined) return null;
  throw new Error(`invalid WebRTC policy: '${String(input)}'`);
}

/** Parses the stored JSON port array back into numbers; tolerant of legacy NULL junk. */
export function parseBlockedPortsColumn(raw: string | null | undefined): number[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is number => typeof p === 'number' && Number.isInteger(p));
  } catch {
    return [];
  }
}

/**
 * Parses the stored JSON start-URL array back into strings.
 *
 * Same contract as `parseBlockedPortsColumn`: a legacy or hand-edited value degrades to an empty
 * list instead of throwing, because this is read while copying a profile and a corrupt column must
 * not make the copy impossible. Non-string entries are dropped rather than cast — the array is fed
 * straight back into `createProfile`, which would otherwise persist junk of a type it does not
 * declare.
 */
export function parseStartUrlsColumn(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
  } catch {
    return [];
  }
}

/** '[XX] ' prefix for the launched window title; '' without a color. */
export function formatBadgeTitlePrefix(color: string | null | undefined, name: string | null | undefined): string {
  if (!color) return '';
  return `[${deriveBadgeInitials(name)}] `;
}

// ---------------------------------------------------------------------------
// Extra launch args (parity program: extra-launch-args)
// ---------------------------------------------------------------------------

/** Switch prefixes that would break stealth or isolation invariants. */
export const DENIED_LAUNCH_ARGS = [
  '--fingerprint',
  '--remote-debugging',
  '--user-data-dir',
  '--proxy-server',
  '--load-extension',
  '--disable-extensions',
  // Display mode is owned by the `headless` column, which has a first-class API field and
  // reaches the kernel. As a launch_arg it was doubly wrong: these args are appended LAST
  // (Chromium is last-wins), so `--headless=new` silently overrode the column and a profile
  // the operator pressed Play on opened no window at all — while the API returned success and
  // the status row read "running".
  '--headless',
] as const;

/** The denied token a switch hits, or null when the launcher does not own it. */
function deniedLaunchArgToken(arg: string): string | null {
  for (const denied of DENIED_LAUNCH_ARGS) {
    if (arg.startsWith(denied)) return denied;
  }
  return null;
}

/**
 * Validates the per-profile extra launch args at SAVE time: any denied prefix
 * throws, naming the denied token. Benign switches pass verbatim.
 */
export function validateLaunchArgs(args: string[] | null | undefined): string[] {
  const list = args ?? [];
  for (const arg of list) {
    const denied = deniedLaunchArgToken(arg);
    if (denied) {
      throw new Error(`launch_args: denied token '${denied}' in '${arg}'`);
    }
  }
  return [...list];
}

/**
 * Appends the user's profile args LAST: Chromium's last-wins rule lets them
 * override launcher defaults without a merge protocol.
 */
export function appendProfileArgs(
  base: string[],
  extra: string[] | null | undefined
): string[] {
  if (!extra || extra.length === 0) return [...base];
  return [...base, ...extra];
}

/**
 * Reads the `launch_args` column and drops any switch the launcher itself owns.
 *
 * Rows written before the display-mode tokens joined the denylist still carry them, and a row
 * could also be edited outside the API. Saving is validated, reading is forgiving: a denied
 * token is ignored rather than thrown, so one stale row cannot make a profile unlaunchable.
 * This is the single parse point, so both the detail view and `resolveLaunchConfig` agree on
 * what the profile actually launches with.
 */
function parseLaunchArgsColumn(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string')
      .filter((arg) => deniedLaunchArgToken(arg) === null);
  } catch {
    return [];
  }
}

/**
 * Parse a stored `fingerprints.config_json` into an object.
 *
 * A malformed blob yields `{}` rather than throwing: this is read on the launch path, and a
 * browser that refuses to start over a corrupt config is worse than one that falls back to
 * derived defaults. Extracted because three writers read this column and each had its own
 * copy of the try/catch.
 */
function parseFingerprintConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to an empty config
  }
  return {};
}

/**
 * The coherent fingerprint config for a seed.
 *
 * Family, locale and every hardware field derive from the ONE seed, which is what keeps a
 * profile's declared GPU and screen consistent with the CPU and RAM it reports — the coherence
 * check that gates a launch compares exactly these. Three code paths needed this (create, rotate,
 * randomize) and two of them had grown their own partial version; the partial one is how
 * "randomize" ended up writing a seed whose family disagreed with the config beside it.
 */
function buildFingerprintConfig(seed: number, base: Record<string, unknown> = {}): Record<string, unknown> {
  const family = selectFamilyBySeed(seed, EXTENDED_FINGERPRINT_CATALOG);
  const hwVector = deriveHardwareVector(seed, EXTENDED_FINGERPRINT_CATALOG);
  const locale = family.localePool[(seed >>> 0) % family.localePool.length] ?? 'en-US';
  return {
    ...base,
    platform: family.coherenceConstraints.platform,
    brand: 'Chrome',
    family: family.id,
    hardwareConcurrency: hwVector.cpuCores,
    deviceMemory: hwVector.ramGB,
    lang: locale,
    gpu: family.gpu,
    screen: family.screen,
  };
}

export function createProfile(input: CreateProfileInput): string {
  const db = getDb();
  const now = Date.now();
  const profileId = 'p_' + randomUUID();

  let proxyId: string | null = null;
  if (input.proxy_id) {
    proxyId = input.proxy_id;
  } else if (input.proxy) {
    proxyId = 'x_' + randomUUID();
    db.prepare(
      `INSERT INTO proxies (id, type, host, port, username, password, private_key, country, timezone, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      proxyId,
      input.proxy.type,
      input.proxy.host,
      input.proxy.port,
      input.proxy.username ?? null,
      protectSecret(input.proxy.password),
      protectSecret(input.proxy.privateKey),
      null,
      null,
      'unknown',
      now
    );
  }

  // Queued for EVERY door that ends with a proxy bound, not just the inline one. A proxy chosen
  // from the saved list arrives as `proxy_id` and nobody had asked where it exits, so a profile the
  // operator had just created with a working proxy read "Not checked yet" indefinitely — the
  // reported defect, and the one path the earlier sweep left open. Reached by the SDKs, agents,
  // batch create and imports too, none of which run the Proxies page's own check. Queued rather
  // than awaited so a 142-line import cannot open 142 concurrent lookups, and queued AFTER the
  // insert so the worker always finds the row. Idempotent, and free for a row already resolved.
  if (proxyId) queueGeoChecks([proxyId]);

  const seed = typeof input.fingerprint_seed === 'number' && input.fingerprint_seed > 0
    ? input.fingerprint_seed
    : randomInt(1, 2147483647);
  const fpId = 'fp_' + randomUUID();

  // Coherent archetype sampling (catalog task 3.1): family is chosen
  // weighted-by-market-share from the full catalog by the profile seed, and
  // every hardware field derives from the same family + seed vector.
  const defaultFpConfig = JSON.stringify(buildFingerprintConfig(seed));
  db.prepare(
    'INSERT INTO fingerprints (id, label, seed, config_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(fpId, 'default', seed, defaultFpConfig, now);

  const validatedArgs = validateLaunchArgs(input.launch_args);
  const badgeColor = input.color !== undefined && input.color !== null
    ? normalizeProfileColor(input.color)
    : null;
  if (input.color !== undefined && input.color !== null && !badgeColor) {
    throw new Error(`invalid profile color: '${input.color}'`);
  }
  const notes = normalizeProfileNotes(input.notes);
  const dnt = normalizeDoNotTrack(input.do_not_track);
  const ports = normalizeBlockedPorts(input.blocked_ports);
  const webrtc = normalizeWebrtcPolicy(input.webrtc_policy);
  // Headless is stored as 1/0 rather than a JSON boolean: the column is INTEGER and an
  // existing database gets it through `ensureColumn`, so NULL has to keep meaning headed.
  const headless = input.headless ? 1 : 0;
  db.prepare(
    `INSERT INTO profiles (
       id, name, group_id, proxy_id, fingerprint_id, device_id,
       browser_type, user_agent, timezone, geolocation, start_urls, mobile_model_id, launch_args, color, notes,
       do_not_track, blocked_ports, webrtc_policy, headless, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?)`
  ).run(
    profileId,
    input.name ?? null,
    input.group_id ?? null,
    proxyId,
    fpId,
    input.device_id ?? null,
    input.browser_type ?? 'chromium',
    input.user_agent ?? null,
    input.timezone ?? null,
    input.geolocation ?? null,
    input.start_urls && input.start_urls.length ? JSON.stringify(input.start_urls) : null,
    input.mobile_model_id ?? null,
    validatedArgs.length ? JSON.stringify(validatedArgs) : null,
    badgeColor,
    notes,
    dnt,
    ports.length ? JSON.stringify(ports) : null,
    webrtc,
    headless,
    now,
    now
  );

  return profileId;
}

export function batchCreateProfiles(input: {
  count: number;
  namePrefix?: string;
  proxyIds?: string[];
  deviceId?: string;
}): string[] {
  const prefix = input.namePrefix || 'profile';
  const proxyList = input.proxyIds && input.proxyIds.length ? input.proxyIds : [];
  const ids: string[] = [];

  for (let i = 1; i <= input.count; i++) {
    const name = `${prefix}-${String(i).padStart(3, '0')}`;
    const proxyId = proxyList.length > 0 ? proxyList[(i - 1) % proxyList.length] : undefined;
    const id = createProfile({
      name,
      proxy_id: proxyId,
      device_id: input.deviceId,
    });
    ids.push(id);
  }
  return ids;
}

export function updateProfileFingerprint(userId: string, config: Record<string, unknown>): boolean {
  const db = getDb();
  const profile = getProfile(userId);
  if (!profile || !profile.fingerprint_id) return false;
  const fp = db
    .prepare('SELECT config_json FROM fingerprints WHERE id = ?')
    .get(profile.fingerprint_id) as { config_json: string } | undefined;
  if (!fp) return false;
  const cfg = parseFingerprintConfig(fp.config_json);
  const merged = { ...cfg, ...config };
  db.prepare('UPDATE fingerprints SET config_json = ? WHERE id = ?').run(
    JSON.stringify(merged),
    profile.fingerprint_id
  );
  return true;
}

export interface FingerprintRotationItemResult {
  user_id: string;
  ok: boolean;
  error?: 'running' | 'coherence' | 'not_found';
  issues?: string[];
  seed?: number;
  family?: string;
}

export interface FingerprintPatch {
  timezone?: string;
  languages?: string[];
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

/** Injectable launcher liveness check (avoids a launcher import cycle; tests stub it). */
let isProfileRunning: (profileId: string) => boolean = () => false;

export function setRunningChecker(fn: (profileId: string) => boolean): void {
  isProfileRunning = fn ?? (() => false);
}

/**
 * Bulk fingerprint maintenance (parity program: bulk-fingerprint-rotation).
 * - mode 'rotate': draw a new weighted-coherent family from the catalog and
 *   rebuild the fingerprint config from family + fresh seed (replayable with
 *   seedHint: same (profileId, seedHint) pair yields the same result).
 * - mode 'patch': apply targeted field changes over the existing config; the
 *   result must stay coherent with the profile's declared family (when set),
 *   otherwise the item is rejected and nothing is persisted.
 * Running profiles fail closed: skipped with error 'running', never mutated.
 * Each item persists independently; one failure never aborts the batch.
 */
export function rotateFingerprints(
  userIds: string[],
  mode: 'rotate' | 'patch',
  patch?: FingerprintPatch,
  seedHint?: number
): FingerprintRotationItemResult[] {
  const results: FingerprintRotationItemResult[] = [];
  for (const userId of userIds) {
    const profile = getProfile(userId);
    if (!profile || !profile.fingerprint_id) {
      results.push({ user_id: userId, ok: false, error: 'not_found' });
      continue;
    }
    if (isProfileRunning(userId)) {
      results.push({ user_id: userId, ok: false, error: 'running' });
      continue;
    }

    const db = getDb();
    const fp = db
      .prepare('SELECT seed, config_json FROM fingerprints WHERE id = ?')
      .get(profile.fingerprint_id) as { seed: number; config_json: string } | undefined;
    if (!fp) {
      results.push({ user_id: userId, ok: false, error: 'not_found' });
      continue;
    }
    const cfg = parseFingerprintConfig(fp.config_json);

    if (mode === 'rotate') {
      // Deterministic replay: seedHint + profile id hash drives the new draw.
      const base = seedHint !== undefined ? Math.abs(seedHint) : randomInt(1, 2147483647);
      const seed = ((base ^ fnv1a(userId)) % 2147483646) + 1;
      const family = selectFamilyBySeed(seed, EXTENDED_FINGERPRINT_CATALOG);
      const newCfg = buildFingerprintConfig(seed);
      db.prepare('UPDATE fingerprints SET seed = ?, config_json = ? WHERE id = ?').run(
        seed,
        JSON.stringify(newCfg),
        profile.fingerprint_id
      );
      results.push({ user_id: userId, ok: true, seed, family: family.id });
    } else {
      const merged = { ...cfg, ...(patch ?? {}) };
      // Coherence gate: when the config declares a family, the patched fields
      // must stay valid for that family (RAM/CPU within its allowed sets).
      const familyId = typeof cfg.family === 'string' ? cfg.family : undefined;
      const family = familyId
        ? EXTENDED_FINGERPRINT_CATALOG.find((f) => f.id === familyId)
        : undefined;
      const issues: string[] = [];
      if (family) {
        const memory = typeof merged.deviceMemory === 'number' ? merged.deviceMemory : undefined;
        const cores =
          typeof merged.hardwareConcurrency === 'number' ? merged.hardwareConcurrency : undefined;
        if (memory !== undefined && !family.ramGB.includes(memory)) {
          issues.push(`deviceMemory ${memory}GB not in family ${family.id} allowed set [${family.ramGB.join(', ')}]`);
        }
        if (
          cores !== undefined &&
          (cores < family.cpu.coresMin || cores > family.cpu.coresMax)
        ) {
          issues.push(
            `hardwareConcurrency ${cores} outside family ${family.id} range [${family.cpu.coresMin}-${family.cpu.coresMax}]`
          );
        }
      }
      if (issues.length > 0) {
        results.push({ user_id: userId, ok: false, error: 'coherence', issues });
        continue;
      }
      db.prepare('UPDATE fingerprints SET config_json = ? WHERE id = ?').run(
        JSON.stringify(merged),
        profile.fingerprint_id
      );
      results.push({ user_id: userId, ok: true });
    }
  }
  return results;
}

/** FNV-1a string hash into a positive int32 (deterministic per profile id). */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}


/**
 * Copy a profile.
 *
 * Every operator-set field travels, because a clone that silently drops settings is worse than no
 * clone: the copy looks right in the list and then behaves differently at launch. Previously only
 * nine of nineteen fields were carried, so a duplicate reverted to a headed window and lost its
 * note, colour, start pages, launch arguments, blocked ports, WebRTC policy and Do-Not-Track —
 * measured, not inferred.
 *
 * `notes` deliberately does NOT travel: a note describes that specific profile's history ("banned
 * on FB", "warmup done"), and copying it onto a fresh profile states something untrue about the
 * new one. Everything else is configuration the operator chose for the profile as a shape, which
 * is exactly what duplicating means.
 */
export function duplicateProfile(userId: string, newName?: string): string | null {
  const source = getLiveProfile(userId);
  if (!source) return null;

  const targetName = newName?.trim() || (source.name ? `${source.name} (Copy)` : 'Profile (Copy)');

  const newId = createProfile({
    name: targetName,
    group_id: source.group_id || undefined,
    proxy_id: source.proxy_id || undefined,
    device_id: source.device_id || undefined,
    browser_type: (source.browser_type as BrowserType) || 'chromium',
    user_agent: source.user_agent || undefined,
    timezone: source.timezone || undefined,
    geolocation: source.geolocation || undefined,
    mobile_model_id: source.mobile_model_id || undefined,
    // --- fields the clone used to drop ---
    start_urls: parseStartUrlsColumn(source.start_urls),
    launch_args: parseLaunchArgsColumn(source.launch_args),
    color: source.color ?? null,
    do_not_track: (source.do_not_track as 'off' | 'on' | 'auto' | null) ?? null,
    blocked_ports: parseBlockedPortsColumn(source.blocked_ports),
    webrtc_policy: (source.webrtc_policy as 'default' | 'disable_non_proxied_udp' | 'proxy' | null) ?? null,
    // 1/0/NULL on disk; `createProfile` expects a real boolean.
    headless: source.headless === 1,
  });

  /*
   * Carry the operator's fingerprint settings across.
   *
   * `createProfile` derives a fresh coherent fingerprint from the seed it is given, which is right
   * for a new profile and wrong for a copy: everything the operator had changed by hand lives in
   * `fingerprints.config_json`, and the derived config replaces it wholesale. Measured: a source
   * with an explicit `de-DE` and a per-surface noise choice produced a clone reporting `id-ID`
   * with no noise settings at all — same defect as the other dropped fields, one level deeper.
   *
   * This mirrors what `importProfileBundle` does for the same reason. The SEED is copied too, so the
   * clone shares the source's hardware vector rather than only its overrides — a clone that reports
   * the source's GPU but a different CPU would be incoherent, which is the failure mode
   * `buildFingerprintConfig` exists to prevent.
   */
  const db = getDb();
  if (source.fingerprint_id) {
    const src = db
      .prepare('SELECT seed, config_json FROM fingerprints WHERE id = ?')
      .get(source.fingerprint_id) as { seed: number; config_json: string } | undefined;
    const dst = db.prepare('SELECT fingerprint_id FROM profiles WHERE id = ?').get(newId) as
      | { fingerprint_id: string }
      | undefined;
    if (src && dst?.fingerprint_id) {
      db.prepare('UPDATE fingerprints SET seed = ?, config_json = ? WHERE id = ?').run(
        src.seed,
        src.config_json,
        dst.fingerprint_id
      );
    }
  }

  return newId;
}

export function getProfile(id: string): ProfileRow | undefined {
  return getDb()
    .prepare('SELECT * FROM profiles WHERE id = ?')
    .get(id) as ProfileRow | undefined;
}

/** Live (non-trashed) profile lookup â€” used by launch/duplicate/detail paths. */
export function getLiveProfile(id: string): ProfileRow | undefined {
  const p = getProfile(id);
  return p && p.deleted_at == null ? p : undefined;
}

export function getProfileDetails(id: string): ProfileDetails | null {
  const db = getDb();
  const p = getLiveProfile(id);
  if (!p) return null;

  let proxy: ProfileDetails['proxy'] = null;
  if (p.proxy_id) {
    const px = db.prepare('SELECT * FROM proxies WHERE id = ?').get(p.proxy_id) as ProxyRow | undefined;
    if (px) {
      proxy = {
        id: px.id,
        type: px.type,
        host: px.host,
        port: px.port,
        username: px.username,
        country: px.country,
        country_code: px.country_code,
        timezone: px.timezone,
        status: px.status,
      };
    }
  }

  let fingerprint: ProfileDetails['fingerprint'] = null;
  if (p.fingerprint_id) {
    const fp = db.prepare('SELECT seed, config_json FROM fingerprints WHERE id = ?').get(p.fingerprint_id) as { seed: number; config_json: string } | undefined;
    if (fp) {
      const cfg = parseFingerprintConfig(fp.config_json);
      fingerprint = {
        seed: fp.seed,
        platform: typeof cfg.platform === 'string' ? cfg.platform : 'windows',
        hardwareConcurrency: typeof cfg.hardwareConcurrency === 'number' ? cfg.hardwareConcurrency : 8,
        brand: typeof cfg.brand === 'string' ? cfg.brand : 'Chrome',
        config: cfg,
      };
    }
  }

  let device: ProfileDetails['device'] = null;
  if (p.device_id) {
    const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(p.device_id) as { id: string; name: string; platform: string; config_json: string } | undefined;
    if (dev) {
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(dev.config_json || '{}'); } catch { /* ignore */ }
      device = {
        id: dev.id,
        name: dev.name,
        platform: dev.platform,
        config: cfg,
      };
    }
  }

  return {
    user_id: p.id,
    name: p.name,
    status: p.status,
    group_id: p.group_id,
    device_id: p.device_id,
    browser_type: p.browser_type || 'chromium',
    user_agent: p.user_agent,
    timezone: p.timezone,
    // Sent so the Edit modal can show the pinned model instead of reading `undefined` and
    // writing null back over it. See the field's note on `ProfileDetails`.
    mobile_model_id: p.mobile_model_id ?? null,
    // One shared mapper for the operator-set columns; see `operatorConfigColumns`.
    ...operatorConfigColumns(p),
    proxy,
    fingerprint,
    device,
  };
}

export function deleteProfile(id: string): boolean {
  // Trash (Sprint 2.4): soft delete â€” keep everything (fingerprint, bindings,
  // credentials, user-data on disk) so the profile can be restored.
  const db = getDb();
  const p = getProfile(id);
  if (!p) return false;
  const res = db
    .prepare('UPDATE profiles SET deleted_at = ?, status = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(Date.now(), 'closed', Date.now(), id);
  return res.changes > 0;
}

// ---------------------------------------------------------------------------
// Trash (Sprint 2.4): soft-deleted profiles lifecycle.
// ---------------------------------------------------------------------------

export interface TrashItem {
  id: string;
  name: string | null;
  group_name: string | null;
  deleted_at: number;
  created_at: number;
}

export function listTrash(): TrashItem[] {
  const db = getDb();
  // SAFETY: the projection above selects exactly the fields `TrashItem` declares, in the same
  // names. sql.js returns untyped rows, so the assertion is what records that correspondence —
  // it is sound precisely while the SELECT list and the interface stay in sync, and the
  // `deleted_at` filter guarantees the non-null type the interface claims.
  return db
    .prepare(
      `SELECT p.id, p.name, g.name AS group_name, p.deleted_at, p.created_at
       FROM profiles p LEFT JOIN groups g ON g.id = p.group_id
       WHERE p.deleted_at IS NOT NULL
       ORDER BY p.deleted_at DESC`
    )
    .all() as unknown as TrashItem[];
}

export function restoreProfile(id: string): boolean {
  const db = getDb();
  // Drop a group reference that no longer resolves before restoring.
  //
  // `deleteGroup` now only detaches LIVE profiles, so a trashed profile keeps its `group_id` while
  // it is in the trash — and if that group is deleted in the meantime, restoring leaves a dangling
  // id. `listGroups` counts by join, so the row would appear in no group while the UI's
  // `getGroupName` rendered the bare word "Unknown". Clearing it makes restore land the profile in
  // "Ungrouped", which is a state the operator can actually act on.
  db.prepare(
    `UPDATE profiles
        SET group_id = NULL
      WHERE id = ?
        AND group_id IS NOT NULL
        AND group_id NOT IN (SELECT id FROM groups)`
  ).run(id);

  const res = db
    .prepare('UPDATE profiles SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
    .run(Date.now(), id);
  return res.changes > 0;
}

/** Hard delete: remove the row, fingerprint, bindings, credentials, user-data. */
export function purgeProfile(id: string): boolean {
  const db = getDb();
  const p = getProfile(id);
  if (!p) return false;
  if (p.fingerprint_id) {
    db.prepare('DELETE FROM fingerprints WHERE id = ?').run(p.fingerprint_id);
  }
  db.prepare('DELETE FROM profile_extensions WHERE profile_id = ?').run(id);
  deleteEntriesForProfile(id);
  removeBindingsForProfile(id);
  const res = db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  if (res.changes > 0) {
    try {
      // User-data dir lives outside the DB; best-effort cleanup.
      fs.rmSync(path.join(PROFILES_DIR, id), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  return res.changes > 0;
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Startup sweep: permanently delete trash entries older than 30 days. */
export function purgeExpiredTrash(): number {
  const db = getDb();
  const rows = db
    .prepare('SELECT id FROM profiles WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .all(Date.now() - TRASH_RETENTION_MS) as Array<{ id: string }>;
  let purged = 0;
  for (const r of rows) {
    // Re-check immediately before deleting. The SELECT above and this loop are not atomic: a
    // `restoreProfile` for one of these rows can land in between, and deleting afterwards would
    // destroy the data of a profile the operator had just brought back. `purgeProfile` removes
    // the user-data directory, so that loss is not recoverable. The WHERE clause makes the
    // delete itself conditional on the row still being expired trash.
    const stillExpired = db
      .prepare('SELECT id FROM profiles WHERE id = ? AND deleted_at IS NOT NULL AND deleted_at < ?')
      .get(r.id, Date.now() - TRASH_RETENTION_MS) as { id: string } | undefined;
    if (!stillExpired) continue;
    if (purgeProfile(r.id)) purged++;
  }
  return purged;
}

export function setStatus(id: string, status: string): void {
  getDb()
    .prepare('UPDATE profiles SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id);
  notifyStatusChange(id, status);
}

// ---------------------------------------------------------------------------
// Status-change events (Sprint 4.3): script trigger hooks subscribe here.
// A tiny callback registry keeps profileManager decoupled from the trigger
// module (which imports runScript lazily via require inside the callback).
// ---------------------------------------------------------------------------

type StatusChangeCallback = (profileId: string, status: string) => void;
const statusChangeCallbacks: StatusChangeCallback[] = [];

export function onProfileStatusChange(cb: StatusChangeCallback): () => void {
  statusChangeCallbacks.push(cb);
  return () => {
    const idx = statusChangeCallbacks.indexOf(cb);
    if (idx !== -1) {
      statusChangeCallbacks.splice(idx, 1);
    }
  };
}

function notifyStatusChange(profileId: string, status: string): void {
  for (const cb of statusChangeCallbacks) {
    try {
      cb(profileId, status);
    } catch {
      // subscriber errors must never break profile lifecycle
    }
  }
}

/**
 * Crash recovery: profiles stuck in "running" from a previous session (the app
 * crashed or was killed without a graceful shutdown) are marked "closed".
 * Returns the number of recovered rows.
 */
export function recoverStaleRunning(): number {
  const res = getDb()
    .prepare("UPDATE profiles SET status = 'closed', updated_at = ? WHERE status = 'running'")
    .run(Date.now());
  return res.changes;
}

/**
 * Re-registers profile user-data directories that lost their database row —
 * e.g. after the metadata DB was quarantined/restored from an older backup.
 * A row is only created when the on-disk dir looks like a real profile
 * workspace (contains Chromium profile artifacts, not an empty stub).
 * Adopted profiles get a fresh fingerprint and default settings; cookies and
 * all browser-level state survive because they live in the directory itself.
 * Returns the number of adopted directories.
 */
export function adoptOrphanedProfileDirs(): number {
  const db = getDb();
  let adopted = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(PROFILES_DIR);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith('p_')) continue;
    const dir = path.join(PROFILES_DIR, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const exists = db.prepare('SELECT id FROM profiles WHERE id = ?').get(name);
    if (exists) continue;
    if (!hasBrowserWorkspaceArtifacts(dir)) continue;

    const now = Date.now();
    const fpId = 'fp_' + randomUUID();
    db.prepare(
      'INSERT INTO fingerprints (id, label, seed, config_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(fpId, 'recovered', randomInt(1, 2147483647), '{}', now);
    db.prepare(
      `INSERT INTO profiles (id, name, group_id, proxy_id, fingerprint_id, device_id,
         browser_type, user_agent, timezone, geolocation, start_urls, mobile_model_id, status,
         created_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, 'chromium', NULL, NULL, NULL, NULL, NULL, 'closed', ?, ?)`
    ).run(name, 'Recovered profile', fpId, now, now);
    adopted++;
  }
  if (adopted > 0) {
    logger.info('adopted orphaned profile directories', { adopted });
  }
  return adopted;
}

/**
 * A directory is a profile workspace when it holds real Chromium state —
 * not an empty/stub dir left behind by a failed launch.
 */
function hasBrowserWorkspaceArtifacts(profileDir: string): boolean {
  const markers = ['Default', 'Local State', 'Preferences', 'Cookies', 'History'];
  return markers.some((m) => fs.existsSync(path.join(profileDir, m)));
}

// ---------------------------------------------------------------------------
// Profile bundles (v0.2.19): portable export/import of a full profile â€”
// fingerprint, device, proxy (incl. credentials) and cookies â€” as one JSON.
// ---------------------------------------------------------------------------

export interface ProfileBundle {
  version: 1;
  exported_at: number;
  notes?: string | null;
  tags?: string[];
  group?: { id: string; name: string } | null;
  profile: {
    name: string | null;
    browser_type: string;
    user_agent: string | null;
    timezone: string | null;
    geolocation: string | null;
    start_urls: string[];
    mobile_model_id: string | null;
    /**
     * The rest of the operator's profile configuration.
     *
     * Optional because bundles exported by an older build do not carry them — a bundle is a file
     * that outlives the app version that wrote it, so adding required fields would make every
     * previously exported bundle unreadable. Import treats a missing value as "not set".
     *
     * These were absent entirely, so a profile moved between machines arrived headed, with no
     * note, colour, start pages, launch arguments, blocked ports, WebRTC policy or Do-Not-Track.
     */
    launch_args?: string[];
    color?: string | null;
    notes?: string | null;
    do_not_track?: string | null;
    blocked_ports?: number[];
    webrtc_policy?: string | null;
    headless?: boolean;
    tags?: string[];
    group?: { id: string; name: string } | null;
    fingerprint: { seed: number; config: Record<string, unknown> } | null;
    device: { device_id: string; name: string; platform: string; config: Record<string, unknown> } | null;
    proxy: {
      id?: string;
      type: string;
      host: string;
      port: number;
      username?: string;
      password?: string;
      private_key?: string;
    } | null;
    cookies: Array<Record<string, unknown>>;
  };
}

/**
 * The operator-set profile configuration, read from a row in the shape every caller needs.
 *
 * Extracted because the detail payload and the export bundle were building this same object
 * separately, and both had already dropped the same fields once. A copy of this mapping is how a
 * setting silently stops travelling: the clone dropped seven fields, the bundle dropped seven, and
 * each had to be found by measuring a round trip rather than by reading either builder.
 *
 * `headless` is normalised here for the same reason it was normalised inline before: the column is
 * 1/0/NULL on disk, and a checkbox handed the raw column treats NULL as unchecked only by accident.
 */
function operatorConfigColumns(row: ProfileRow): {
  launch_args: string[];
  color: string | null;
  notes: string | null;
  do_not_track: string | null;
  blocked_ports: number[];
  webrtc_policy: string | null;
  headless: boolean;
  start_urls: string[];
} {
  return {
    launch_args: parseLaunchArgsColumn(row.launch_args),
    color: row.color ?? null,
    notes: row.notes ?? null,
    do_not_track: row.do_not_track ?? null,
    blocked_ports: parseBlockedPortsColumn(row.blocked_ports),
    webrtc_policy: row.webrtc_policy ?? null,
    headless: row.headless === 1,
    start_urls: parseStartUrlsColumn(row.start_urls),
  };
}

export function exportProfileBundle(id: string): ProfileBundle | null {
  const p = getLiveProfile(id);
  if (!p) return null;
  const db = getDb();

  let fingerprint: ProfileBundle['profile']['fingerprint'] = null;
  if (p.fingerprint_id) {
    const fp = db
      .prepare('SELECT seed, config_json FROM fingerprints WHERE id = ?')
      .get(p.fingerprint_id) as { seed: number; config_json: string } | undefined;
    if (fp) {
      const config = parseFingerprintConfig(fp.config_json);
      fingerprint = { seed: fp.seed, config };
    }
  }

  let device: ProfileBundle['profile']['device'] = null;
  if (p.device_id) {
    const dev = db
      .prepare('SELECT id, name, platform, config_json FROM devices WHERE id = ?')
      .get(p.device_id) as { id: string; name: string; platform: string; config_json: string } | undefined;
    if (dev) {
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(dev.config_json || '{}'); } catch { /* ignore */ }
      device = { device_id: dev.id, name: dev.name, platform: dev.platform, config };
    }
  }

  let proxy: ProfileBundle['profile']['proxy'] = null;
  if (p.proxy_id) {
    const px = db.prepare('SELECT * FROM proxies WHERE id = ?').get(p.proxy_id) as ProxyRow | undefined;
    if (px) {
      proxy = {
        id: px.id,
        type: px.type,
        host: px.host,
        port: px.port,
        username: px.username || undefined,
        // bundles are explicit user exports — include the usable (decrypted) credentials
        password: revealSecret(px.password),
        private_key: revealSecret(px.private_key),
      };
    }
  }

  let group: { id: string; name: string } | null = null;
  if (p.group_id) {
    const g = db.prepare('SELECT id, name FROM groups WHERE id = ?').get(p.group_id) as
      | { id: string; name: string }
      | undefined;
    if (g) {
      group = { id: g.id, name: g.name };
    }
  }

  const notes = p.notes ?? null;
  const tags = tagsForProfile(p.id).map((t) => t.name);

  let cookies: Array<Record<string, unknown>> = [];
  if (p.cookies_json) {
    try {
      const parsed = JSON.parse(p.cookies_json);
      if (Array.isArray(parsed)) cookies = parsed;
    } catch { /* ignore */ }
  }

  return {
    version: 1,
    exported_at: Date.now(),
    notes,
    tags,
    group,
    profile: {
      name: p.name,
      browser_type: p.browser_type || 'chromium',
      user_agent: p.user_agent,
      timezone: p.timezone,
      geolocation: p.geolocation,
      mobile_model_id: p.mobile_model_id,
      // Carried so a profile moved between machines arrives as configured, not as a
      // default shell. One shared mapper, so this cannot drift from the detail payload.
      ...operatorConfigColumns(p),
      tags,
      group,
      fingerprint,
      device,
      proxy,
      cookies,
    },
  };
}

/**
 * Import a previously exported bundle as a NEW profile. The device preset is
 * re-linked by id when it exists on this machine (presets are seeded with
 * stable ids); otherwise the profile falls back to the default device.
 * Returns the new profile id.
 */
export function importProfileBundle(bundle: ProfileBundle, opts?: { exactName?: boolean }): string {
  if (!bundle || bundle.version !== 1 || !bundle.profile) {
    throw new Error('invalid bundle: expected { version: 1, profile }');
  }
  const db = getDb();
  const src = bundle.profile;

  // 1. Re-link device preset by id if it exists on this machine; fallback to default
  let deviceId: string | undefined;
  if (src.device?.device_id) {
    const dev = db.prepare('SELECT id FROM devices WHERE id = ?').get(src.device.device_id) as
      | { id: string }
      | undefined;
    deviceId = dev?.id;
  }

  // 2. Re-link group: look up by id, then name, or create the group so assignment survives
  let groupId: string | undefined;
  const groupRef = src.group ?? bundle.group;
  if (groupRef?.id) {
    const existingGroup = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupRef.id) as
      | { id: string }
      | undefined;
    if (existingGroup) {
      groupId = existingGroup.id;
    } else if (groupRef.name) {
      const byName = db.prepare('SELECT id FROM groups WHERE lower(name) = lower(?)').get(groupRef.name) as
        | { id: string }
        | undefined;
      if (byName) {
        groupId = byName.id;
      } else {
        try {
          db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(
            groupRef.id,
            groupRef.name,
            Date.now()
          );
          groupId = groupRef.id;
        } catch {
          // ignore constraint conflict
        }
      }
    }
  }

  // 3. Re-link proxy: match existing by id, or match by endpoint attributes, or restore proxy row
  let proxyId: string | undefined;
  let proxyInput: ProxyInput | undefined;
  if (src.proxy) {
    if (src.proxy.id) {
      const existingProxy = db.prepare('SELECT id FROM proxies WHERE id = ?').get(src.proxy.id) as
        | { id: string }
        | undefined;
      if (existingProxy) {
        proxyId = existingProxy.id;
      }
    }
    if (!proxyId) {
      proxyId =
        findProxyByEndpoint(
          src.proxy.host,
          src.proxy.port,
          src.proxy.type,
          src.proxy.username ?? null
        ) ?? undefined;
    }
    if (!proxyId) {
      if (src.proxy.id) {
        try {
          db.prepare(
            `INSERT INTO proxies (id, type, host, port, username, password, private_key, country, timezone, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            src.proxy.id,
            src.proxy.type,
            src.proxy.host,
            src.proxy.port,
            src.proxy.username ?? null,
            protectSecret(src.proxy.password),
            protectSecret(src.proxy.private_key),
            null,
            null,
            'unknown',
            Date.now()
          );
          proxyId = src.proxy.id;
        } catch {
          proxyInput = {
            type: src.proxy.type as ProxyType,
            host: src.proxy.host,
            port: src.proxy.port,
            username: src.proxy.username,
            password: src.proxy.password,
            privateKey: src.proxy.private_key,
          };
        }
      } else {
        proxyInput = {
          type: src.proxy.type as ProxyType,
          host: src.proxy.host,
          port: src.proxy.port,
          username: src.proxy.username,
          password: src.proxy.password,
          privateKey: src.proxy.private_key,
        };
      }
    }
  }

  const profileName = opts?.exactName
    ? (src.name ?? undefined)
    : (src.name ? `${src.name} (imported)` : undefined);

  const notesToRestore = src.notes ?? bundle.notes ?? undefined;

  const newId = createProfile({
    name: profileName,
    group_id: groupId,
    proxy_id: proxyId,
    proxy: proxyInput,
    browser_type: src.browser_type === 'android' ? 'android' : src.browser_type === 'firefox' ? 'firefox' : 'chromium',
    user_agent: src.user_agent || undefined,
    timezone: src.timezone || undefined,
    geolocation: src.geolocation || undefined,
    start_urls: src.start_urls?.length ? src.start_urls : undefined,
    mobile_model_id: src.mobile_model_id || undefined,
    // The rest of the configuration travels with the bundle. Each is optional because a bundle
    // written by an older build predates it, and an absent value means "not set" rather than
    // "explicitly cleared".
    launch_args: src.launch_args?.length ? src.launch_args : undefined,
    color: src.color ?? undefined,
    do_not_track: (src.do_not_track as 'off' | 'on' | 'auto' | null | undefined) ?? undefined,
    blocked_ports: src.blocked_ports?.length ? src.blocked_ports : undefined,
    webrtc_policy: (src.webrtc_policy as 'default' | 'disable_non_proxied_udp' | 'proxy' | null | undefined) ?? undefined,
    headless: src.headless === true,
    device_id: deviceId,
    fingerprint_seed: src.fingerprint?.seed,
    notes: notesToRestore ?? undefined,
  });

  // Restore the full fingerprint config (platform/brand/cores/lang/...).
  if (src.fingerprint?.config) {
    const row = db.prepare('SELECT fingerprint_id FROM profiles WHERE id = ?').get(newId) as
      | { fingerprint_id: string }
      | undefined;
    if (row?.fingerprint_id) {
      db.prepare('UPDATE fingerprints SET config_json = ? WHERE id = ?').run(
        JSON.stringify(src.fingerprint.config),
        row.fingerprint_id
      );
    }
  }

  // Restore cookies.
  if (src.cookies?.length) {
    db.prepare('UPDATE profiles SET cookies_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(src.cookies),
      Date.now(),
      newId
    );
  }

  // Restore tags via tagManager
  const tagsToRestore = src.tags ?? bundle.tags;
  if (Array.isArray(tagsToRestore) && tagsToRestore.length > 0) {
    for (const tagName of tagsToRestore) {
      if (typeof tagName !== 'string' || !tagName.trim()) continue;
      const cleanName = tagName.trim();
      const existingTag = db
        .prepare('SELECT id FROM tags WHERE lower(name) = lower(?)')
        .get(cleanName) as { id: string } | undefined;
      let tagId = existingTag?.id;
      if (!tagId) {
        const created = createTag(cleanName);
        if (created.ok) {
          tagId = created.data.id;
        }
      }
      if (tagId) {
        attachTag(tagId, [newId]);
      }
    }
  }

  return newId;
}

export function updateProfile(
  id: string,
  updates: {
    name?: string;
    browser_type?: BrowserType;
    group_id?: string | null;
    proxy_id?: string | null;
    proxy?: ProxyInput | null;
    device_id?: string | null;
    user_agent?: string | null;
    timezone?: string | null;
    start_urls?: string[] | null;
    mobile_model_id?: string | null;
    launch_args?: string[] | null;
    color?: string | null;
    notes?: string | null;
    do_not_track?: 'off' | 'on' | 'auto' | null;
    blocked_ports?: number[] | null;
    webrtc_policy?: 'default' | 'disable_non_proxied_udp' | 'proxy' | null;
    /** Launch without a window (`--headless=new`). */
    headless?: boolean;
  }
): boolean {
  const db = getDb();
  const profile = getProfile(id);
  if (!profile) return false;

  let effectiveProxyId: string | null | undefined = updates.proxy_id;
  if (updates.proxy) {
    effectiveProxyId = 'x_' + randomUUID();
    db.prepare(
      `INSERT INTO proxies (id, type, host, port, username, password, private_key, country, timezone, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      effectiveProxyId,
      updates.proxy.type,
      updates.proxy.host,
      updates.proxy.port,
      updates.proxy.username ?? null,
      protectSecret(updates.proxy.password),
      protectSecret(updates.proxy.privateKey),
      null,
      null,
      'unknown',
      Date.now()
    );
  } else if (updates.proxy === null) {
    effectiveProxyId = null;
  }

  // Same reason as `createProfile`, and the same gap: a proxy bound through the update path —
  // including one picked from the saved list, which arrives as `proxy_id` — was never checked.
  // `queueGeoChecks` is idempotent and skips a row that already carries its code, so repeating a
  // proxy the operator did not change cannot spend a second lookup.
  if (effectiveProxyId) queueGeoChecks([effectiveProxyId]);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.name !== undefined) {
    sets.push('name = ?');
    params.push(updates.name);
  }
  if (updates.group_id !== undefined) {
    sets.push('group_id = ?');
    params.push(updates.group_id);
  }
  if (updates.browser_type !== undefined) {
    sets.push('browser_type = ?');
    params.push(updates.browser_type);
  }
  if (effectiveProxyId !== undefined) {
    sets.push('proxy_id = ?');
    params.push(effectiveProxyId);
  }
  if (updates.device_id !== undefined) {
    sets.push('device_id = ?');
    params.push(updates.device_id);
  }
  if (updates.user_agent !== undefined) {
    sets.push('user_agent = ?');
    params.push(updates.user_agent);
  }
  if (updates.timezone !== undefined) {
    sets.push('timezone = ?');
    params.push(updates.timezone);
  }
  if (updates.start_urls !== undefined) {
    sets.push('start_urls = ?');
    params.push(updates.start_urls && updates.start_urls.length ? JSON.stringify(updates.start_urls) : null);
  }
  if (updates.mobile_model_id !== undefined) {
    sets.push('mobile_model_id = ?');
    params.push(updates.mobile_model_id);
  }
  if (updates.launch_args !== undefined) {
    const validated = validateLaunchArgs(updates.launch_args);
    sets.push('launch_args = ?');
    params.push(validated.length ? JSON.stringify(validated) : null);
  }
  if (updates.color !== undefined) {
    const badge = updates.color === null ? null : normalizeProfileColor(updates.color);
    if (updates.color !== null && !badge) {
      throw new Error(`invalid profile color: '${updates.color}'`);
    }
    sets.push('color = ?');
    params.push(badge);
  }
  if (updates.notes !== undefined) {
    sets.push('notes = ?');
    params.push(normalizeProfileNotes(updates.notes));
  }
  if (updates.do_not_track !== undefined) {
    sets.push('do_not_track = ?');
    params.push(normalizeDoNotTrack(updates.do_not_track));
  }
  if (updates.blocked_ports !== undefined) {
    const ports = normalizeBlockedPorts(updates.blocked_ports);
    sets.push('blocked_ports = ?');
    params.push(ports.length ? JSON.stringify(ports) : null);
  }
  if (updates.webrtc_policy !== undefined) {
    sets.push('webrtc_policy = ?');
    params.push(normalizeWebrtcPolicy(updates.webrtc_policy));
  }
  if (updates.headless !== undefined) {
    sets.push('headless = ?');
    params.push(updates.headless ? 1 : 0);
  }

  if (sets.length === 0) return true;

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  // The interpolated part is `sets`, and it is not attacker-controlled: every element is a
  // literal `'<column> = ?'` string pushed by this function, and each VALUE travels as a bound
  // parameter. There is no path by which a caller can put text into the column list, so this is
  // identifier interpolation of a closed set rather than string-built SQL.
    // Every element of `sets` is a literal '<column> = ?' pushed by this function, and every
    // value travels as a bound parameter, so no caller text reaches the SQL string.
    // SQLite cannot bind an identifier, which is why the column list is interpolated.
  db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`).run(...params); // pi-lens-ignore: sql-injection
  return true;
}

export function randomizeProfileFingerprint(id: string): number | null {
  const db = getDb();
  const profile = getProfile(id);
  if (!profile || !profile.fingerprint_id) return null;

  const fp = db
    .prepare('SELECT config_json FROM fingerprints WHERE id = ?')
    .get(profile.fingerprint_id) as { config_json: string } | undefined;
  if (!fp) return null;

  const cfg = parseFingerprintConfig(fp.config_json);

  const newSeed = randomInt(1, 2147483647);
  // Derive the WHOLE vector for the new seed, not just the seed.
  //
  // Writing only `seed` left the stored config describing the OLD draw, and the two halves then
  // disagreed: measured on a real profile, the new seed selected `win-intel-uhd-620-laptop` while
  // `config.family` still said `win-intel-iris-plus-g4-laptop`, and coherence validation rejected
  // it ("Screen resolution 1366x768 not in family allowed resolutions"). Preflight gates a launch
  // on that check, so the operator's "randomize" produced a profile that could no longer start.
  //
  // This is the same derivation the `rotate` path in `rotateFingerprints` performs, kept in step
  // with it deliberately: two writers of `fingerprints.config_json` must not describe the same
  // seed differently.
  const newCfg = buildFingerprintConfig(newSeed, cfg);

  db.prepare('UPDATE fingerprints SET seed = ?, config_json = ? WHERE id = ?').run(
    newSeed,
    JSON.stringify(newCfg),
    profile.fingerprint_id
  );
  return newSeed;
}

export interface GroupItem {
  id: string;
  name: string;
  created_at: number;
  profile_count: number;
  bookmarks?: string | null;
}

export function createGroup(name: string): string {
  const db = getDb();
  const id = 'g_' + randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
  return id;
}

export function updateGroup(id: string, name?: string, bookmarks?: string | null): boolean {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (name !== undefined) {
    sets.push('name = ?');
    params.push(name);
  }
  if (bookmarks !== undefined) {
    sets.push('bookmarks = ?');
    params.push(bookmarks);
  }
  if (sets.length === 0) return false;
  params.push(id);
    // Same closed set as updateProfile: `sets` holds only literals written in this function.
  const res = db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...params); // pi-lens-ignore: sql-injection
  return res.changes > 0;
}

export function deleteGroup(id: string): boolean {
  const db = getDb();
  // Only LIVE profiles are detached, which is the same population `listGroups` counts.
  //
  // Without `deleted_at IS NULL` this also cleared trashed profiles, so deleting a group the
  // operator saw as empty (count 0, because trashed rows are excluded from the count) silently
  // destroyed the group assignment of profiles sitting in the trash — measured: assign a profile
  // to a group, trash it, delete the group, restore it, and `group_id` came back `null`. The two
  // queries have to agree on who belongs to a group, or the count lies about what a delete removes.
  db.prepare('UPDATE profiles SET group_id = NULL WHERE group_id = ? AND deleted_at IS NULL').run(id);
  const res = db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  return res.changes > 0;
}

export function listGroups(): GroupItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.created_at, g.bookmarks, COUNT(p.id) AS profile_count
       FROM groups g
       LEFT JOIN profiles p ON p.group_id = g.id AND p.deleted_at IS NULL
       GROUP BY g.id
       ORDER BY g.created_at DESC`
    )
    .all() as Array<{ id: string; name: string; created_at: number; bookmarks?: string | null; profile_count: number }>;
  return rows;
}

export function listProfiles(
  page: number,
  pageSize: number,
  groupId?: string | null,
  search?: string | null,
  platform?: string | null,
  status?: string | null,
  tagId?: string | null
): { list: ProfileListItem[]; total: number } {
  const db = getDb();
  const clauses: string[] = ['p.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (groupId !== undefined && groupId !== null && groupId !== '') {
    clauses.push('p.group_id = ?');
    params.push(groupId);
  }
  if (search !== undefined && search !== null && search.trim() !== '') {
    const like = `%${search.trim()}%`;
    clauses.push('(p.name LIKE ? OR p.id LIKE ? OR px.host LIKE ?)');
    params.push(like, like, like);
  }
  if (platform !== undefined && platform !== null && platform !== '') {
    clauses.push('dev.platform = ?');
    params.push(platform);
  }
  if (status !== undefined && status !== null && status !== '') {
    clauses.push('p.status = ?');
    params.push(status);
  }
  if (tagId !== undefined && tagId !== null && tagId !== '') {
    clauses.push('EXISTS (SELECT 1 FROM profile_tags pt WHERE pt.profile_id = p.id AND pt.tag_id = ?)');
    params.push(tagId);
  }
  // Only the SHAPE is interpolated: every clause above is a hardcoded literal ending in `?`, and
  // every value travels in `params`. The repo uses this marker for exactly this pattern, see
  // `src/main/db/schema.ts:41`. Annotated rather than restructured because the scanner cannot tell
  // an allow-listed shape from attacker-controlled text, and an unannotated hit blocks the whole
  // file on every subsequent edit.
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''; // pi-lens-ignore: sql-injection

  const total = (db.prepare( // pi-lens-ignore: sql-injection
    `SELECT COUNT(*) AS c FROM profiles p
        LEFT JOIN proxies px ON px.id = p.proxy_id
        LEFT JOIN devices dev ON dev.id = p.device_id${where}`).get(...params) as { c: number }).c; // pi-lens-ignore: sql-injection
  const rows = db // pi-lens-ignore: sql-injection
    .prepare(
      `SELECT p.id, p.name, p.status, p.group_id, p.browser_type, p.color, p.proxy_id,
              px.type AS proxy_type, px.host AS proxy_host, px.port AS proxy_port,
              px.country AS proxy_country, px.country_code AS proxy_country_code,
              px.city AS proxy_city, px.status AS proxy_status,
              fp.seed AS fingerprint_seed,
              dev.platform AS platform, dev.name AS device_name
       FROM profiles p
       LEFT JOIN proxies px ON px.id = p.proxy_id
       LEFT JOIN fingerprints fp ON fp.id = p.fingerprint_id
       LEFT JOIN devices dev ON dev.id = p.device_id
       ${where}
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Array<{
    id: string;
    name: string | null;
    status: string;
    group_id: string | null;
    browser_type?: string | null;
    proxy_id: string | null;
    proxy_type: string | null;
    proxy_host: string | null;
    proxy_port: number | null;
    proxy_country: string | null;
    proxy_country_code: string | null;
    proxy_city: string | null;
    proxy_status: string | null;
    fingerprint_seed: number | null;
    platform: string | null;
    device_name: string | null;
    color: string | null;
  }>;

  let isRunningFn: (id: string) => boolean = () => false;
  let isFirefoxRunningFn: (id: string) => boolean = () => false;
  let isAndroidRunningFn: (id: string) => boolean = () => false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chromiumLauncher = require('../launcher/chromium') as { isRunning?: (id: string) => boolean };
    if (typeof chromiumLauncher.isRunning === 'function') {
      isRunningFn = chromiumLauncher.isRunning;
    }
  } catch {
    // Optional dependency: this module is absent in some build modes, and the caller tolerates a
    // missing liveness probe by reporting the stored status. Swallowed deliberately — but only
    // for that reason, so a failure is still diagnosable from the fallback it produces.
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const firefoxLauncher = require('../launcher/firefox') as { isRunning?: (id: string) => boolean };
    if (typeof firefoxLauncher.isRunning === 'function') {
      isFirefoxRunningFn = firefoxLauncher.isRunning;
    }
  } catch {
    // Same as above: the Firefox launcher is optional and its absence is not an error.
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const androidRuntime = require('../android/instance') as { isAndroidRunning?: (id: string) => boolean };
    if (typeof androidRuntime.isAndroidRunning === 'function') {
      isAndroidRunningFn = androidRuntime.isAndroidRunning;
    }
  } catch {
    // Same as above: the Android runtime is optional and its absence is not an error.
  }

  const list: ProfileListItem[] = rows.map((r) => {
    const liveRunning = isRunningFn(r.id) || isFirefoxRunningFn(r.id) || isAndroidRunningFn(r.id);
    const status = liveRunning ? 'running' : r.status;
    return {
      user_id: r.id,
      name: r.name,
      status,
      group_id: r.group_id,
      browser_type: r.browser_type ?? 'chromium',
      proxy_id: r.proxy_id,
      proxy_type: r.proxy_type,
      proxy_host: r.proxy_host,
      proxy_port: r.proxy_port,
      proxy_country: r.proxy_country,
      proxy_country_code: r.proxy_country_code,
      proxy_city: r.proxy_city,
      proxy_status: r.proxy_status,
      fingerprint_seed: r.fingerprint_seed,
      platform: r.platform,
      device_name: r.device_name,
      // The colour was SELECTed and typed on `ProfileListItem` but never copied here, so the row's
      // badge dot (`data-testid="profile-color-dot"`) could not render for any profile — the whole
      // badge feature was inert. The column was read and then dropped one line later.
      color: r.color,
    };
  });
  return { list, total };
}

export function resolveLaunchConfig(id: string): LaunchConfig {
  const db = getDb();
  const profile = getLiveProfile(id);
  if (!profile) throw new Error('profile not found');
  // Invariant: android profiles are handled by androidRuntime, not desktop Chromium/Firefox launcher.
  if (profile.browser_type === 'android') {
    throw new Error('Android profiles cannot be launched via desktop launch config');
  }

  let fingerprintSeed = 0;
  let fingerprint: FingerprintLaunch | undefined;
  let screenOverride: { width: number; height: number } | undefined;
  let fontListOverride: string[] | undefined;
  if (profile.fingerprint_id) {
    const fp = db
      .prepare('SELECT seed, config_json FROM fingerprints WHERE id = ?')
      .get(profile.fingerprint_id) as { seed: number; config_json: string } | undefined;
    if (fp) {
      fingerprintSeed = migrateLegacySeed(id, fp.seed);
      const fpCfg = parseFingerprintConfig(fp.config_json);
      if (Array.isArray(fpCfg.fontList)) {
        fontListOverride = (fpCfg.fontList as unknown[]).filter((f): f is string => typeof f === 'string');
      }
      const hwVector = deriveHardwareVector(fingerprintSeed, EXTENDED_FINGERPRINT_CATALOG);
      fingerprint = {
        seed: fingerprintSeed,
        platform: typeof fpCfg.platform === 'string' ? fpCfg.platform : 'windows',
        platformVersion: typeof fpCfg.platformVersion === 'string' ? fpCfg.platformVersion : hwVector.platformVersion,
        brand: typeof fpCfg.brand === 'string' ? fpCfg.brand : 'Chrome',
        brandVersion: typeof fpCfg.brandVersion === 'string' ? fpCfg.brandVersion : undefined,
        hardwareConcurrency:
          typeof fpCfg.hardwareConcurrency === 'number' ? fpCfg.hardwareConcurrency : hwVector.cpuCores,
        timezone: profile.timezone ?? undefined,
        lang: typeof fpCfg.lang === 'string' ? fpCfg.lang : hwVector.locale,
        disableSpoofing: typeof fpCfg.disableSpoofing === 'string' ? fpCfg.disableSpoofing : undefined,
      };
      // AdsPower-style desktop screen resolution override (fingerprint config).
      if (
        fpCfg.screen &&
        typeof fpCfg.screen === 'object' &&
        typeof (fpCfg.screen as { width?: unknown }).width === 'number' &&
        typeof (fpCfg.screen as { height?: unknown }).height === 'number'
      ) {
        const s = fpCfg.screen as { width: number; height: number };
        if (s.width >= 320 && s.width <= 7680 && s.height >= 240 && s.height <= 4320) {
          screenOverride = { width: s.width, height: s.height };
        }
      } else if (hwVector.screenResolution) {
        screenOverride = hwVector.screenResolution;
      }
      // navigator.deviceMemory override (GB) from fingerprint config or hwVector
      const mem = typeof fpCfg.deviceMemory === 'number' ? fpCfg.deviceMemory : hwVector.ramGB;
      if (fingerprint) {
        (fingerprint as { deviceMemory?: number }).deviceMemory = mem;
      }
    }
  } else {
    fingerprintSeed = migrateLegacySeed(id, null);
  }

  // Device preset (Phase 4): desktop presets override kernel fingerprint parameters;
  // mobile presets are emulated at the CDP layer.
  let deviceEmulation: DeviceEmulationConfig | undefined;
  let stealth: StealthConfig | undefined;
  if (profile.device_id) {
    const dev = db
      .prepare('SELECT config_json FROM devices WHERE id = ?')
      .get(profile.device_id) as { config_json: string } | undefined;
    if (dev) {
      let devCfg: Record<string, unknown> = {};
      try {
        devCfg = JSON.parse(dev.config_json || '{}') as Record<string, unknown>;
      } catch {
        devCfg = {};
      }

      // Stealth layer: Client Hints + headless-trace fixes, consistent with the device.
      const logicalPlatform =
        typeof devCfg.logicalPlatform === 'string'
          ? (devCfg.logicalPlatform as StealthConfig['logicalPlatform'])
          : devCfg.platform === 'macos'
            ? 'macos'
            : devCfg.platform === 'linux'
              ? 'linux'
              : devCfg.mobile === true
                ? (devCfg.platform as string) === 'ios'
                  ? 'ios'
                  : 'android'
                : 'windows';

      if (devCfg.mobile === true) {
        // ÐœÐ¾Ð±Ð¸Ð»ÑŒÐ½Ñ‹Ð¹ Ð¿Ñ€Ð¾Ñ„Ð¸Ð»ÑŒ v2: Ð´ÐµÑ‚ÐµÑ€Ð¼Ð¸Ð½Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð½Ñ‹Ð¹ Â«Ñ‚ÐµÐ»ÐµÑ„Ð¾Ð½Â» Ð¸Ð· Ð¿ÑƒÐ»Ð° Ð¿Ð¾ seed â€” Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ð´Ð»Ñ Android.
        // Ð•ÑÐ»Ð¸ Ð¿Ð¾Ð»ÑŒÐ·Ð¾Ð²Ð°Ñ‚ÐµÐ»ÑŒ Ð·Ð°Ñ„Ð¸ÐºÑÐ¸Ñ€Ð¾Ð²Ð°Ð» Ð¼Ð¾Ð´ÐµÐ»ÑŒ (mobile_model_id) â€” Ð¸ÑÐ¿Ð¾Ð»ÑŒÐ·ÑƒÐµÐ¼ ÐµÑ‘, Ð¸Ð½Ð°Ñ‡Ðµ
        // Ð´ÐµÑ‚ÐµÑ€Ð¼Ð¸Ð½Ð¸Ñ€Ð¾Ð²Ð°Ð½Ð½Ñ‹Ð¹ Ð²Ñ‹Ð±Ð¾Ñ€ Ð¾Ñ‚ seed (Ð¾Ð´Ð¸Ð½ Ð¿Ñ€Ð¾Ñ„Ð¸Ð»ÑŒ = Ð¾Ð´Ð¸Ð½ Ñ‚ÐµÐ»ÐµÑ„Ð¾Ð½ Ð¿Ñ€Ð¸ ÐºÐ°Ð¶Ð´Ð¾Ð¼ Ð·Ð°Ð¿ÑƒÑÐºÐµ).
        const isAndroid = logicalPlatform === 'android';
        const preset = isAndroid
          ? profile.mobile_model_id
            ? getMobilePreset(profile.mobile_model_id)
            : pickMobilePreset(fingerprintSeed)
          : undefined;
        deviceEmulation = {
          mobile: true,
          ua: preset ? buildMobileUa(preset) : typeof devCfg.ua === 'string' ? devCfg.ua : undefined,
          screen: preset ? preset.screen : (devCfg.screen as DeviceEmulationConfig['screen']),
          touch: typeof devCfg.touch === 'boolean' ? devCfg.touch : true,
          maxTouchPoints:
            typeof devCfg.maxTouchPoints === 'number' ? devCfg.maxTouchPoints : 5,
        };
        // Ð¡Ð¾Ñ…Ñ€Ð°Ð½ÑÐµÐ¼ Ð¿Ñ€ÐµÑÐµÑ‚ Ð´Ð»Ñ stealth-ÑÐ»Ð¾Ñ (Ð¼Ð¾Ð´ÐµÐ»ÑŒ/Ð²ÐµÑ€ÑÐ¸Ñ Android/GPU).
        if (preset) devCfg._preset = preset;
      }

      const preset = (devCfg._preset as MobilePreset | undefined) ?? undefined;
      stealth = {
        mobile: devCfg.mobile === true,
        logicalPlatform,
        ua: preset ? buildMobileUa(preset) : typeof devCfg.ua === 'string' ? devCfg.ua : undefined,
        model: preset ? preset.model : typeof devCfg.model === 'string' ? devCfg.model : undefined,
        platformVersion:
          preset
            ? `${preset.androidVersion}.0.0`
            : typeof devCfg.platformVersion === 'string'
              ? devCfg.platformVersion
              : undefined,
        hardwareConcurrency:
          preset
            ? preset.hardwareConcurrency
            : typeof devCfg.hardwareConcurrency === 'number'
              ? devCfg.hardwareConcurrency
              : undefined,
        deviceMemory: typeof devCfg.deviceMemory === 'number' ? devCfg.deviceMemory : undefined,
        maxTouchPoints:
          typeof devCfg.maxTouchPoints === 'number' ? devCfg.maxTouchPoints : undefined,
      };

      if (fingerprint) {
        if (typeof devCfg.platform === 'string') {
          fingerprint.platform = devCfg.platform;
        }
        if (devCfg.mobile === true) {
          // A phone must not present as a Windows machine.
          //
          // The seeded mobile presets carry `platform: 'windows'` (carried over from the desktop
          // presets they were copied from), and that value reaches `--fingerprint-platform` — the
          // flag the ENGINE uses. It is what a WORKER reports, and a worker is reachable by page
          // script but cannot be patched by the injected JS layer. Measured before this fix: page
          // `Linux armv81`, worker `Win32` — one device described as two operating systems.
          // The JS layer still reports the platform-specific string on the page.
          //
          // The kernel understands only windows|linux|macos (docs/KERNEL.md); 'android' resolves to
          // Win32, measured. So each mobile platform maps to the closest one the engine can express,
          // keeping the worker in the same OS family the page claims.
          fingerprint.platform = logicalPlatform === 'ios' ? 'macos' : 'linux';
        }
        if (typeof devCfg.platformVersion === 'string') {
          fingerprint.platformVersion = devCfg.platformVersion;
        }
        if (typeof devCfg.brand === 'string') fingerprint.brand = devCfg.brand;
        if (typeof devCfg.hardwareConcurrency === 'number') {
          fingerprint.hardwareConcurrency = devCfg.hardwareConcurrency;
        }
        if (typeof devCfg.lang === 'string') fingerprint.lang = devCfg.lang;
        if (typeof devCfg.timezone === 'string') fingerprint.timezone = devCfg.timezone;
      }
    }
  }

  // Stealth layer applies to every profile (headless-trace fixes are universal);
  // device presets above refine it for mobile/desktop consistency.
  const hwVector = deriveHardwareVector(fingerprintSeed, EXTENDED_FINGERPRINT_CATALOG);

  /**
   * The language the operator chose, if any.
   *
   * `fingerprint.lang` is the single source for the browser's language: the launcher turns it
   * into `--lang` and `--accept-lang`, and `navigator.language` follows it. The stealth layer
   * carries its own `locale`, used for the speech-synthesis voice pool and the font list, and it
   * was always taken from the fingerprint's seed-derived locale — so a profile whose operator
   * picked en-US still advertised voices and fonts for the seed's language. Two halves of the
   * same profile disagreeing about which language the machine speaks is exactly the kind of
   * inconsistency this layer exists to prevent.
   */
  const chosenLang = typeof fingerprint?.lang === 'string' && fingerprint.lang.trim().length > 0
    ? fingerprint.lang.trim()
    : undefined;

  if (!stealth) {
    stealth = {
      mobile: false,
      logicalPlatform: 'windows',
      platformVersion: hwVector.platformVersion,
      hardwareConcurrency:
        typeof fingerprint?.hardwareConcurrency === 'number'
          ? fingerprint.hardwareConcurrency
          : hwVector.cpuCores,
      deviceMemory: hwVector.ramGB,
      locale: chosenLang ?? hwVector.locale,
      fontList: fontListOverride ?? hwVector.fontInventory,
    };
  } else {
    stealth.fontList = fontListOverride ?? stealth.fontList ?? hwVector.fontInventory;
    // The device branch above may have set a locale; the operator's choice wins over it, because
    // it is the value the browser actually runs with.
    if (chosenLang) stealth.locale = chosenLang;
  }
  let proxyServer: string | undefined;
  let proxyAuth: { username: string; password: string } | undefined;
  let sshTunnel: SshTunnelConfig | undefined;
  let proxyTimezone: string | undefined;
  if (profile.proxy_id) {
    const px = db
      .prepare('SELECT * FROM proxies WHERE id = ?')
      .get(profile.proxy_id) as ProxyRow | undefined;
    if (px) {
      proxyTimezone = px.timezone ?? undefined;
      if (px.type === 'ssh') {
        // SSH proxies are tunneled locally (launcher creates a SOCKS5 endpoint).
        sshTunnel = {
          host: px.host,
          port: px.port,
          username: px.username ?? undefined,
          password: revealSecret(px.password),
          privateKey: revealSecret(px.private_key),
        };
      } else {
        proxyServer = `${px.type}://${px.host}:${px.port}`;
        const pxPass = revealSecret(px.password);
        if (px.username && pxPass) {
          proxyAuth = { username: px.username, password: pxPass };
        }
      }
    }
  }

  // Geolocation override (Sprint A)
  let geolocation: LaunchConfig['geolocation'];
  if (profile.geolocation) {
    try {
      const g = JSON.parse(profile.geolocation) as { latitude?: number; longitude?: number; accuracy?: number };
      if (typeof g.latitude === 'number' && typeof g.longitude === 'number') {
        geolocation = { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy };
      }
    } catch {
      // ignore
    }
  } else if (profile.proxy_id) {
    const px = db.prepare('SELECT latitude, longitude FROM proxies WHERE id = ?').get(profile.proxy_id) as
      | { latitude: number | null; longitude: number | null }
      | undefined;
    if (px && typeof px.latitude === 'number' && typeof px.longitude === 'number') {
      geolocation = { latitude: px.latitude, longitude: px.longitude };
    }
  }

  // Cookies (Sprint A)
  let cookies: Array<Record<string, unknown>> | undefined;
  const cookieRow = db
    .prepare('SELECT cookies_json FROM profiles WHERE id = ?')
    .get(id) as { cookies_json: string | null } | undefined;
  if (cookieRow?.cookies_json) {
    try {
      const parsed = JSON.parse(cookieRow.cookies_json);
      if (Array.isArray(parsed)) cookies = parsed;
    } catch {
      // ignore malformed json
    }
  }

  // Extensions (Sprint B): on-disk paths of bound extensions.
  const extPaths = getEnabledExtensionPaths(id);

  // Start URLs (v0.2.6): opened on start (first in current tab, rest in new tabs).
  let startUrls: string[] | undefined;
  const startUrlsRow = db
    .prepare('SELECT start_urls FROM profiles WHERE id = ?')
    .get(id) as { start_urls: string | null } | undefined;
  if (startUrlsRow?.start_urls) {
    try {
      const parsed = JSON.parse(startUrlsRow.start_urls);
      if (Array.isArray(parsed)) startUrls = parsed.filter((u) => typeof u === 'string');
    } catch {
      // ignore malformed json
    }
  }

  return {
    profileId: id,
    userDataDir: path.join(PROFILES_DIR, id),
    browserType: profile.browser_type === 'firefox' ? 'firefox' : 'chromium',
    proxyServer,
    proxyAuth,
    sshTunnel,
    proxyTimezone,
    fingerprintSeed,
    fingerprint,
    deviceEmulation,
    stealth,
    geolocation,
    cookies,
    extensionPaths: extPaths.length ? extPaths : undefined,
    startUrls: startUrls && startUrls.length ? startUrls : undefined,
    userAgent: profile.user_agent ?? undefined,
    timezone: profile.timezone ?? undefined,
    screenOverride,
    launch_args: parseLaunchArgsColumn(profile.launch_args),
    color: profile.color ?? null,
    do_not_track: profile.do_not_track ?? null,
    blocked_ports: parseBlockedPortsColumn(profile.blocked_ports),
    webrtc_policy: profile.webrtc_policy ?? null,
    profileName: profile.name ?? null,
    // Persisted display mode. Absent for every profile stored before the column existed,
    // which must keep launching a window — `undefined` and `false` both mean headed.
    headless: profile.headless === 1,
    stealthEngineProfileId:
      (typeof process.env.ANTIDETECT_ENGINE_PROFILE === 'string' &&
        process.env.ANTIDETECT_ENGINE_PROFILE.length > 0)
        ? process.env.ANTIDETECT_ENGINE_PROFILE
        : undefined,
  };
}

/**
 * Clears cached directories (Cache, Code Cache, GPUCache, ShaderCache, DawnCache, GrShaderCache)
 * inside the profile's user data directory while preserving persistent session data (Cookies, Preferences, Bookmarks).
 */
export function clearProfileCache(id: string): { ok: boolean; cleared_dirs: string[] } {
  const profileDir = path.join(PROFILES_DIR, id);
  if (!fs.existsSync(profileDir)) {
    return { ok: false, cleared_dirs: [] };
  }
  const TARGET_DIRS: Record<string, true> = {
    'Cache': true,
    'Code Cache': true,
    'GPUCache': true,
    'ShaderCache': true,
    'DawnCache': true,
    'GrShaderCache': true,
  };
  const cleared: string[] = [];

  function clean(current: string, depth = 0) {
    if (depth > 5) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(current, entry.name);
      if (TARGET_DIRS[entry.name]) {
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
          cleared.push(entry.name);
        } catch {
          // best-effort
        }
      } else {
        clean(fullPath, depth + 1);
      }
    }
  }

  clean(profileDir);
  return { ok: true, cleared_dirs: cleared };
}

