import * as crypto from 'crypto';
import type {
  FingerprintCatalogFamily,
  HardwareVector,
  SubSeeds,
} from './types';
import { WINDOWS_FINGERPRINT_CATALOG, EXTENDED_FINGERPRINT_CATALOG } from './catalog';
// KEEP: Seeds every fingerprint sub-seed; changing silently re-seeds every profile's fingerprint.
export const HMAC_SECRET = 'antidetect-fingerprint-catalog-domain-v1';

/**
 * Valid primary seed range: [1, 2147483647] (positive 31-bit signed int32)
 */
export const MIN_SEED = 1;
export const MAX_SEED = 2147483647;

export type SubSeedDomain =
  | 'canvas'
  | 'webgl'
  | 'audio'
  | 'domrect'
  | 'voices'
  | 'devices'
  | 'platform'
  | 'screen';

const ALL_DOMAINS: SubSeedDomain[] = [
  'canvas',
  'webgl',
  'audio',
  'domrect',
  'voices',
  'devices',
  'platform',
  'screen',
];

// CRC32 lives in a leaf module so `migration.ts` can use it without closing the
// migration -> derivation -> catalog -> macosFamilies -> migration import cycle.
// Re-exported here to keep the existing public surface and its importers working.
import { crc32 } from './crc32';
export { crc32 };

/**
 * Legacy seed migration function:
 * Converts invalid or non-positive seeds into deterministic positive int32 in [1, 2147483647].
 * Replay-safe and deterministic.
 */
export function migrateLegacySeed(profileId: string, oldSeed?: number | null): number {
  if (
    typeof oldSeed === 'number' &&
    Number.isInteger(oldSeed) &&
    oldSeed >= MIN_SEED &&
    oldSeed <= MAX_SEED
  ) {
    return oldSeed;
  }

  // Derive deterministic 31-bit integer from profile.id using CRC32
  const hash = crc32(`profile-seed-migration:${profileId}`);
  const positive31 = (hash & 0x7fffffff) >>> 0;
  // Map 0 -> 1 to guarantee [1, 2147483647]
  return positive31 === 0 ? 1 : positive31;
}

/**
 * Primary seed positive signed int32 1..2147483647 -> domain-separated sub-seeds via HMAC-SHA256.
 * HMAC-SHA256(secret, seed || ':' || domain)
 * Derived sub-seed = first 4 bytes read UInt32 BE / LE forced positive with (val & 0x7fffffff) or >>> 1.
 */
export function deriveCatalogSubSeeds(primarySeed: number): SubSeeds {
  const safeSeed = Math.max(MIN_SEED, Math.min(MAX_SEED, primarySeed >>> 0 || 1));
  const result: Record<string, number> = {};

  for (const domain of ALL_DOMAINS) {
    const hmac = crypto.createHmac('sha256', HMAC_SECRET);
    hmac.update(`${safeSeed}:${domain}`);
    const digest = hmac.digest();
    // First 4 bytes as unsigned 32-bit int, forced positive (31-bit)
    const rawVal = digest.readUInt32BE(0);
    const positiveSubSeed = (rawVal >>> 1) || 1;
    result[domain] = positiveSubSeed;
  }

  return result as unknown as SubSeeds;
}

/**
 * Deterministic weighted selection of a fingerprint family based on primary seed.
 *
 * The fraction is scaled by the catalog's TOTAL weight rather than compared against a running sum
 * of raw weights. That distinction was a real defect: the Windows catalog's weights sum to exactly
 * 1.000000, and it is concatenated FIRST in the extended catalog, so a fraction drawn from [0, 1)
 * always fell inside the Windows block and the walk never advanced past it. Measured over 20 000
 * seeds against `EXTENDED_FINGERPRINT_CATALOG` (the catalog the profile manager passes): 20000
 * Windows, **0 macOS, 0 Linux** — every one of the 12 macOS/Linux families was unreachable, so the
 * app advertised platforms it could never emit. Scaling by the total (3.08 for the extended
 * catalog) keeps the families' relative proportions while making the whole range selectable.
 */
