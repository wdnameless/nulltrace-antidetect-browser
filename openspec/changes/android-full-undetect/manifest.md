# Manifest — Android full undetect + data mixing

T2 lane: `Android full undetect plus data mixing free stable optimized`.

## Requirements

| ID | Requirement | Verbatim user quote | Status |
|----|-------------|---------------------|--------|
| R01 | Full undetect: apps must not flag the emulator (Build.*, qemu props, goldfish files, sensors, su, serials spoofed) | "Я хочу полный бездетект" | done |
| R02 | Data mixing: cross-preset identity (model/screen/GPU from different phones), deterministic from seed | "чтобы мы могли миксовать данные, у нас же антидетект браузер" | done |
| R03 | Identity rotation on demand (android_id/serials/MAC refresh) | "чтобы мы могли миксовать данные" | done |
| R04 | Geo-consistency: proxy geo linked to timezone + locale + MCC/MNC (no T-Mobile US on a German IP) | "чтобы мы могли миксовать данные" | done |
| R05 | Free solution: no paid services, no new dependencies (deepen current injector only) | "я хочу бесплатное" | done |
| R06 | Stable + optimized: no multi-minute penalty per launch, no flaky guest writes | "стабильное и оптимизированное решение" | done |
| R07 | Proxy-less guest goes online via direct NAT instead of offline (in scope) | Wave 0 widget: scope = "Бездетект + сеть" | done |

## Wave 0 decisions (widget, 2026-10-24)

- Target: apps-don't-flag level; Play Integrity explicitly OUT (unreachable on x86 AVD free).
- Mix: cross-preset + rotation + geo-consistency, all together.
- Mechanism: deepen current injector (root+setprop+overlay); NO Magisk/resetprop module.
- Scope: undetect + guest network fix.

## Non-goals

- Play Integrity / SafetyNet attestation passing; Magisk/Zygisk modules; system-image
  patching; ARM emulation; iOS; paid fingerprint vendors.
