# Child Interfaces — quic-webrtc-fail-closed

Owner: `quic-webrtc-fail-closed`

## Ownership Boundaries
- **Owned by this child**:
  - `src/main/proxy/transportPolicy.ts`
  - `src/main/proxy/udpRelay.ts`
  - `src/main/launcher/chromium.ts` (transport-flag composition and deduplication wiring)
  - `src/main/diagnostics/networkDiagnostics.ts` (relay_state surface in DiagnosticsReport)
  - `docs/VALIDATION.md` (QUIC posture section)
  - `tests/unit/proxy/quicFailClosed.test.ts`
- **MUST NOT TOUCH** (reserved for subsequent children):
  - `src/main/proxy/stealthInjection.ts` (font block)
  - `src/main/fingerprints/fonts.ts`
  - `src/main/proxy/stealthNoise.ts`
  - `scripts/probe-tls.ts`

## Exported Signatures and Contracts
```ts
// transportPolicy.ts
export function composeTransportFlags(
  result: TransportProbeResult | { status: TransportPolicyStatus },
  proxyServer?: string
): string[];

export async function probeTransportTarget(
  target: TransportProbeTarget,
  options?: { bypassCache?: boolean; timeoutMs?: number }
): Promise<TransportProbeResult>;

// udpRelay.ts
export type UdpRelayState = 'relay' | 'quic-disabled' | 'unavailable';
export function getUdpRelayState(profileId: string): UdpRelayState;
export function registerUdpRelayState(profileId: string, state: UdpRelayState): void;
export function unregisterUdpRelayState(profileId: string): void;

// networkDiagnostics.ts
export interface DiagnosticsReport {
  // ... existing fields ...
  relay_state?: UdpRelayState;
}
```
