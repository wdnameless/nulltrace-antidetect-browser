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
});
