// Android identity fingerprint derivation.
// Traced to requirements R06, R08: deterministic mobile identity pool and guest hardware spoofing.
// REUSES the existing mobile preset pool from src/main/devices/mobilePresets.ts without duplicating it.

import * as crypto from 'crypto';
import {
  MOBILE_PRESETS,
  MobilePreset,
  getMobilePreset,
  pickMobilePreset,
  buildMobileUa,
} from '../devices/mobilePresets';

export { MOBILE_PRESETS, getMobilePreset, pickMobilePreset, buildMobileUa };

export interface AndroidFingerprint {
  /** Preset id from src/main/devices/mobilePresets.ts — the identity source (no new pool). */
  presetId: string;
  model: string;
  manufacturer: string;
  androidVersion: string; // e.g. "15"
  sdkInt: number; // e.g. 35
  buildId: string;
  buildFingerprint: string; // google/<device>/<device>:<ver>/<buildId>/<incremental>:user/release-keys
  /** 16 hex chars. Derived from the seed, formatted like a real Android ID. */
  androidId: string;
  /** 15 digits, Luhn-valid. */
  imei: string;
  serial: string;
  /** Uppercase colon-separated MAC, locally-administered bit preserved. */
  wifiMac: string;
  screen: { width: number; height: number; densityDpi: number };
  gpu: { renderer: string; vendor: string };
}

/**
 * Pure Luhn check digit computation.
 * Given a partial digit string (e.g. the 14-digit payload of an IMEI),
 * doubles every second digit moving left from the right of the partial string
 * (offset 0 from right is doubled, offset 1 is not, offset 2 is doubled, etc.),
 * subtracts 9 when doubled value > 9, and computes check digit = (10 - (sum % 10)) % 10.
 *
 * Appending this digit produces a 15-digit number that passes standard Luhn validation.
 */
