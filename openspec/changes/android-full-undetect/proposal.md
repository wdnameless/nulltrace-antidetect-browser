## Why

The audit (`.workflow/recon-android-undetectability.md`) measured the guest as
detectable on every classic vector: `sdk_gphone64_x86_64`/`emu64xa` identity,
`userdebug/dev-keys` fingerprint, `ro.kernel.qemu=1`, goldfish devices + 17
Goldfish sensors, `EMULATOR37X2X10X0` serials, `su` present, and a WebGL string
advertising "Android Emulator". The injector honestly reports `setprop-only`
(applied 3 / skipped 6 / errors 11): `ro.*` is immutable after init, the
`/product` overlay path is bypassed on normal start, and `setprop --delete`
is invalid syntax. Identity is 1:1 per preset with no mixing, locale/MCC-MNC
are never set (guest serves T-Mobile/310260 on any proxy), and proxy-less
profiles boot offline.

## What Changes

- Injector deepening (free, no new deps): fix `presetId` drop on launch; route
  `ro.*` writes through the `/product` overlay remount when profitable (one
  restart, cached per AVD — not per launch); replace invalid `setprop --delete`
  with the working clear mechanism; extend artefact coverage (goldfish files
  via root file ops where writable, `su` hiding where possible without breaking
  adb root); honest per-step read-back stays (no claimed spoof without proof).
- Cross-preset mixing: fingerprint draws model/screen/GPU/build from different
  presets deterministically from seed; new `android_config` keys for per-field
  pins; rotation endpoint regenerates android_id/serials/MAC on demand.
- Geo-consistency: `country_code` flows from proxy geo to locale + MCC/MNC +
  operator alpha + timezone (single mapping table, tested).
- Network: proxy-less profiles get explicit direct-NAT mode (fail-closed policy
  stays for profiles that opt into blocking); guest is usable offline-free.
- UI/API: card rotation button + mix fields; routes accept new keys; status
  surfaces mix + spoof posture honestly.

## Capabilities

### New Capabilities

- `android-undetect`: deepened spoof, mixing, rotation, geo-link, direct NAT.

### Modified Capabilities

- `android-launcher`: presetId plumbed, overlay path cached.
- `settings-ui`: card mix section (profile scope, not new page).

## Impact

- `src/main/android/injector.ts`: fixed delete mechanism, extended artefacts.
- `src/main/android/fingerprint.ts`: cross-preset mix derivation.
- `src/main/android/config.ts`: new keys, `country_code` query.
- `src/main/android/instance.ts`: presetId plumb, overlay cache, rotate API.
- `src/main/android/network.ts`: direct-NAT mode for proxy-less.
- `src/main/api/routes/browser.ts`, `src/main/profiles/profileManager.ts`: keys.
- `src/renderer/src/pages/Profiles.tsx`: rotation + mix UI.
