# Recon — per-profile Android device identity

T2 lane continuation: the prepare path was written, then failed end to end
(`adb reboot` burns the boot deadline on a half-started `-writable-system`
guest). This round replaced the reboot with an emulator restart and cut the
identity block to the boot-safe keys.

## Touched files

- `src/main/android/deviceIdentity.ts` — 10-key `ro.product.*` block,
  shared `FIXED_IDENTITY_KEYS`, same backup/restore/read-back write path.
- `src/main/android/instance.ts` — `restartGuestProcess()`,
  `spawnAndWaitForBoot()`, `startGuestServices()`, `stopGuestServices()`,
  `prepareProfile()` returning a usable running instance; exit-handler fix.
- `src/main/android/adb.ts` — removed dead `reboot()`; comment corrected.
- `src/main/api/routes/android.ts` — prepare route + `NOT_RUNNING` guard.
- `src/renderer/src/api.ts`, `src/renderer/src/pages/Android.tsx` — prepare
  API, button drops the dead ticket and refreshes status.
- `CHANGELOG.md`, `openspec/changes/android-device-identity/` — docs.

## Acceptance check

- Clean AVD (`rm -rf` the profile AVD, fresh adb server): start → 72 s
  running as `sdk_gphone64_x86_64`; prepare → 100 s, `model=CPH2609`,
  `device=oppo_reno_11`, `errors=[]`, `state=running`, stream ticket
  issuable, stop clean.
- `npx tsc -p tsconfig.main.json --noEmit` and
  `npx tsc -p src/renderer/tsconfig.json --noEmit` clean.
- `npx vitest run` on the six Android unit suites: 58/58 green.
