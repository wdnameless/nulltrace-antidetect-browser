# Recon — Android undetectability audit (T1)

Live audit against running guests (packaged 0.6.83 `emulator-5556` + dev-tree 0.6.84 `emulator-5558`, engine junctioned). Every signal below is an executed `adb shell` / API call, not a code reading.

## Detection surface (measured)

| # | Signal | Value observed | Detectable by |
|---|--------|----------------|---------------|
| 1 | `ro.product.model` | `sdk_gphone64_x86_64` | any `getprop`/Build.MODEL check |
| 2 | `ro.product.device` | `emu64xa` | any Build.DEVICE check |
| 3 | `ro.build.fingerprint` | `google/sdk_gphone64_x86_64/...:userdebug/dev-keys` | Play Integrity / SafetyNet (dev-keys = instant fail) |
| 4 | `ro.build.tags` / `ro.build.type` | `dev-keys` / `userdebug` | root/behavioral checks |
| 5 | `ro.kernel.qemu` | `1` | classic one-liner |
| 6 | `ro.hardware` / `ro.product.board` | `ranchu` / `goldfish_x86_64` | classic |
| 7 | `/dev/goldfish_*` | present (address_space, pipe, sync) | file-existence checks |
| 8 | Sensors | 17× `Goldfish *` (accel/gyro/mag/proximity/light/...) | SensorManager enumeration |
| 9 | `ro.serialno` / `ro.boot.serialno` | `EMULATOR37X2X10X0` | serial format check |
| 10 | CPU | `AMD Ryzen 5 5600X`, abi `x86_64` | `/proc/cpuinfo`, native-lib checks (real phones: ARM) |
| 11 | GPU (WebGL-visible) | `Android Emulator OpenGL ES Translator (NVIDIA GeForce RTX 3060...)` | any WebGL `RENDERER` read — sites see "Android Emulator" + desktop GPU |
| 12 | Input devices | 12× `virtio_input_multi_touch_N` | evdev enumeration (real phone: one touchscreen) |
| 13 | `su` | `/system/xbin/su` present, `adb_enabled=1` | root checkers |
| 14 | Injector self-report | `privilege: setprop-only`, applied 3 / skipped 6 / errors 11 | honest: only android_id + 1 artefact + density applied |
| 15 | Guest network (no-proxy profile) | wlan0/eth0 without IPs, `ping: Network is unreachable`, Chrome "No internet connection" | functional: guest is offline, not proxied |

Spoofed OK: `android_id` (per-profile `de4d21dc…`), LCD density 420, AVD hw (cores/RAM/heap). Telephony looks plausible (`T-Mobile`, SIM LOADED).

## Interaction (measured, dev tree 0.6.84)

- `tap` 48 ms, `swipe`, `key(HOME)`, `screencap` 1.3 MB — all code 0.
- Chrome welcome → "No thanks" → homepage driven purely by API taps (4 screencaps).
- **Found + fixed live:** API taps were dropped by scrcpy (`Ignore touch event, it was generated for a different device size`) because `tap()` sent the requested LCD (1082×2402) while the encoder serves 1080×2400. Fix: `controlViewport()` from codec meta + coordinate scaling (same rule as AndroidCanvas). After fix: Chrome opens via API tap, 0 drop warnings. Unit-pinned (26/26 android tests).

## Acceptance check

- Battery executed, verdict reported, tap fix verified live + unit-locked.
