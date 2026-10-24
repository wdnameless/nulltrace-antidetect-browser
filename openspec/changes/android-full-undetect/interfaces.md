# Interfaces — android-full-undetect

Cross-slice contracts fixed up front (Wave 2). Owners: fixer (backend),
designer (UI). One owner per file; writers isolated.

## A. Mixed fingerprint (owner: fixer)

```ts
// android_config JSON additions (all optional; absent = seed-derived mix)
interface AndroidMixConfig {
  mixSeed?: number;      // separate stream for cross-preset draws; else profile seed
  modelPreset?: string;  // pin Build model/manufacturer/device/fingerprint source
  screenPreset?: string; // pin screen W/H/density source
  gpuPreset?: string;    // pin GPU renderer/vendor source
  buildPreset?: string;  // pin build id/version/sdk source
  identityEpoch?: number;// bump to rotate android_id/imei/serial/mac (rotation)
  locale?: string;       // e.g. de-DE; else geo-mapped from proxy country_code
  mccMnc?: string;       // e.g. 26201; else geo-mapped
}
```

`generateAndroidFingerprint(profileId, seed, presetId?, mix?)` gains optional
mix; default derives cross-preset draws from `mixSeed ?? seed` (deterministic,
stable across launches until epoch bump). `ResolvedAndroidConfig` gains
`locale`, `mccMnc`, `operatorAlpha`.

## B. Rotation (owner: fixer serves, designer calls)

- `POST /api/v1/android/profiles/:id/rotate` → bumps `identityEpoch`,
  re-injects android_id/serials on the live guest if running (no reboot),
  returns new ids. 409 when idle? No — rotation persists for next boot too.
- Card button "Rotate identity" + confirm; shows new android_id tail.

## C. Geo link (owner: fixer)

- `config.ts` queries `proxies.country_code`; mapping table
  `countryCode → { locale, mccMnc, operatorAlpha }` (top ~40 mobile markets +
  fallback `en-US/310260`); explicit `locale`/`mccMnc` keys win over mapping.
- Injector writes `persist.sys.locale`, `gsm.sim.operator.numeric`,
  `gsm.sim.operator.alpha`, `gsm.operator.numeric` (all settable, read-back).

## D. Spoof deepening (owner: fixer)

- `presetId` plumbed `launchAndroidProfile → startAndroidProfile →
  startGuestServices` (no more re-derive without preset).
- Overlay: `/product` remount runs at most once per AVD signature (cached
  marker file); normal launch skips when marker matches (no per-launch cost).
- `setprop --delete` replaced by working clear (root `resetprop`-equivalent
  via overlay file edit or documented skip with reason — never a throw that
  aborts the pipeline).
- `InjectResult` gains `mixedFrom: string[]` (preset ids used) for honesty.

## E. Direct NAT (owner: fixer)

- `planGuestNetwork(null)` returns `{ blocked: false, directNat: true }`
  unless profile opts into blocking (`android_config.blockNetwork === true`).
- `setupGuestNetwork` leaves SLIRP NAT up, verifies egress (`ping -c1`
  gateway), reports `proxied: false, directNat: true` in status.

## F. UI (owner: designer)

- Card Android section: mix pins (4 preset selects, default Auto=mixed),
  locale + MCC/MNC inputs (default Auto=geo), Rotate button, spoof posture
  line (from status.inject: privilege + mixedFrom tails). No new page.
