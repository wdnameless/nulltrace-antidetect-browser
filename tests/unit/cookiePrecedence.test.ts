// The live Chromium cookie jar is the source of truth; `cookies_json` is only a sync snapshot.
//
// Measured defect this guards: every profile start replayed `cookies_json` over CDP AFTER
// Chromium had already loaded the on-disk jar. A login made in the window was therefore
// overwritten by the older snapshot on the next launch — the operator saw Google bounce to
// `accounts.google.com` on a profile that was logged in minutes earlier, and blamed the agent.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const LAUNCHER = path.resolve(__dirname, '../../src/main/launcher/chromium.ts');

/** The block that decides whether stored cookies are replayed at launch. */
function injectionBlock(): string {
  const source = fs.readFileSync(LAUNCHER, 'utf8');
  const start = source.indexOf('const hasLiveCookieStore');
  expect(start, 'the launch-time cookie decision must exist').toBeGreaterThan(-1);
  return source.slice(start, start + 400);
}

describe('launch-time cookie precedence', () => {
  it('does not replay the snapshot when the profile already has a live cookie store', () => {
    const block = injectionBlock();
    expect(block).toContain('fs.existsSync(getProfileCookiesPath(cfg.userDataDir))');
    // The live store must short-circuit the replay, not merely filter it.
    expect(block).toMatch(/hasLiveCookieStore\s*\n?\s*\?\s*\[\]/);
  });

  it('still seeds a profile that has no on-disk cookie store', () => {
    // Fresh / transferred / token-login profiles have no Cookies DB yet, and the snapshot is
    // the only way their session gets in.
    const block = injectionBlock();
    expect(block).toContain('cfg.cookies');
    expect(block).toMatch(/injectCookies\(wsPuppeteer, validCookies\)/);
  });

  it('never injects a cookie with an empty value', () => {
    const block = injectionBlock();
    expect(block).toContain("typeof c.value === 'string' && c.value.trim().length > 0");
  });
});
