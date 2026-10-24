import { describe, it, expect } from 'vitest';
import { geoIdentityFor, GEO_IDENTITY_TABLE } from '../../src/main/android/geoIdentity';
import { planGuestNetwork } from '../../src/main/android/network';

describe('geo identity mapping (interfaces §C)', () => {
  it('maps a German proxy country to de-DE + a 262 MNC + Berlin', () => {
    const geo = geoIdentityFor('DE');
    expect(geo.locale).toBe('de-DE');
    expect(geo.mccMnc.startsWith('262')).toBe(true);
    expect(geo.timezone).toBe('Europe/Berlin');
    expect(geo.operatorAlpha.length).toBeGreaterThan(0);
  });

  it('is case-insensitive and trims', () => {
    expect(geoIdentityFor(' de ')).toEqual(geoIdentityFor('DE'));
  });

  it('falls back to a neutral US identity for unknown or absent countries', () => {
    for (const value of [null, undefined, '', 'ZZ']) {
      const geo = geoIdentityFor(value as string | null | undefined);
      expect(geo.locale).toBe('en-US');
      expect(geo.mccMnc).toBe('310260');
    }
  });

  it('keeps every row well-formed (locale BCP-47-ish, MCC 3 digits, IANA zone)', () => {
    for (const [country, geo] of Object.entries(GEO_IDENTITY_TABLE)) {
      expect(geo.locale, `${country} locale`).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(geo.mccMnc, `${country} mcc`).toMatch(/^\d{5,6}$/);
      expect(geo.timezone, `${country} tz`).toMatch(/^[A-Za-z]+\/[A-Za-z_+\-0-9/]+$/);
      expect(geo.operatorAlpha.length, `${country} operator`).toBeGreaterThan(1);
    }
  });
});

describe('guest network plan (R07 direct NAT)', () => {
  it('keeps a proxy-less guest online by default (direct NAT)', () => {
    const plan = planGuestNetwork(null);
    expect(plan.blocked).toBe(false);
    expect(plan.directNat).toBe(true);
  });

  it('still fails closed when the profile opts into blocking', () => {
    const plan = planGuestNetwork(null, { blockNetwork: true });
    expect(plan.blocked).toBe(true);
    expect(plan.directNat).toBe(false);
  });

  it('routes a proxied profile through the SOCKS bridge, never blocked', () => {
    const plan = planGuestNetwork({ type: 'socks5', host: '1.2.3.4', port: 1080 });
    expect(plan.blocked).toBe(false);
    expect(plan.directNat).toBeUndefined();
    expect(plan.proxy?.host).toBe('1.2.3.4');
  });

  it('keeps the legacy single-argument call shape working', () => {
    expect(() => planGuestNetwork(null)).not.toThrow();
  });
});
