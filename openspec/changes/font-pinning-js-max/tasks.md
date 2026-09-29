# Tasks — font-pinning-js-max

## 1. Specifications & Planning
- [x] 1.1 Create child change directory `openspec/changes/font-pinning-js-max/` (`.openspec.yaml`, `manifest.md`, `proposal.md`, `specs/font-pinning-js-max/spec.md`, `interfaces.md`, `tasks.md`).

## 2. JS Font Surface Closure & Per-OS Coherence
- [x] 2.1 Harden `src/main/fingerprints/fonts.ts` (`resolveFontConfig` hidden-host-font exclusions and cross-platform forbidden sets).
- [x] 2.2 Harden `src/main/proxy/stealthNoise.ts` (`getSyntheticVoicePool` per-OS and locale coherence so Linux/Android/macOS/iOS/Windows never leak foreign OS voices).
- [x] 2.3 Harden the font block in `src/main/proxy/stealthInjection.ts` (`FontFaceSet.prototype.check` / `self.fonts.check`, `CanvasRenderingContext2D` & `OffscreenCanvasRenderingContext2D` `measureText` with mixed-chain stripping and shorthand prefix preservation, `HTMLElement` `offsetWidth`/`offsetHeight` hidden-to-fallback chain stripping, `queryLocalFonts` rejection, `navigator.fonts` absence, and explicit `TODO(engine-parity: fonts)` annotations).

## 3. Tests & Documentation
- [x] 3.1 Extend `tests/unit/stealth/fontPinning.test.ts` with mixed-chain cases (`'Segoe UI, SF Pro Text, monospace'`), worker-context main-vs-worker parity cases, and per-OS voice coherence spot-checks.
- [x] 3.2 Append dated `2026-09-29` font-pinning JS-maximum and engine remainder note to `docs/STEALTH_PARITY.md`.
- [x] 3.3 Verify `npx tsc -p tsconfig.main.json --noEmit` and `npx vitest run tests/unit/stealth/fontPinning.test.ts`.
