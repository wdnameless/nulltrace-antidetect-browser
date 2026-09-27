/**
 * Build the outbound agent a proxy check dials through, plus the SSH tunnel that backs it.
 *
 * `checkProxy` and `checkSingleProxyHealth` each need exactly this, and each had grown its own
 * copy. The copies had already drifted — one cast to `http.Agent`, the other to `Agent`, and only
 * one of them routed the credentials through a single local — so a fix applied to one could
 * silently miss the other. One builder instead of two.
 *
 * The TARGET HOST is a parameter, deliberately. `checkProxy` resolves a hostname through local DNS
 * and rewrites a private answer to its public address, so a poisoned local resolver cannot decide
 * where the check goes; `checkSingleProxyHealth` does not. That difference is a rule about the
 * caller, not about building an agent, so it stays at the call site rather than becoming a
 * behaviour both share by accident.
 */
import type { Agent } from 'http';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { createSshTunnel, type SshTunnel } from './sshTunnel';
import { revealSecret } from '../util/secretStore';

/** The fields of a proxy row the transport actually reads. Structural, so `ProxyRow` fits. */
export interface ProxyTransportInput {
  type: 'http' | 'https' | 'socks5' | 'ssh';
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  private_key: string | null;
}

export interface ProxyTransport {
  /** Undefined only for an `ssh` proxy whose tunnel could not be established. */
  agent: Agent | undefined;
  /** Set for `ssh` proxies; the caller owns it and must close it. */
  tunnel: SshTunnel | undefined;
}

export async function createProxyTransport(
  proxy: ProxyTransportInput,
  targetHost: string
): Promise<ProxyTransport> {
  if (proxy.type === 'ssh') {
    const tunnel = await createSshTunnel({
      host: targetHost,
      port: proxy.port,
      username: proxy.username ?? undefined,
      password: revealSecret(proxy.password),
      privateKey: revealSecret(proxy.private_key),
    });
    // SAFETY: SocksProxyAgent implements the http.Agent interface; the cast is only here because
    // the two packages type it against their own bundled `http` typings.
    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${tunnel.port}`) as unknown as Agent;
    return { agent, tunnel };
  }

  // The credentials are revealed ONCE. Building the auth string from `revealSecret` calls inlined
  // in the template spent a decrypt per call and left two shapes of the same expression; one local
  // is the single place a redaction bug could live.
  const password = revealSecret(proxy.password) ?? '';
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(password)}@`
    : '';

  if (proxy.type === 'socks5') {
    /*
     * `socks5h`, not `socks5` — the difference is WHO resolves the hostname.
     *
     * In `socks-proxy-agent` the scheme sets `shouldLookup`: `socks5` leaves it true, so the agent
     * calls the local `dns.lookup()` and hands the proxy a bare IP. Every hostname the profile
     * visits is therefore resolved by the OPERATOR'S OWN resolver, which is precisely the leak an
     * antidetect browser exists to prevent — the destination domain is disclosed to the ISP even
     * though the traffic itself travels through the proxy. `socks5h` sets it false and the proxy
     * resolves the name, so the local resolver never sees it.
     *
     * Verified against the installed dependency rather than assumed: node_modules/socks-proxy-agent
     * maps `case 'socks5': lookup = true` and `case 'socks5h':` with no assignment, and its
     * callback branches on `if (shouldLookup)` before calling dns.lookup.
     */
    // SAFETY: as above — SocksProxyAgent satisfies the http.Agent contract at runtime.
    return { agent: new SocksProxyAgent(`socks5h://${auth}${targetHost}:${proxy.port}`) as unknown as Agent, tunnel: undefined };
  }
  // http / https
  // SAFETY: as above — HttpProxyAgent satisfies the http.Agent contract at runtime.
  return { agent: new HttpProxyAgent(`http://${auth}${targetHost}:${proxy.port}`) as unknown as Agent, tunnel: undefined };
}
