# Child Interfaces — font-pinning-js-max

Owner: `font-pinning-js-max`

## Ownership Boundaries
- **Owned by this child**:
  - `src/main/proxy/stealthInjection.ts` (font block ~1394–1590 ONLY)
  - `src/main/fingerprints/fonts.ts`
  - `src/main/proxy/stealthNoise.ts` (voice pool `getSyntheticVoicePool` ONLY)
  - `tests/unit/stealth/fontPinning.test.ts`
  - `docs/STEALTH_PARITY.md` (dated font-pinning JS-max section)
- **MUST NOT TOUCH**:
  - `src/main/proxy/transportPolicy.ts`
  - `src/main/proxy/udpRelay.ts`
  - `src/main/launcher/chromium.ts` (flag matrix)
  - `scripts/probe-tls.ts`

## Exported Signatures and Contracts
```ts
// src/main/fingerprints/fonts.ts
export interface ResolvedFontConfig {
  inventory: string[];
  hiddenHostFonts: string[];
  fallbackFace: string;
}
export function resolveFontConfig(opts: StealthOptions): ResolvedFontConfig;

// src/main/proxy/stealthNoise.ts
export interface SyntheticVoice {
  default: boolean;
  lang: string;
  localService: boolean;
  name: string;
  voiceURI: string;
}
export function getSyntheticVoicePool(
  platform?: 'windows' | 'macos' | 'linux' | 'android' | 'ios',
  locale?: string
): SyntheticVoice[];

// src/main/proxy/stealthInjection.ts
export function buildStealthScript(opts: StealthOptions): string;
```
