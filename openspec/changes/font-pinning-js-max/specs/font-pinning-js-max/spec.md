# Spec: font-pinning-js-max

## Purpose

Close all JavaScript-measurable font enumeration and metric-probing surfaces (`FontFaceSet.check`, `measureText`, `HTMLElement.offsetWidth`/`offsetHeight`, `queryLocalFonts`, `navigator.fonts`) across main thread and worker contexts without C++ engine patches, enforce per-OS voice/font coherence, and record the engine-owned layout/rasterization remainder honestly.

## Requirements

### Requirement R02.1: FontFaceSet.check Cloaking Across Chains and Contexts

The stealth layer SHALL intercept `FontFaceSet.prototype.check` (covering `document.fonts.check` and worker `self.fonts.check`) so that hidden host fonts are stripped from the candidate chain, chains containing only hidden/unknown fonts return `false`, and chains containing a declared profile font return `true`.

#### Scenario: Mixed chain in document.fonts.check and FontFaceSet.prototype.check

- **GIVEN** a `macos` profile declaring `SF Pro Text` with `Segoe UI` present on the host (hidden)
- **WHEN** `document.fonts.check('12px "Segoe UI"')` and `document.fonts.check('12px "Segoe UI", "SF Pro Text", monospace')` are evaluated
- **THEN** the single hidden font check returns `false`
- **AND** the mixed chain containing hidden `Segoe UI` followed by declared `SF Pro Text` returns `true`

### Requirement R02.2: Canvas and OffscreenCanvas measureText Cloaking

The stealth layer SHALL intercept `CanvasRenderingContext2D.prototype.measureText` and `OffscreenCanvasRenderingContext2D.prototype.measureText` so that hidden host fonts drop out of CSS font chains while preserving size/style shorthand prefixes, declared fonts measure distinct from generic fallback deterministically across calls, `.font` is never mutated, and main thread and worker contexts produce identical measurements.

#### Scenario: Mixed chain in measureText

- **GIVEN** a `macos` profile declaring `SF Pro Text` where `Segoe UI` is a host font
- **WHEN** `ctx.measureText('probe')` is called with `ctx.font = '12px "Segoe UI", "SF Pro Text", monospace'`
- **THEN** `Segoe UI` drops out of the chain so the returned width matches `'12px "SF Pro Text", monospace'` (and differs from both host `Segoe UI` and fallback `'12px monospace'`)
- **AND** `ctx.font` remains `'12px "Segoe UI", "SF Pro Text", monospace'`

#### Scenario: Main thread vs Worker parity for font checks and measurements

- **GIVEN** identical `StealthOptions` applied to a main-thread context and a worker context (`self.fonts`, `OffscreenCanvasRenderingContext2D`)
- **WHEN** both contexts probe hidden, declared, and mixed font chains via `fonts.check` and `measureText`
- **THEN** both contexts return identical booleans and widths

### Requirement R02.3: HTMLElement offsetWidth and offsetHeight Cloaking

The stealth layer SHALL intercept `HTMLElement.prototype.offsetWidth` and `HTMLElement.prototype.offsetHeight` so that hidden host fonts drop out of `style.fontFamily` chains, resolving to the next declared family in the chain or the generic fallback metric without mutating `style.fontFamily`.

#### Scenario: Hidden and mixed chains on HTMLElement offsetWidth/offsetHeight

- **GIVEN** a `macos` profile declaring `SF Pro Text` where `Segoe UI` is a host font
- **WHEN** `el.offsetWidth` and `el.offsetHeight` are read for `el.style.fontFamily = 'Segoe UI'` and `'Segoe UI, SF Pro Text, monospace'`
- **THEN** `'Segoe UI'` resolves to the fallback metric (never the host `Segoe UI` metric)
- **AND** `'Segoe UI, SF Pro Text, monospace'` resolves to the `SF Pro Text` metric
- **AND** `el.style.fontFamily` is unmutated

### Requirement R02.4: Local Font Access Neutralisation

The stealth layer SHALL leave `navigator.fonts` undefined (`'fonts' in navigator === false`) and override `queryLocalFonts` so it rejects with `DOMException('Permission denied', 'NotAllowedError')`.

#### Scenario: Probing navigator.fonts and window.queryLocalFonts

- **GIVEN** any profile with the stealth script applied
- **WHEN** a page checks `'fonts' in navigator` and invokes `window.queryLocalFonts()`
- **THEN** `'fonts' in navigator` is `false` and `typeof navigator.fonts` is `'undefined'`
- **AND** `window.queryLocalFonts()` rejects with `err.name === 'NotAllowedError'`

### Requirement R02.5: Per-OS Font and Voice Pool Coherence

`resolveFontConfig` and `getSyntheticVoicePool` SHALL produce platform-coherent font inventories and voice lists across `windows`, `macos`, `linux`, `android`, and `ios` without leaking Windows fonts/voices onto non-Windows profiles or Apple fonts/voices onto Windows/Linux/Android profiles.

#### Scenario: Per-OS voice and font spot-check

- **GIVEN** profiles configured for `windows`, `macos`, `linux`, `android`, and `ios`
- **WHEN** `resolveFontConfig` and `getSyntheticVoicePool` are evaluated for each platform
- **THEN** Windows profiles never expose Apple voices (`Samantha`, `Alex`) or Apple fonts (`SF Pro Text`)
- **AND** macOS/iOS profiles never expose Microsoft voices (`Microsoft David`, `Microsoft Zira`) or Windows fonts (`Segoe UI`)
- **AND** Linux/Android profiles never expose Microsoft voices or Apple voices (`Samantha`)

### Requirement R02.6: Honest Recording of Engine Remainder

The remaining engine-level font surfaces (DirectWrite/CoreText/FreeType system fallback and glyph pixel rendering on canvas/CSS) SHALL be marked with `TODO(engine-parity: fonts)` in code and documented in `docs/STEALTH_PARITY.md` with date `2026-09-29`.

#### Scenario: Auditing code markers and STEALTH_PARITY.md

- **GIVEN** `src/main/proxy/stealthInjection.ts` and `docs/STEALTH_PARITY.md`
- **WHEN** inspected for font-pinning limitations
- **THEN** `stealthInjection.ts` contains `TODO(engine-parity: fonts)` markers
- **AND** `docs/STEALTH_PARITY.md` contains a dated `2026-09-29` section explaining the JS-max closure and engine-owned remainder
