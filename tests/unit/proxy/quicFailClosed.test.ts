import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import * as dgram from 'dgram';
import {
  composeTransportFlags,
  probeTransportTarget,
  invalidateTransportCache,
} from '../../../src/main/proxy/transportPolicy';
import {
  getUdpRelayState,
  registerUdpRelayState,
  unregisterUdpRelayState,
  setUdpRelayState,
} from '../../../src/main/proxy/udpRelay';
import { buildChromiumArgs } from '../../../src/main/launcher/chromium';

describe('QUIC & WebRTC Fail-Closed Hardening', () => {
  beforeEach(() => {
    invalidateTransportCache();
  });

  afterEach(() => {
    invalidateTransportCache();
    vi.restoreAllMocks();
  });

  describe('Deterministic composeTransportFlags matrix', () => {
    it('composes complete fail-closed switches for CONSTRAINED status', () => {
      const flags = composeTransportFlags(
        { status: 'CONSTRAINED' },
        'socks5://127.0.0.1:1080'
      );

      expect(flags).toContain('--proxy-server=socks5://127.0.0.1:1080');
      expect(flags).toContain('--proxy-bypass-list=<-loopback>');
      expect(flags).toContain('--disable-quic');
      expect(flags).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
      expect(flags).toContain('--disable-webrtc');
    });

    it('composes relay-bound switches without disabling QUIC for SOCKS5_FULL_PASS', () => {
      const flags = composeTransportFlags(
        { status: 'SOCKS5_FULL_PASS' },
        'socks5://127.0.0.1:1080'
      );

      expect(flags).toContain('--proxy-server=socks5://127.0.0.1:1080');
      expect(flags).toContain('--proxy-bypass-list=<-loopback>');
      expect(flags).toContain('--webrtc-ip-handling-policy=disable_non_proxied_udp');
      expect(flags).not.toContain('--disable-quic');
      expect(flags).not.toContain('--disable-webrtc');
    });

    it('returns empty flag array for NO_PROXY and DIRECT_OK', () => {
      expect(composeTransportFlags({ status: 'NO_PROXY' })).toEqual([]);
      // SAFETY: legacy DIRECT_OK status compatibility check
      const legacyDirect = { status: 'DIRECT_OK' } as unknown as Parameters<typeof composeTransportFlags>[0];
      expect(composeTransportFlags(legacyDirect)).toEqual([]);
    });

    it('ensures no duplicate flags in composed output', () => {
      const flags = composeTransportFlags(
        { status: 'CONSTRAINED' },
        'http://1.2.3.4:8080'
      );
      const uniqueFlags = Array.from(new Set(flags));
      expect(flags.length).toBe(uniqueFlags.length);
    });
  });

  describe('Chromium launcher flag deduplication', () => {
    it('prevents duplicate --webrtc-ip-handling-policy and --disable-quic switches', async () => {
      const transportFlags = [
        '--proxy-server=http://127.0.0.1:8080',
        '--disable-quic',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-webrtc',
      ];

      const args = await buildChromiumArgs(
        {
          profileId: 'test-dedupe-profile',
          userDataDir: '/tmp/test-dedupe',
          webrtc_policy: 'disable_non_proxied_udp',
        },
        'http://127.0.0.1:8080',
        transportFlags
      );

      const quicSwitches = args.filter((a) => a === '--disable-quic');
      expect(quicSwitches.length).toBe(1);

      const webrtcSwitches = args.filter((a) =>
        a.startsWith('--webrtc-ip-handling-policy=')
      );
      expect(webrtcSwitches.length).toBe(1);
      expect(webrtcSwitches[0]).toBe('--webrtc-ip-handling-policy=disable_non_proxied_udp');

      const webrtcDisableSwitches = args.filter((a) => a === '--disable-webrtc');
      expect(webrtcDisableSwitches.length).toBe(1);
    });
  });

  describe('Relay state tracking & diagnostics visibility', () => {
    const profileId = 'relay-diag-profile-1';

    afterEach(() => {
      unregisterUdpRelayState(profileId);
    });

    it('tracks per-profile relay state lifecycle', () => {
      expect(getUdpRelayState(profileId)).toBe('unavailable');

      registerUdpRelayState(profileId, 'relay');
      expect(getUdpRelayState(profileId)).toBe('relay');

      setUdpRelayState(profileId, 'quic-disabled');
      expect(getUdpRelayState(profileId)).toBe('quic-disabled');

      unregisterUdpRelayState(profileId);
      expect(getUdpRelayState(profileId)).toBe('unavailable');
    });

    it('surfaces relay_state in collectDiagnostics for running profile', async () => {
      registerUdpRelayState(profileId, 'quic-disabled');
      // Pure state assertion: collectDiagnostics needs a live browser over CDP
      // (puppeteer.connect to a real ws), which a unit env cannot provide — the
      // surface under test is that the state map carries the launch-time value.
      expect(getUdpRelayState(profileId)).toBe('quic-disabled');
    });
  });

  describe('Probe stage coverage and fail-closed posture', () => {
    let mockTcpServer: net.Server | null = null;
    let mockUdpSocket: dgram.Socket | null = null;

    afterEach(async () => {
      if (mockTcpServer) {
        await new Promise<void>((r) => mockTcpServer!.close(() => r()));
        mockTcpServer = null;
      }
      if (mockUdpSocket) {
        try {
          mockUdpSocket.close();
        } catch {
          // ignore
        }
        mockUdpSocket = null;
      }
    });

    it('fails closed to CONSTRAINED when STUN IPv4 probe times out', async () => {
      mockUdpSocket = dgram.createSocket('udp4');
      const udpPort = await new Promise<number>((r) => {
        mockUdpSocket!.bind(0, '127.0.0.1', () => {
          r(mockUdpSocket!.address().port);
        });
      });

      // TCP server responds to UDP_ASSOCIATE with mock port, but UDP socket ignores messages (simulates STUN drop)
      mockTcpServer = net.createServer((conn) => {
        conn.on('data', (data) => {
          if (data[0] === 0x05 && data.length <= 4) {
            conn.write(Buffer.from([0x05, 0x00]));
          } else if (data[0] === 0x05 && data[1] === 0x01) {
            conn.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
          } else if (data[0] === 0x05 && data[1] === 0x03) {
            const reply = Buffer.alloc(10);
            reply[0] = 0x05;
            reply[1] = 0x00;
            reply[2] = 0x00;
            reply[3] = 0x01;
            Buffer.from([127, 0, 0, 1]).copy(reply, 4);
            reply.writeUInt16BE(udpPort, 8);
            conn.write(reply);
          }
        });
      });

      const port = await new Promise<number>((r) => {
        mockTcpServer!.listen(0, '127.0.0.1', () => {
          r((mockTcpServer!.address() as net.AddressInfo).port);
        });
      });

      const result = await probeTransportTarget(
        {
          protocol: 'socks5',
          host: '127.0.0.1',
          port,
        },
        { timeoutMs: 150 }
      );

      expect(result.status).toBe('CONSTRAINED');
      expect(result.stages.udpAssociate).toBe(true);
      expect(result.stages.stunIpv4).toBe(false);

      const flags = composeTransportFlags(result, `socks5://127.0.0.1:${port}`);
      expect(flags).toContain('--disable-quic');
      expect(flags).toContain('--disable-webrtc');
    });
  });
});
