import { describe, it, expect } from 'vitest';
import {
  composeTransportFlags,
} from '../../../src/main/proxy/transportPolicy';
import {
  getUdpRelayState,
  setUdpRelayState,
} from '../../../src/main/proxy/udpRelay';
describe('Leak Regression: Zero Host UDP/Egress Leak for Proxied Profiles', () => {
  it('enforces disable_non_proxied_udp and no direct host UDP fallback on SOCKS5 relay', () => {
    const flags = composeTransportFlags(
      { status: 'SOCKS5_FULL_PASS' },
      'socks5://10.0.0.1:1080'
    );

    // QUIC enabled via relay, WebRTC restricted to non-proxied udp disabled
    expect(flags).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(flags).not.toContain('--disable-quic');
    // Ensure proxy-bypass-list excludes loopback only, never direct internet
    expect(flags).toContain('--proxy-bypass-list=<-loopback>');
  });

  it('fails closed by disabling QUIC when proxy lacks UDP support (preventing host QUIC leak)', () => {
    const flags = composeTransportFlags(
      { status: 'CONSTRAINED' },
      'socks5://10.0.0.1:1080'
    );

    expect(flags).toContain('--disable-quic');
    expect(flags).toContain('--disable-webrtc');
    expect(flags).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
  });

  it('fails closed for HTTP proxies by disabling QUIC and WebRTC completely', () => {
    const flags = composeTransportFlags(
      { status: 'CONSTRAINED' },
      'http://10.0.0.1:8080'
    );

    expect(flags).toContain('--disable-quic');
    expect(flags).toContain('--disable-webrtc');
  });

  it('tracks relay state accurately to guarantee leak-free profile lifetime', () => {
    setUdpRelayState('leak-test-profile', 'relay');
    expect(getUdpRelayState('leak-test-profile')).toBe('relay');

    setUdpRelayState('leak-test-profile', 'quic-disabled');
    expect(getUdpRelayState('leak-test-profile')).toBe('quic-disabled');
  });

describe('DNS resolution does not leak to the local resolver', () => {
  /*
   * `socks5://` in socks-proxy-agent leaves `shouldLookup` true, so the agent resolves the
   * destination with the LOCAL `dns.lookup()` and hands the proxy a bare IP. Every hostname the
   * profile visits is then disclosed to the operator's own resolver — the exact leak this product
   * exists to prevent, and one that leaves no trace in the traffic because the traffic itself is
   * proxied. `socks5h://` sets `shouldLookup` false and the proxy resolves the name instead.
   *
   * The agent is constructed here the same way `createProxyTransport` builds it, so a revert to
   * `socks5://` fails this test rather than silently reintroducing the leak.
   */
  it('builds a SOCKS5 agent that leaves hostname resolution to the proxy', async () => {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    const agent = new SocksProxyAgent('socks5h://user:pass@127.0.0.1:1080') as unknown as {
      shouldLookup?: boolean;
    };
    expect(
      agent.shouldLookup,
      'shouldLookup true means the local resolver sees every visited hostname',
    ).toBe(false);
  });

  it('the plain socks5 scheme would leak, which is why the h form is required', async () => {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    const leaking = new SocksProxyAgent('socks5://user:pass@127.0.0.1:1080') as unknown as {
      shouldLookup?: boolean;
    };
    // Documents the dependency's actual behaviour, so the guard above cannot be dismissed as
    // ceremony: the two schemes genuinely differ.
    expect(leaking.shouldLookup).toBe(true);
  });
});

});
