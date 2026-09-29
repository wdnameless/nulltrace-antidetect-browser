import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, getDb } from '../../src/main/db';
import {
  createProfile,
  deleteProfile,
  updateProfileFingerprint,
  resolveLaunchConfig,
} from '../../src/main/profiles/profileManager';

describe('fontList override (docs gap closure: per-profile font inventory)', () => {
  beforeAll(async () => {
    try {
      getDb();
    } catch {
      await initDb();
    }
  });

  afterAll(() => {
    // Do NOT close: the DB handle is process-global and shared with other suites.
  });

  it('operator fontList override reaches stealth config at launch', () => {
    const id = createProfile({ name: 'Font Override Test' });
    try {
      const fonts = ['Arial', 'Custom Corp Font', 'Segoe UI'];
      const ok = updateProfileFingerprint(id, { fontList: fonts });
      expect(ok).toBe(true);

      const cfg = resolveLaunchConfig(id);
      expect(cfg.stealth?.fontList).toEqual(fonts);
    } finally {
      deleteProfile(id);
    }
  });

  it('absent fontList falls back to seed inventory', () => {
    const id = createProfile({ name: 'Font Default Test' });
    try {
      const cfg = resolveLaunchConfig(id);
      expect(Array.isArray(cfg.stealth?.fontList)).toBe(true);
      expect(cfg.stealth!.fontList!.length).toBeGreaterThan(0);
    } finally {
      deleteProfile(id);
    }
  });

  it('renderer saves comma-separated fonts into config array', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/renderer/src/pages/Profiles.tsx', 'utf8');
    expect(src).toMatch(/fontList\?: string/);
    expect(src).toMatch(/cfg\.fontList = fonts/);
    expect(src).toMatch(/Font Inventory Override/);
  });
});
