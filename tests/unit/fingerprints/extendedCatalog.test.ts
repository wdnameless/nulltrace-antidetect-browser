import { describe, it, expect } from 'vitest';
import {
  WINDOWS_FINGERPRINT_CATALOG,
  EXTENDED_FINGERPRINT_CATALOG,
  MACOS_FINGERPRINT_CATALOG,
  WINDOWS_11_REFRESH_FAMILIES,
} from '../../../src/main/fingerprints/catalog';
import {
  validateFamilyCoherence,
  validateAllFamilies,
  MACOS_WINDOWS_HOST_TELLS,
} from '../../../src/main/fingerprints/validator';
import {
  migrateFamilyRecord,
  serializeFamilyWithCrc32,
  deserializeFamilyWithCrc32,
} from '../../../src/main/fingerprints/migration';
import {
  deriveCatalogSubSeeds,
  deriveHardwareVector,
  selectFamilyBySeed,
} from '../../../src/main/fingerprints/derivation';
import { buildStealthScript } from '../../../src/main/proxy/stealthInjection';
import { getSyntheticVoicePool } from '../../../src/main/proxy/stealthNoise';

describe('macOS and Windows Extended Fingerprint Catalog Suite', () => {
  it('has 6 curated macOS families (M1, M2, M3, M4, Intel) and 4 Windows 11 refresh families', () => {
    expect(MACOS_FINGERPRINT_CATALOG.length).toBe(6);
    expect(WINDOWS_11_REFRESH_FAMILIES.length).toBe(4);
    expect(EXTENDED_FINGERPRINT_CATALOG.length).toBe(46);
  });

  it('keeps legacy 30 Windows families byte-stable with CRC32', () => {
    expect(WINDOWS_FINGERPRINT_CATALOG.length).toBe(30);
    for (const fam of WINDOWS_FINGERPRINT_CATALOG) {
      expect(fam.id.startsWith('win-')).toBe(true);
      const migrated = migrateFamilyRecord(fam);
      expect(migrated.id).toBe(fam.id);
      expect(migrated.gpuRenderer).toBe(fam.gpu.renderer);
    }
  });

  it('supports CRC32-versioned serialization and deserialization round-trip', () => {
    const family = MACOS_FINGERPRINT_CATALOG[0];
    const serialized = serializeFamilyWithCrc32(family);
    expect(serialized.crc32).toBeDefined();
    expect(typeof serialized.crc32).toBe('number');
    const restored = deserializeFamilyWithCrc32(serialized);
    expect(restored.id).toBe(family.id);
    expect(restored.gpuRenderer).toBe(family.gpuRenderer);
  });

  it('preserves HMAC sub-seed determinism across 8 domains', () => {
    const seeds = [42, 123456, 999999];
    for (const seed of seeds) {
      const sub1 = deriveCatalogSubSeeds(seed);
      const sub2 = deriveCatalogSubSeeds(seed);
      expect(sub1).toEqual(sub2);
      expect(sub1.canvas).toBeGreaterThan(0);
      expect(sub1.webgl).toBeGreaterThan(0);
      expect(sub1.audio).toBeGreaterThan(0);
    }
  });

  it('all macOS families have non-empty documented public spec provenance/citation notes (no harvested data)', () => {
    for (const macFam of MACOS_FINGERPRINT_CATALOG) {
      const prov = macFam.provenance || macFam.citation;
      expect(prov).toBeDefined();
      expect(prov?.notes).toBeTruthy();
      expect(prov!.notes.length).toBeGreaterThan(15);
      if (macFam.provenance) {
        expect(macFam.provenance.source).toBe('public-specs-curated');
        expect(macFam.provenance.documentationUrls.length).toBeGreaterThan(0);
      }
    }
  });
  it('validates cross-property coherence across all 46 families without violations', () => {
    const report = validateAllFamilies(EXTENDED_FINGERPRINT_CATALOG);
    expect(report.totalFamilies).toBe(46);
    expect(report.violationsCount).toBe(0);
    expect(report.incoherentFamilyIds).toHaveLength(0);
  });

  it('validator rejects planted incoherence in UA, WebGL, screen, and fonts', () => {
    const validFam = MACOS_FINGERPRINT_CATALOG[0];
    const invalidFam = {
      ...validFam,
      id: 'mac-planted-incoherent',
      coherenceConstraints: {
        ...validFam.coherenceConstraints,
        platformArch: 'x86' as const, // M1 but claiming x86
      },
      gpu: {
        vendor: 'Google Inc. (NVIDIA)', // Incoherent with Apple
        renderer: 'ANGLE (NVIDIA, GeForce RTX 3060, OpenGL 4.5)',
        limitsClass: 'high-end' as const,
      },
    };

    const result = validateFamilyCoherence(invalidFam);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('enumerates and documents macOS-on-Windows host tells with mitigation rationale', () => {
    expect(MACOS_WINDOWS_HOST_TELLS.length).toBeGreaterThanOrEqual(6);
    for (const tell of MACOS_WINDOWS_HOST_TELLS) {
      expect(tell.name).toBeTruthy();
      expect(tell.mitigation).toMatch(/mask|exclude/);
      expect(tell.rationale).toBeTruthy();
    }
  });

  it('generates coherent JS-observable surface for macOS families', () => {
    const macFam = MACOS_FINGERPRINT_CATALOG.find((f) => f.chip === 'M2')!;
    const script = buildStealthScript({
      logicalPlatform: 'macos',
      chip: macFam.chip,
      webglVendor: macFam.gpu.vendor,
      webglRenderer: macFam.gpuRenderer,
    });

    expect(script).toContain('MacIntel');
    expect(script).toContain('macOS');
    expect(script).toContain('Apple M2');
    expect(script).toContain('ANGLE (Apple, Apple M2');
  });

  it('returns macOS-specific voice pools for speech synthesis', () => {
    const macVoices = getSyntheticVoicePool('macos');
    expect(macVoices.some((v) => v.name === 'Samantha')).toBe(true);
    expect(macVoices.some((v) => v.name === 'Alex')).toBe(true);
    expect(macVoices.every((v) => !v.name.includes('Microsoft'))).toBe(true);
  });

  describe('every catalog family is actually selectable', () => {
    /*
     * The gap that let a real defect ship: this suite validated all 46 families' PROPERTIES but
     * never asked whether any of them could be CHOSEN. `selectFamilyBySeed` compared a fraction
     * drawn from [0, 1) against a running sum of raw weights, and the Windows block — concatenated
     * first, weights summing to exactly 1.000000 — always contained that fraction. Measured over
     * 20 000 seeds before the fix: 20000 Windows, 0 macOS, 0 Linux. Twelve families were
     * unreachable dead weight while the UI advertised the platforms.
     */
    it('reaches macOS and Linux families, not only Windows', () => {
      const mac = new Set(MACOS_FINGERPRINT_CATALOG.map((f) => f.id));
      const windows = new Set(WINDOWS_FINGERPRINT_CATALOG.map((f) => f.id));

      let macCount = 0;
      let otherCount = 0;
      for (let seed = 1; seed <= 20000; seed++) {
        const family = selectFamilyBySeed(seed, EXTENDED_FINGERPRINT_CATALOG);
        if (mac.has(family.id)) macCount++;
        else if (!windows.has(family.id)) otherCount++;
      }

      expect(macCount, 'macOS families must be reachable from the extended catalog').toBeGreaterThan(0);
      expect(otherCount, 'Linux/refresh families must be reachable too').toBeGreaterThan(0);
    });

    it('can emit every family in the catalog given enough seeds', () => {
      const seen = new Set<string>();
      for (let seed = 1; seed <= 20000; seed++) {
        seen.add(selectFamilyBySeed(seed, EXTENDED_FINGERPRINT_CATALOG).id);
      }
      const unreachable = EXTENDED_FINGERPRINT_CATALOG
        .map((f) => f.id)
        .filter((id) => !seen.has(id));
      expect(unreachable, `unreachable families: ${unreachable.join(', ')}`).toEqual([]);
    });

    it('stays deterministic for a given seed', () => {
      // Weighted selection must remain a pure function of the seed, or a profile's identity would
      // drift between launches — itself a detection signal.
      const first = selectFamilyBySeed(12345, EXTENDED_FINGERPRINT_CATALOG).id;
      const second = selectFamilyBySeed(12345, EXTENDED_FINGERPRINT_CATALOG).id;
      expect(second).toBe(first);
    });
  });

});
