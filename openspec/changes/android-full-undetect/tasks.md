## 1. Backend: spoof deepening (fixer)

- [x] 1.1 Plumb `presetId` through launch (fix `instance.ts:302,677` re-derive).
- [x] 1.2 Overlay-once-per-AVD: cached marker, skip on match (no per-launch cost).
- [x] 1.3 Fix artefact clearing (`setprop --delete` invalid); extend coverage
  (goldfish files, su hiding) with read-back honesty.
- [x] 1.4 Regression tests: preset survival, overlay cache, clear mechanism.

## 2. Backend: mix + rotation + geo (fixer; blocked-by: 1.1)

- [x] 2.1 Cross-preset `generateAndroidFingerprint` + new `android_config` keys.
- [x] 2.2 `POST .../rotate` (live re-inject + persist epoch).
- [x] 2.3 `country_code` → locale/MCC-MNC mapping + injector writes.
- [x] 2.4 Tool tests (determinism, rotation changes ids, geo mapping).

## 3. Backend: direct NAT (fixer)

- [x] 3.1 `planGuestNetwork(null)` → direct NAT unless `blockNetwork: true`.
- [x] 3.2 Egress verification + status reporting (`directNat: true`).

## 4. UI: card mix + rotation (designer; blocked-by: 2.1)

- [x] 4.1 Mix pins (4 preset selects), locale/MCC inputs, Rotate button.
- [x] 4.2 Spoof posture line from status.inject.
- [x] 4.3 BEFORE/AFTER screenshots (card, status line).

## 5. Integration + E2E (parent; blocked-by: 1.4, 2.4, 3.2, 4.3)

- [x] 5.1 Merge slices; full suite green.
- [x] 5.2 Live guest battery: host-rewritable signals verified spoofed (Build, qemu, goldfish files, serials, su); kernel-surface signals (sensors, CPU, evdev, WebGL) verified REPORTED as known-detectable; mix/rotate/geo/NAT live.
- [x] 5.3 Oracle blind ACCEPT vs manifest; archive on pass.