export function luhnCheckDigit(digits: string): number {
  const clean = digits.replace(/\D/g, '');
  let sum = 0;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    const distFromRight = clean.length - 1 - i;
    if (distFromRight % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Deterministic pseudo-random stream generator derived from a profileId and seed.
 * SHA-256 counter mode ensures cryptographic uniformity, complete determinism,
 * and zero correlation between distinct profiles.
 */
class DeterministicRng {
  private counter = 0;
  private readonly seedHash: Buffer;

  constructor(profileId: string, seed: number) {
    this.seedHash = crypto
      .createHash('sha256')
      .update(`${profileId}:${seed}`)
      .digest();
  }

  nextBytes(length: number): Buffer {
    const chunks: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      this.counter++;
      const block = crypto
        .createHash('sha256')
        .update(this.seedHash)
        .update(
          Buffer.from([
            this.counter & 0xff,
            (this.counter >> 8) & 0xff,
            (this.counter >> 16) & 0xff,
            (this.counter >> 24) & 0xff,
          ])
        )
        .digest();
      const take = Math.min(remaining, block.length);
      chunks.push(block.subarray(0, take));
      remaining -= take;
    }
    return Buffer.concat(chunks);
  }

  nextUint32(): number {
    return this.nextBytes(4).readUInt32BE(0);
  }
}

function deriveManufacturer(preset: MobilePreset): string {
  const id = preset.id.toLowerCase();
  const name = preset.name.toLowerCase();
  if (id.startsWith('pixel')) return 'Google';
  if (
    id.startsWith('s2') ||
    id.startsWith('s21') ||
    id.startsWith('s22') ||
    id.startsWith('s23') ||
    id.startsWith('s24') ||
    id.startsWith('s25') ||
    id.startsWith('z_') ||
    id.startsWith('a1') ||
    id.startsWith('a2') ||
    id.startsWith('a3') ||
    id.startsWith('a5') ||
    id.startsWith('m3') ||
    name.startsWith('galaxy')
  ) {
    return 'samsung';
  }
  if (id.startsWith('xiaomi') || id.startsWith('redmi') || id.startsWith('poco')) return 'Xiaomi';
  if (id.startsWith('oneplus')) return 'OnePlus';
  if (id.startsWith('nothing')) return 'Nothing';
  if (id.startsWith('oppo')) return 'OPPO';
  if (id.startsWith('realme')) return 'realme';
  if (id.startsWith('honor')) return 'HONOR';
  if (id.startsWith('vivo') || id.startsWith('iqoo')) return 'vivo';
  if (id.startsWith('huawei')) return 'HUAWEI';
  if (id.startsWith('moto')) return 'Motorola';
  if (id.startsWith('rog') || id.startsWith('zenfone')) return 'ASUS';
  if (id.startsWith('xperia')) return 'Sony';
  if (id.startsWith('tecno')) return 'Tecno';
  if (id.startsWith('infinix')) return 'Infinix';
  if (id.startsWith('zte')) return 'ZTE';
  return 'Google';
}

function deriveSdkInt(androidVersion: string): number {
  const sdkMap: Record<string, number> = {
    '11': 30,
    '12': 31,
    '13': 33,
    '14': 34,
    '15': 35,
    '16': 36,
  };
  const v = parseInt(androidVersion, 10);
  return sdkMap[androidVersion] ?? (Number.isNaN(v) ? 34 : v + 20);
}

/**
 * Deterministic: same profileId + seed => identical identity forever.
 * Derives its own PRNG from a hash of profileId + seed to avoid global RNG pollution.
 */
export function generateAndroidFingerprint(
  profileId: string,
  seed: number
): AndroidFingerprint {
  const rng = new DeterministicRng(profileId, seed);

  // 1. Pick preset deterministically from the existing MOBILE_PRESETS pool
  const presetIndex = rng.nextUint32() % MOBILE_PRESETS.length;
  const preset = MOBILE_PRESETS[presetIndex];

  const manufacturer = deriveManufacturer(preset);
  const sdkInt = deriveSdkInt(preset.androidVersion);

  // 2. Derive androidId: 16 hex chars (64-bit integer, standard Android Settings.Secure.ANDROID_ID)
  const androidId = rng.nextBytes(8).toString('hex').toLowerCase();

  // 3. Derive 15-digit IMEI: 14 payload digits (GSM TAC 35... prefix) + 1 Luhn check digit
  let imeiPartial = '35';
  for (let i = 0; i < 12; i++) {
    imeiPartial += String(rng.nextUint32() % 10);
  }
  const checkDigit = luhnCheckDigit(imeiPartial);
  const imei = imeiPartial + String(checkDigit);

  // 4. Derive serial: 12 uppercase hex characters
  const serial = rng.nextBytes(6).toString('hex').toUpperCase();

  // 5. Derive wifiMac: 6 octets, locally-administered bit set (bit 1 = 1), unicast (bit 0 = 0)
  const macBytes = rng.nextBytes(6);
  macBytes[0] = (macBytes[0] & 0xfc) | 0x02;
  const wifiMac = Array.from(macBytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');

  // 6. Derive buildFingerprint
  const brand = manufacturer.toLowerCase();
  const device = preset.id.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  const incremental = 1000000 + (rng.nextUint32() % 9000000);
  const buildFingerprint = `${brand}/${device}/${device}:${preset.androidVersion}/${preset.build}/${incremental}:user/release-keys`;

  // 7. Screen: physical pixels + density. Preset dims are CSS px (dp); the emulator LCD,
  // scrcpy video and touch viewport are all PHYSICAL px, so multiply by deviceScaleFactor.
  // Feeding dp as px gave a 412x915 LCD at 420dpi (should be ~1080x2400): the guest UI
  // rendered squeezed exactly as the screenshots showed.
  const densityDpi = Math.round(preset.screen.deviceScaleFactor * 160);
  const screen = {
    width: Math.round(preset.screen.width * preset.screen.deviceScaleFactor),
    height: Math.round(preset.screen.height * preset.screen.deviceScaleFactor),
    densityDpi,
  };

  // 8. GPU vendor & renderer
  let vendor = 'Qualcomm';
  if (preset.gpu.includes('Mali')) {
    vendor = 'ARM';
  } else if (preset.gpu.includes('Xclipse')) {
    vendor = 'Samsung';
  }
  const gpu = {
    renderer: preset.gpu,
    vendor,
  };

  return {
    presetId: preset.id,
    model: preset.model,
    manufacturer,
    androidVersion: preset.androidVersion,
    sdkInt,
    buildId: preset.build,
    buildFingerprint,
    androidId,
    imei,
    serial,
    wifiMac,
    screen,
    gpu,
  };
}
