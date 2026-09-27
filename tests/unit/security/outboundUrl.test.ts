import { describe, it, expect } from 'vitest';
import { assertPublicHttpUrl } from '../../../src/main/util/outboundUrl';

/*
 * Two routes fetch a caller-supplied URL server-side: the script catalog and the cloud connect.
 * Both accepted any address the machine could reach, and this backend also serves GET /ui/key —
 * which returns the automation API key and skips its same-origin guard when no Origin header is
 * sent, as a server-side fetch does. Measured before this guard existed, that pairing returned the
 * live key inside the response body of a single authenticated call.
 */
describe('outbound URL policy', () => {
  it.each([
    ['http://127.0.0.1:50325/ui/key', 'loopback would let the key be read back'],
    ['http://localhost:50325/ui/key', 'the loopback name, which avoids a literal IP'],
    ['http://[::1]:50325/', 'IPv6 loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud instance metadata'],
    ['http://10.0.0.5/', 'RFC1918 class A'],
    ['http://192.168.1.1/', 'RFC1918 class C'],
    ['http://172.16.0.1/', 'RFC1918 class B'],
    ['http://100.64.0.1/', 'CGNAT range'],
    ['http://user:pass@example.com/', 'embedded credentials leak to the target and to logs'],
    ['file:///etc/passwd', 'a non-web scheme'],
    ['ftp://example.com/x', 'a non-web scheme'],
    ['not-a-url', 'not a URL at all'],
  ])('refuses %s (%s)', async (url) => {
    const result = await assertPublicHttpUrl(url);
    expect(result.ok, `${url} must not be dialable`).toBe(false);
  });

  it('refuses a public NAME that resolves to a private address', () => {
    // The whole reason a scheme check is not enough: every one of these passes a textual scan.
    return assertPublicHttpUrl('http://127.0.0.1.nip.io/').then((r) => {
      expect(r.ok, 'a resolving name is the gap a string check leaves open').toBe(false);
    });
  });

  it('still allows an ordinary public https URL', async () => {
    const result = await assertPublicHttpUrl('https://example.com/');
    expect(result.ok, 'the guard must not break the feature it protects').toBe(true);
  });

  describe('obfuscated loopback forms are refused', () => {
    /*
     * These were REAL bypasses in the first version of this guard, found by attacking it with
     * obfuscated addresses rather than by reading it: `::ffff:127.0.0.1` (IPv4-mapped IPv6 — the OS
     * routes it to the v4 stack), `0.0.0.0` (unspecified; routes to localhost on Linux) and `::`
     * (unspecified v6) all passed, while every plainly-written private address was refused. A guard
     * that stops the spelled-out form and not these is worth very little, because an attacker picks
     * the form that works.
     */
    it.each([
      ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6 loopback'],
      ['http://[::ffff:7f00:1]/', 'the hex form of IPv4-mapped loopback'],
      ['http://0.0.0.0/', 'unspecified v4, routes to localhost on Linux'],
      ['http://[::]/', 'unspecified v6'],
      ['http://0.1.2.3/', 'the whole 0/8 block'],
      ['http://2130706433/', 'decimal-encoded loopback'],
      ['http://0177.0.0.1/', 'octal-encoded loopback'],
      ['http://0x7f000001/', 'hex-encoded loopback'],
      ['http://127.1/', 'short-form loopback'],
      ['http://127.0.0.1./', 'trailing dot'],
      ['http://example.com@127.0.0.1/', 'userinfo masking the real host'],
      ['http://[fe80::1]/', 'IPv6 link-local'],
      ['http://[fd00::1]/', 'IPv6 unique-local'],
      ['http://198.18.0.1/', 'benchmarking range'],
      ['http://240.0.0.1/', 'reserved range'],
      ['http://255.255.255.255/', 'broadcast'],
      ['http://192.0.0.1/', 'IETF protocol assignments'],
    ])('refuses %s (%s)', async (url) => {
      const result = await assertPublicHttpUrl(url);
      expect(result.ok, `${url} must not be dialable`).toBe(false);
    });
  });

  describe('ordinary public URLs still pass', () => {
    // A guard that breaks the feature it protects is also a defect, so the allowed direction is
    // pinned too — these are the hosts the two routes legitimately talk to.
    it.each([
      'https://github.com/',
      'https://example.com/x',
      'https://raw.githubusercontent.com/a/b',
      'https://objects.githubusercontent.com/x',
      'https://s3.amazonaws.com/x',
    ])('allows %s', async (url) => {
      const result = await assertPublicHttpUrl(url);
      expect(result.ok, `${url} must remain usable`).toBe(true);
    });
  });

});
