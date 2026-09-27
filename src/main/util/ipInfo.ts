// Egress-IP info helpers (ip-api.com). Used to keep timezone coherent with the IP.
import fetch from 'node-fetch';

let cachedTimezone: string | null = null;

/** Detect the machine's timezone from its egress IP (cached). */
export async function detectMachineTimezone(): Promise<string | null> {
  if (cachedTimezone) return cachedTimezone;
  try {
    const res = await fetch('http://ip-api.com/json/?fields=timezone', { timeout: 5000 });
    const body = (await res.json()) as { timezone?: string };
    if (body.timezone) cachedTimezone = body.timezone;
    return cachedTimezone;
  } catch {
    return null;
  }
}

/**
 * True for an address that cannot host a public service.
 *
 * Shared rather than local because two callers now need the same answer for different reasons: the
 * network diagnostic asks whether an ICE candidate leaked a usable address, and the proxy check
 * asks whether a proxy hostname resolved somewhere it could never be reached. A second hand-rolled
 * copy of this list is how the two drift — one accepting CGNAT, the other not.
 *
 * Covers RFC1918, loopback, link-local, CGNAT (RFC6598) and the IPv6 equivalents.
 */
export function isPrivateOrLocal(ip: string): boolean {
  let value = String(ip || '').trim().toLowerCase();
  if (!value) return true;

  // Strip a zone index (`fe80::1%eth0`) before matching.
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  /*
   * Unwrap an IPv4-MAPPED IPv6 address before anything else.
   *
   * `::ffff:127.0.0.1` (and the hex form `::ffff:7f00:1`) IS loopback — the OS routes it to the v4
   * stack — but it matches none of the v4 or v6 patterns below, so a caller could reach every
   * private address the rest of this function refuses. Found by attacking the guard with exactly
   * that input after the first version passed a simpler test set.
   */
  const mapped = value.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrLocal(mapped[1]);
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
    return isPrivateOrLocal(dotted);
  }

  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    // `0.0.0.0` is the unspecified address; on Linux it routes to localhost, and it is never a
    // legitimate destination for a caller-supplied URL. Also covers the whole 0/8 block.
    if (a === 0) return true;
    // 192.0.0.0/24 (IETF protocol assignments) and 198.18.0.0/15 (benchmarking) are not routable.
    if (a === 192 && b === 0 && Number(v4[3]) === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 240/4 is reserved, and 255.255.255.255 is broadcast.
    if (a >= 240) return true;
    return false;
  }

  // IPv6 forms.
  if (value === '::' || value === '::0') return true; // unspecified
  if (value === '::1') return true; // loopback
  if (value.startsWith('fe80:')) return true; // link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique-local
  return false;
}
