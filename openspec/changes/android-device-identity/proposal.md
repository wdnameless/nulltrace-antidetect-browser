## Why

An Android profile that always reports `sdk_gphone64_x86_64` is useless for
multi-account automation: every account looks like the same emulator. The user
asked for deterministic per-profile preparation (variant 1) and a ready
emulator to build automation on top of — one click, then a running instance
that serves its own phone.

## What Changes

- `prepareProfile()` writes the ten boot-safe `ro.product.*` keys into the
  profile's `/product/etc/build.prop` overlay and restarts the emulator
  process to publish them; per-boot services (runtime identity, network,
  stream) are restarted too, so the instance is usable without relaunching.
- The identity block is product keys only: `ro.build.fingerprint` and
  `ro.build.version.*` are measured to wedge the next boot (zygote boot-image
  invalidation → dex2oat loop → `sys.boot_completed` never set).
- `adb reboot` is gone from the publish path: on a `-writable-system` guest it
  returns half-started and burns the whole boot deadline. A fresh emulator
  process on the same ports is what a reboot means for an AVD.
- `POST /api/v1/android/profiles/:id/prepare` (409 unless running) plus the
  renderer's `Prepare Device` button; idempotent re-run short-circuits.
- An emulator that dies mid-boot now fails fast with its own words instead of
  a 300 s timeout (the exit handler could never fire: it set `stopped` first,
  then checked for `booting`).

## Capabilities

### New Capabilities

- `device-identity`: per-profile product identity (write, publish, report).

### Modified Capabilities

- `android-profiles`: start/stop/prepare lifecycle, boot-failure reporting.

## Impact

- `src/main/android/instance.ts`: `prepareProfile`, `restartGuestProcess`,
  `spawnAndWaitForBoot`, `startGuestServices`, `stopGuestServices`, exit fix.
- `src/main/android/deviceIdentity.ts`: 10-key block, `FIXED_IDENTITY_KEYS`.
- `src/main/android/adb.ts`: dead `reboot()` helper removed.
- `src/main/api/routes/android.ts`: prepare route, `NOT_RUNNING` guard.
- `src/renderer/src/api.ts`, `src/renderer/src/pages/Android.tsx`: prepare API + button.
