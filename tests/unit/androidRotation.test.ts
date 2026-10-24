import { describe, it, expect } from 'vitest';
import { generateAndroidFingerprint } from '../../src/main/android/fingerprint';

describe('Android identity rotation (interfaces §B, R03)', () => {
  it('changes every per-install identifier while keeping the device shape', () => {
    const base = generateAndroidFingerprint('profile-rot-1', 424242, 'pixel_7', 0);
    const rotated = generateAndroidFingerprint('profile-rot-1', 424242, 'pixel_7', 1);

    // Stable: still the same phone.
    expect(rotated.presetId).toBe(base.presetId);
    expect(rotated.model).toBe(base.model);
    expect(rotated.buildFingerprint).toBe(base.buildFingerprint);
    expect(rotated.screen).toEqual(base.screen);

    // Rotated: every per-install identifier is new.
    expect(rotated.androidId).not.toBe(base.androidId);
    expect(rotated.imei).not.toBe(base.imei);
    expect(rotated.serial).not.toBe(base.serial);
    expect(rotated.wifiMac).not.toBe(base.wifiMac);
  });

  it('is reproducible for a given epoch, so a restart does not silently re-roll', () => {
    const a = generateAndroidFingerprint('profile-rot-2', 99, 'pixel_8', 3);
    const b = generateAndroidFingerprint('profile-rot-2', 99, 'pixel_8', 3);
    expect(a).toEqual(b);
  });

  it('epoch 0 is byte-identical to the pre-rotation derivation', () => {
    const legacy = generateAndroidFingerprint('profile-rot-3', 1234, 'pixel_7');
    const epochZero = generateAndroidFingerprint('profile-rot-3', 1234, 'pixel_7', 0);
    expect(epochZero).toEqual(legacy);
  });

  it('different epochs for one profile all differ from each other', () => {
    const ids = [0, 1, 2, 3].map((e) => generateAndroidFingerprint('profile-rot-4', 7, 'pixel_7', e).androidId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
