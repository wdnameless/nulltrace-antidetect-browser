# Manifest — per-profile Android device identity

T2 lane: `Per-profile Android device identity (profile as its own phone)`.
Evidence: measured on android-34 `google_apis` x86_64, emulator 37.2.10, host Windows + RTX 3060.

| ID | Requirement | Verbatim user quote | Evidence |
|----|-------------|---------------------|----------|
| R01 | The emulator is the deliverable the user builds automation on top of: prepare must leave a running, streamable instance, not a manual two-step ritual | "Приступай, мне нужен готовый эмулятор чтобы мы могли поверх него писать автоматизацию" | `prepareProfile` restarts the emulator to publish the identity, restarts the per-boot services, and returns `state=running` with a stream ticket issuable (clean-AVD run: `PREPARED model=CPH2609`, `AFTER state=running`, `TICKET ticket-ok`) |
| R02 | A profile reports its own phone instead of the stock emulator image device | "Вариант 1 — детерминированная подготовка образа" | `ro.product.model=CPH2609`, `ro.product.brand=oppo`, `ro.product.device=oppo_reno_11` served by the guest after preparation; published via `ro.build.fingerprint=oppo/oppo_reno_11/…:14/…` |
| R03 | Preparation is deterministic per profile: same profile, same device, idempotent re-run | "Вариант 1 — детерминированная подготовка образа" | Identity derives from `generateAndroidFingerprint(profileId, seed)`; a second pass sees the expected model and short-circuits without restarting the guest |
| R04 | Preparation is one click: `POST /prepare` plus the UI button, usable from automation and from the page | "мне нужен готовый эмулятор чтобы мы могли поверх него писать автоматизацию" | `POST /api/v1/android/profiles/:id/prepare` returns `{ status, prepared }`; renderer `Prepare Device` button drops the dead ticket, calls it, and refreshes status |
| R05 | What the emulator pins is reported, not faked | (standing honesty law: surface degraded posture) | `device.fixed` lists `ro.serialno`, `ro.hardware`, `ro.build.fingerprint`, `ro.build.version.release`, `ro.build.version.sdk`, `ro.kernel.qemu`, `ro.boot.qemu`, `ro.product.board` via the shared `FIXED_IDENTITY_KEYS` |
| R06 | A profile that was never prepared still boots and reports the image device, not an error | (regression guard from the boot work) | Normal start skips preparation; `device.effective` reads whatever the guest serves (`sdk_gphone64_x86_64` on a fresh AVD) |
