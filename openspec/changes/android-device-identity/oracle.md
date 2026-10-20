# Oracle verdict — android-device-identity

## Verdict

**ACCEPT**: every requirement in the manifest is satisfied by the working tree,
with executed evidence. Blind audit (the oracle never saw the proposal/spec):
both `tsc` clean, 58/58 Android unit tests green, and each user quote mapped
to line-anchored code.

## Reasons

- `"Вариант 1 — детерминированная подготовка образа"`: `identityProperties`
  (`deviceIdentity.ts`) writes ONLY the ten `ro.product.*` keys; the shared
  `FIXED_IDENTITY_KEYS` constant is the single source of truth (imported by
  `instance.ts`); `prepareProfile()` is idempotent (short-circuits when the
  expected model is already served); publication uses `restartGuestProcess`,
  and `adb reboot` has no callers left.
- `"Приступай, мне нужен готовый эмулятор чтобы мы могли поверх него писать
  автоматизацию"`: `prepareProfile` restarts the per-boot services before
  returning, leaving `state=running` with a stream ticket issuable — verified
  end to end on a clean AVD (`PREPARED model=CPH2609 device=oppo_reno_11
  errors=[]`, `AFTER state=running`, `TICKET ticket-ok`); the boot race
  rejects on a mid-boot emulator death (`ERR_ANDROID_EMULATOR_EXIT` with the
  emulator's own fatal line); `POST /prepare` guards non-running state with
  409 `NOT_RUNNING`; the UI drops the dead ticket before calling prepare.
- Hygiene: no scratch scripts in the repo root, no emulator processes left
  running.

## Evidence

- `npx tsc -p tsconfig.main.json --noEmit` → clean.
- `npx tsc -p src/renderer/tsconfig.json --noEmit` → clean.
- `npx vitest run` (6 Android suites) → 58/58 passed.
- Clean-AVD run: 72 s to running as `sdk_gphone64_x86_64`, 100 s to prepared
  as `CPH2609 / oppo_reno_11`.
