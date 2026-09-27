import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CountryFlag, COUNTRY_FLAGS, hasFlag } from '../../src/renderer/src/countryFlag';

describe('CountryFlag component', () => {
  it('renders SVG for operator screenshot countries (PL, GB, US, AU)', () => {
    for (const code of ['PL', 'GB', 'US', 'AU']) {
      expect(hasFlag(code), `${code} must be defined in COUNTRY_FLAGS`).toBe(true);
      const html = renderToStaticMarkup(React.createElement(CountryFlag, { code, height: 12 }));
      expect(html).toContain('<svg');
      expect(html).toContain(`aria-label="${code}"`);
      expect(html).toContain('viewBox="0 0 3 2"');
    }
  });

  it('renders nothing for null, undefined, empty or malformed codes', () => {
    for (const bad of [null, undefined, '', '   ', 'USA', 'Germany', '12', 'P']) {
      expect(hasFlag(bad as any)).toBe(false);
      const html = renderToStaticMarkup(React.createElement(CountryFlag, { code: bad as any }));
      expect(html).toBe('');
    }
  });

  it('handles lowercase codes cleanly by normalising', () => {
    expect(hasFlag('pl')).toBe(true);
    const html = renderToStaticMarkup(React.createElement(CountryFlag, { code: 'pl', height: 14 }));
    expect(html).toContain('aria-label="PL"');
  });

  it('renders all 113 catalog flags non-empty', () => {
    const codes = Object.keys(COUNTRY_FLAGS);
    expect(codes.length).toBeGreaterThanOrEqual(110);
    for (const code of codes) {
      const html = renderToStaticMarkup(React.createElement(CountryFlag, { code }));
      expect(html.length, `Flag ${code} should not render empty HTML`).toBeGreaterThan(40);
    }
  });
});
