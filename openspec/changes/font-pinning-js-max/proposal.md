# Proposal: font-pinning-js-max

## Why
Antifraud scripts enumerate installed OS fonts by combining `document.fonts.check`, `CanvasRenderingContext2D.measureText` (and `OffscreenCanvasRenderingContext2D.measureText` in Web Workers), `HTMLElement.offsetWidth`/`offsetHeight` fallback-chain probes, `window.queryLocalFonts()`, and cross-checking OS typography against `speechSynthesis.getVoices()`. Without C++ Blink/DirectWrite patches, glyph rasterization fallback remains in the engine, but every measurable JavaScript font-enumeration and metric probe surface can and must be closed consistently across main thread and worker contexts.

## What Changes
1. **JS Font Block Hardening (`src/main/proxy/stealthInjection.ts`)**:
   - Strip hidden host fonts from multi-family CSS chains while preserving CSS `font` shorthand prefixes (`font-style`, `font-weight`, `font-size/line-height`).
   - Hook `FontFaceSet.prototype.check` (and worker `self.fonts.check` if standalone) so hidden fonts drop out of chains (`hidden`-only → `false`) and declared fonts resolve as `true` even in mixed chains (`'Segoe UI, SF Pro Text, monospace'`).
   - Hook both `CanvasRenderingContext2D.prototype.measureText` and `OffscreenCanvasRenderingContext2D.prototype.measureText` so hidden fonts drop out of chains before declared-font resolution, declared fonts measure distinct from generic fallback deterministically, `.font` is never mutated, and main vs worker contexts agree.
   - Hook `HTMLElement.prototype.offsetWidth` and `offsetHeight` so hidden host fonts drop out of `style.fontFamily` chains (falling back to the next declared candidate or generic fallback metric) without mutating `style.fontFamily`.
   - Ensure `queryLocalFonts` rejects with `NotAllowedError` and `navigator.fonts` is never defined.
2. **Font Resolver & Voice Pool Coherence (`src/main/fingerprints/fonts.ts`, `src/main/proxy/stealthNoise.ts`)**:
   - Ensure `resolveFontConfig` excludes any explicitly declared `fontList` entries from `hiddenHostFonts` and covers cross-OS forbidden fonts across all five logical platforms.
   - Ensure `getSyntheticVoicePool` never leaks Apple (`Samantha`) voices onto `linux`/`android` profiles or Microsoft SAPI voices onto non-Windows profiles, while supporting locale-coherent voices.
3. **VM Harness & Documentation (`tests/unit/stealth/fontPinning.test.ts`, `docs/STEALTH_PARITY.md`)**:
   - Extend `fontPinning.test.ts` with mixed-chain probes (`'Segoe UI, SF Pro Text, monospace'`), main-vs-worker parity checks (`OffscreenCanvasRenderingContext2D` + `self.fonts`), and per-OS voice/font coherence checks.
   - Append a dated `2026-09-29` section in `docs/STEALTH_PARITY.md` recording what JS-max closes and the exact engine-owned remainder (`TODO(engine-parity: fonts)`).

## Capabilities
- `font-pinning-js-max`: JS-layer-maximum font enumeration and metric cloaking across main thread and workers, coherent per-OS voice pools, and documented engine remainder.

## Goals
- Close all JS-measurable font enumeration and metric-comparison surfaces (`check`, `measureText`, `offsetWidth`/`offsetHeight`, `queryLocalFonts`, `navigator.fonts`).
- Maintain main-thread vs Web Worker parity on font check and `measureText` surfaces.
- Eliminate cross-OS voice-pool leaks alongside platform font inventories.
- Document the engine-level DirectWrite/Blink remainder honestly in code and `docs/STEALTH_PARITY.md`.

## Non-Goals
- No C++ Chromium/Blink/Skia/DirectWrite source patches (`patches/` remains out of scope per R02/R05).
- No changes to `transportPolicy.ts`, `udpRelay.ts`, `chromium.ts` flag matrix, or `probe-tls.ts`.
