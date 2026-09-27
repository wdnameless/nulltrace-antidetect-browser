import { describe, it, expect } from 'vitest';
import { probeTransportTarget } from '../../../src/main/proxy/transportPolicy';

describe('Transport probe timeout and bypass resilience', () => {
  it('probeTransportTarget supports custom timeoutMs and rejects unreachable host without hanging', async () => {
    const started = Date.now();
    // Probe a non-routable test IP with a small timeout
    const result = await probeTransportTarget(
      {
        protocol: 'http',
        host: '192.0.2.1', // TEST-NET-1 (non-routable)
        port: 8080,
      },
      { timeoutMs: 500, bypassCache: true }
    );
    const elapsed = Date.now() - started;

    expect(result.status).toBe('REFUSE');
    expect(result.error?.stage).toBe('tcpConnect');
    expect(elapsed).toBeLessThan(3000);
  });
});
