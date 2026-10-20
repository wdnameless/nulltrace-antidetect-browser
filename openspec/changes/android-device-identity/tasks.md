## 1. Identity write (boot-safe block)

- [x] 1.1 Patch `/product/etc/build.prop` in the AVD writable overlay through a
  staged temp file with backup + restore and read-back verification.
- [x] 1.2 Restrict the block to the ten `ro.product.*` keys; report the rest in
  `fixed` via the shared `FIXED_IDENTITY_KEYS` constant.
- [x] 1.3 Replace the block idempotently on re-apply (marker-delimited).

## 2. Publish via emulator restart

- [x] 2.1 Replace `adb reboot` with `restartGuestProcess()` (teardown services →
  `emu kill` + process kill → `waitForDisconnect` → spawn on the same ports →
  `waitForBoot`).
- [x] 2.2 Extract `spawnAndWaitForBoot`, `startGuestServices`,
  `stopGuestServices` so start/prepare/restart share one implementation.
- [x] 2.3 Fix the exit handler so a mid-boot death rejects the boot race
  instead of waiting out the deadline.
- [x] 2.4 Remove the dead `AdbClient.reboot()` helper.

## 3. Surface (API + UI)

- [x] 3.1 `POST /api/v1/android/profiles/:id/prepare` with a `NOT_RUNNING`
  guard; `prepareProfile` leaves the instance running with services up.
- [x] 3.2 Renderer `Prepare Device` button: drop the dead ticket, call prepare,
  refresh status.

## 4. Verification

- [x] 4.1 Clean-AVD end-to-end run: start → prepare → `model=CPH2609`,
  `device=oppo_reno_11`, `errors=[]`, `state=running`, stream ticket issuable.
- [x] 4.2 `tsc` (main + renderer) clean; Android unit suites green.