export function selectFamilyBySeed(
  primarySeed: number,
  catalog: FingerprintCatalogFamily[] = WINDOWS_FINGERPRINT_CATALOG
): FingerprintCatalogFamily {
  if (catalog.length === 0) {
    throw new Error('selectFamilyBySeed requires a non-empty catalog');
  }
  const safeSeed = Math.max(MIN_SEED, Math.min(MAX_SEED, primarySeed >>> 0 || 1));

  // Pseudo-random uniform fraction in [0, 1) derived from primary seed HMAC
  const hmac = crypto.createHmac('sha256', HMAC_SECRET);
  hmac.update(`${safeSeed}:family-selection`);
  const digest = hmac.digest();
  const rawUint32 = digest.readUInt32BE(0);
  const fraction = rawUint32 / 0x100000000; // 0.0 <= fraction < 1.0

  const total = catalog.reduce((sum, family) => sum + (family.weight || 0), 0);
  if (!(total > 0)) {
    // Every weight is zero or missing: no weighting information exists, so fall back to an even
    // split rather than returning the last family for every seed.
    return catalog[Math.min(catalog.length - 1, Math.floor(fraction * catalog.length))];
  }

  const target = fraction * total;
  let cumulative = 0;
  for (const family of catalog) {
    cumulative += family.weight || 0;
    if (target < cumulative) {
      return family;
    }
  }

  // Fallback to last family if floating point rounding slightly exceeds the total
  return catalog[catalog.length - 1];
}

/**
 * Deterministically pick an element from an array based on an integer sub-seed.
 */
function pickFromSubSeed<T>(arr: readonly T[], subSeed: number): T {
  if (arr.length === 0) {
    throw new Error('Cannot pick from empty array');
  }
  const index = (subSeed % arr.length + arr.length) % arr.length;
  return arr[index];
}

/**
 * Generate a complete, coherent hardware vector for a given primary seed.
 */
export function deriveHardwareVector(
  primarySeed: number,
  catalog: FingerprintCatalogFamily[] = WINDOWS_FINGERPRINT_CATALOG
): HardwareVector {
  const safeSeed = Math.max(MIN_SEED, Math.min(MAX_SEED, primarySeed >>> 0 || 1));
  const subSeeds = deriveCatalogSubSeeds(safeSeed);
  const family = selectFamilyBySeed(safeSeed, catalog);

  // CPU Cores selection (jitter within min/max bounds)
  const coreRange = family.cpu.coresMax - family.cpu.coresMin + 1;
  const cpuCores = family.cpu.coresMin + (subSeeds.platform % coreRange);

  // RAM selection from family set
  const ramGB = pickFromSubSeed(family.ramGB, subSeeds.devices);

  // Screen resolution selection from family set
  const screenResolution = pickFromSubSeed(family.screen.resolutions, subSeeds.screen);

  // Platform version from range
  const platformVersion = pickFromSubSeed(family.platformVersionRange, subSeeds.platform);

  // Locale from family pool
  const locale = pickFromSubSeed(family.localePool, subSeeds.voices);

  const isMac = family.coherenceConstraints.platform === 'macos';
  const navigatorPlatform = isMac ? 'MacIntel' : 'Win32';

  const vector: HardwareVector = {
    familyId: family.id,
    displayName: family.displayName,
    cpuCores,
    ramGB,
    gpuVendor: family.gpu.vendor,
    gpuRenderer: family.gpu.renderer,
    webgpuAdapter: family.gpu.webgpuAdapter,
    screenResolution,
    devicePixelRatio: family.screen.dpr,
    colorDepth: family.screen.colorDepth,
    platform: family.coherenceConstraints.platform,
    navigatorPlatform,
    platformVersion,
    architecture: family.coherenceConstraints.platformArch,
    bitness: family.coherenceConstraints.bitness,
    fontClass: family.fontsClass,
    locale,
    chip: family.chip,
    audioSignature: family.audioSignature,
    fontInventory: family.fontInventory,
    screenProfile: family.screenProfile,
    scaleFactor: family.scaleFactor,
    uaProfile: family.uaProfile,
  };

  validateCoherence(vector, family);
  return vector;
}

