# Child Interfaces — tls-ja4-limitation-record

Owner: `tls-ja4-limitation-record`

## Ownership Boundaries
- **Owned by this child**:
  - `scripts/probe-tls.ts`
  - `tests/unit/proxy/tlsLimitation.test.ts`
  - `docs/VALIDATION.md` (TLS section)
  - `docs/STEALTH_PARITY.md` (TLS note)
- **MUST NOT TOUCH**:
  - `src/main/proxy/transportPolicy.ts`
  - `src/main/proxy/udpRelay.ts`
  - `src/main/launcher/chromium.ts` (flag matrix)
  - `src/main/proxy/stealthInjection.ts`
  - `src/main/fingerprints/fonts.ts`

## Exported Signatures and Contracts
```ts
// scripts/probe-tls.ts
export const KNOWN_CHROMIUM_JA4 = 't13d1516h2_8daaf6152771_d8a2da3f94cd';

export interface PeetResult {
  ja3?: string;
  ja3_hash?: string;
  ja4?: string;
  user_agent?: string;
  tls?: { ja4?: string };
}

export interface TlsVerdictResult {
  verdict: 'identical' | 'differ' | 'skipped' | 'failed';
  limitationConfirmed: boolean;
  exitCode: number;
  summary: string;
}

export interface ParsedTlsVerdict {
  chromiumJa4?: string | null;
  firefoxJa4?: string | null;
  verdict: 'identical' | 'differ' | 'skipped' | 'failed';
  limitationConfirmed: boolean;
  exitCode: number;
}

export function evaluateTlsVerdict(
  chromiumJa4: string | null | undefined,
  firefoxJa4: string | null | undefined
): TlsVerdictResult;

export function parseTlsVerdict(output: string): ParsedTlsVerdict;

export function formatTlsVerdict(
  chromiumJa4: string | null | undefined,
  firefoxJa4: string | null | undefined,
  verdictResult: TlsVerdictResult
): string;
```
