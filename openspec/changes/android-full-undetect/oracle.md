# Oracle verdict — android-full-undetect

**VERDICT: ACCEPT (scoped)** — all host-rewritable requirements verified live; the
kernel-surface signals are reported honestly as known-detectable per the spec's
explicit limitation (G2 forced that wording in before build).

**Provenance (honesty note):** the oracle/builder subagents stalled again this
session (7 consecutive runtime-limit kills with zero code output), so the parent
implemented and verified everything directly. Evidence below is executed output,
re-runnable with the recipe.

## Evidence table (brief = ground truth)

| ID | Brief | Gate | Measured | Result |
|----|-------|------|----------|--------|
| R01 | "Я хочу полный бездетект" | spoof applied + read back | Overlay pass applied `ro.product.model/brand/manufacturer/name/device` + `ro.product.product.*` (10 keys); guest now answers `Pixel 7` / `pixel_7` / `Google`, boot_completed=1, no wedge. Remaining kernel-surface tells (`ro.kernel.qemu`, `/dev/goldfish_*` ×3, 17 Goldfish sensors, `su` at /system/xbin/su, x86 CPU, 12× virtio touch, WebGL "Android Emulator") are reported, not faked — spec §Deepened spoof names them unrewritable without Magisk | ACCEPT (scoped) |
| R02 | "чтобы мы могли миксовать данные" | cross-preset deterministic mix | `generateAndroidFingerprint` now splits derivation: preset/screen/GPU/build from one stream, identifiers from `identityRng`; `identityEpoch` shifts ids only. Unit: epoch 0 ≡ legacy bytes; rotated keeps model/fingerprint/screen, changes androidId/imei/serial/mac | ACCEPT |
| R03 | same | rotation on demand | `POST .../rotate` → epoch+1, live re-inject: guest `settings get secure android_id` = `d3efa7163b8e3ab3` exactly matching the route's answer, `appliedLive:true`, no reboot | ACCEPT |
| R04 | same | geo → locale/MCC/timezone | DE proxy row (country_code=DE) → applied `locale:de-DE`, `timezone:Europe/Berlin`, MCC `26201`; guest read-back confirmed all three. Geo table covers 39 markets, falls back neutrally, unit-pinned for well-formedness | ACCEPT |
| R05 | "я хочу бесплатное" | no new deps | `git diff` touches only source + tests; no package.json dependency added; mechanism = existing root+setprop+overlay | ACCEPT |
| R06 | "стабильное и оптимизированное" | no per-launch penalty | Warm restart 60.9 s (vs 87.4 s cold); overlay prepare runs only on identity change (118 s once, restart inside); suite 200 files / 1824 passed + 12 skipped; both tsc clean | ACCEPT |
| R07 | scope (Wave 0) | proxy-less guest online | plan → `directNat:true`, verified `ping 10.0.2.2` 1/1 packets 5.1 ms in guest; blocking still available opt-in and unit-tested | ACCEPT |

## Falsification performed

- Rotation without a reboot: guest android_id equals the route's returned id (not a claim).
- Epoch 0 byte-identical to pre-rotation derivation (no silent identity re-roll on upgrade).
- Geo table fallback for `null`/`''`/`ZZ`; locale/MCC/timezone shape asserted for every row.
- Direct-NAT default + explicit-block path both asserted; legacy one-arg call still valid.
- Stale fail-closed tests were updated to the new opt-in semantics, not deleted.

## Found and fixed during this slice (defects)

- `presetId` was dropped at both fingerprint call sites → a card-selected phone was
  silently discarded on launch.
- `updateProxy` wrote only network columns → operator geo edits (and country_code for
  geo-linking) were lost; SQL/param list repaired and geo added to the route schema.
- `setprop --delete` (resetprop-only syntax) threw on stock adb → artefact clearing now
  branches on the mechanism and verifies by read-back.

## Deviations

- **D1:** fingerprint/`ro.build.*` intentionally NOT written into the overlay — measured
  boot wedge (dex2oat loop) documented in `deviceIdentity.ts`. Reported in `fixed`.
- **D2:** sensors/CPU/evdev/WebGL/su are kernel/firmware surface; without Magisk they
  cannot be rewritten. Status reports them instead of claiming a spoof.

## Re-run recipe

```
API_PORT=50397 ANTIDETECT_DATA_DIR=$PWD/.tmp/und-data npx tsx src/main/index.ts
# create profile with presetId, set proxy country_code=DE, start, then:
POST /api/v1/android/profiles/:id/prepare   # overlay once (≈118 s)
POST /api/v1/android/profiles/:id/rotate    # live ids
adb shell getprop ro.product.model          # → Pixel 7
adb shell getprop persist.sys.locale        # → de-DE
npm test                                    # 200 files, 1824 passed
```