export function validateCoherence(
  vector: HardwareVector,
  family?: FingerprintCatalogFamily
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const matchedFamily =
    family ||
    EXTENDED_FINGERPRINT_CATALOG.find((f: FingerprintCatalogFamily) => f.id === vector.familyId) ||
    WINDOWS_FINGERPRINT_CATALOG.find((f: FingerprintCatalogFamily) => f.id === vector.familyId);
  if (!matchedFamily) {
    violations.push(`Unknown familyId: ${vector.familyId}`);
    return { valid: false, violations };
  }

  // 1. GPU <-> CPU Cores constraint
  if (matchedFamily.gpu.limitsClass === 'integrated' && vector.cpuCores > 16) {
    violations.push(`Integrated GPU cannot have > 16 CPU cores (found ${vector.cpuCores})`);
  }

  // 2. RAM constraints
  if (matchedFamily.gpu.limitsClass === 'budget' && vector.ramGB > 16) {
    violations.push(`Budget systems cannot have > 16GB RAM (found ${vector.ramGB}GB)`);
  }
  if (!matchedFamily.ramGB.includes(vector.ramGB)) {
    violations.push(`RAM ${vector.ramGB}GB not in family allowed set [${matchedFamily.ramGB.join(', ')}]`);
  }

  // 3. CPU Cores range
  if (vector.cpuCores < matchedFamily.cpu.coresMin || vector.cpuCores > matchedFamily.cpu.coresMax) {
    violations.push(
      `CPU cores ${vector.cpuCores} outside bounds [${matchedFamily.cpu.coresMin}, ${matchedFamily.cpu.coresMax}]`
    );
  }

  // 4. Screen resolution
  const resValid = matchedFamily.screen.resolutions.some(
    (r: { width: number; height: number }) => r.width === vector.screenResolution.width && r.height === vector.screenResolution.height
  );
  if (!resValid) {
    violations.push(
      `Screen resolution ${vector.screenResolution.width}x${vector.screenResolution.height} not in family allowed resolutions`
    );
  }

  // 5. Screen color depth and DPR
  if (vector.colorDepth !== 24 && vector.colorDepth !== 30) {
    violations.push(`Invalid screen color depth ${vector.colorDepth}`);
  }
  const maxAllowedDpr = matchedFamily.screenProfile?.isRetina || matchedFamily.screen.dpr >= 2 ? 3.0 : 2.5;
  if (vector.devicePixelRatio > maxAllowedDpr) {
    violations.push(`DPR ${vector.devicePixelRatio} exceeds desktop limit ${maxAllowedDpr}`);
  }
  // 6. Architecture & Platform
  const isMac = matchedFamily.coherenceConstraints.platform === 'macos';
  if (matchedFamily.cpu.arch === 'arm64' && vector.architecture !== 'arm') {
    violations.push(`ARM64 CPU must have arm architecture (found ${vector.architecture})`);
  }
  if (matchedFamily.cpu.arch === 'x64' && vector.architecture !== 'x86') {
    violations.push(`x64 CPU must have x86 architecture (found ${vector.architecture})`);
  }
  if (vector.navigatorPlatform) {
    if (isMac && vector.navigatorPlatform !== 'MacIntel') {
      violations.push(`macOS must report platform MacIntel (found ${vector.navigatorPlatform})`);
    }
    if (!isMac && vector.navigatorPlatform !== 'Win32') {
      violations.push(`Windows must report platform Win32 (found ${vector.navigatorPlatform})`);
    }
  }
  if (!matchedFamily.localePool.includes(vector.locale)) {
    violations.push(`Locale ${vector.locale} not in family pool [${matchedFamily.localePool.join(', ')}]`);
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
