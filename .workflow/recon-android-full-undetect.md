# Recon — Android full undetect + data mixing (T2)

Wave 1 by 2 scout subagents (read-only) + parent spot-checks of every claim below.
Prior live audit: `.workflow/recon-android-undetectability.md` (15 measured signals).
User decisions (Wave 0 widget, 2026-10-24): target = apps-don't-flag (NOT Play Integrity);
mix = cross-preset + rotation-on-demand + geo-consistency; mechanism = deepen current
injector (no new deps, no Magisk); scope = undetect + fix offline guest network.

## Touched files (planned)

- Spoof core: `src/main/android/injector.ts:147-263` (propsToSet + artefacts; `setprop
  --delete` at :223 is invalid — resetprop syntax, throws on stock adb), `:303`
  privilege verdict; `src/main/android/deviceIdentity.ts:60-92` (`/product` overlay
  remount, bypassed on normal start — `prepareOnStart` falsy at `instance.ts:232`).
- Fingerprint/mix: `src/main/android/fingerprint.ts:162-213` (1:1 preset, no mixing),
  `src/main/android/config.ts:175` (`AndroidHwConfig` keys; geo query `:107` omits
  `country_code`), `src/main/android/instance.ts:302` (re-derives fingerprint WITHOUT
  presetId — wipes preset selection on launch; also `:677`).
- Network: `src/main/android/network.ts:91-100` (deliberate fail-closed offline policy
  for proxy-less profiles — R10, not a bug; needs explicit direct-NAT mode).
- Geo chain: `src/main/db/schema.ts:55-66` (`proxies` has country/country_code/city/
  timezone/lat/lon), `src/main/proxy/proxyManager.ts:173,463` (geo updates);
  locale unhandled anywhere; MCC/MNC absent anywhere (guest serves T-Mobile/310260).
- UI/API: `src/renderer/src/pages/Profiles.tsx` (card: rotate button + mix fields),
  `src/main/api/routes/browser.ts:523,726` (zod schemas for new keys),
  `src/main/profiles/profileManager.ts:593,1576` (INSERT/UPDATE paths).

## Key facts (scout claims, parent-verified)

- `ro.*` immutable after init even for uid 0; only read-back proves application
  (injector already does this — honest classification).
- `deviceIdentity.ts` overlay remount is the free path to real `ro.*` rewrite, but
  normal start skips it (multi-minute restart cost).
- Proxy geo columns exist and update; only `timezone/lat/lon` flow to android.
- No mixing code anywhere (`grep [Mm]ix` in android+devices: zero hits).

## Acceptance check

- E2E on live guest: Build.* + qemu props + goldfish files + sensors + su + serials
  spoofed per profile; mixed identity deterministic from seed; rotate changes
  android_id/serials; geo-linked locale/MCC; proxy-less guest online via direct NAT.
- Full suite + oracle blind ACCEPT vs manifest quotes.
