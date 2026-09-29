# Requirements Manifest: Font Pinning JS-Maximum

## Verbatim user input
> "Окей анализируй https://github.com/ProxyShard/ShardBrowser/ и скажи чего у нас нет"
> "Пиши спеки и давай реализовывать"

## Wave 0 interview (this session)
> Scope: "По очереди: QUIC → шрифты → TLS"
> Fonts path: "JS-максимум без C++"
> Umbrella R02: "Font pinning JS-maximum without C++: close measurable surfaces, record engine-parity remainder"

Feasibility facts (scouted from repo, not user claims):
- "Full font hiding impossible at layout engine level without C++ patches" (DirectWrite/Blink fallback).
- "patches/ does not exist; no source build; CI gate in stealth-parity.yml verifies Main vs Worker parity" (`docs/STEALTH_PARITY.md`).
- Stock Chromium exposes Local Font Access via `window.queryLocalFonts()` and does NOT define `navigator.fonts`.

## Requirements

| ID | Requirement | Verbatim source | Status |
|---|---|---|---|
| R02 | Font pinning JS-maximum without C++: close measurable surfaces, record engine-parity remainder | «JS-максимум без C++» | in-spec |
| R02.1 | `document.fonts.check` / `FontFaceSet.prototype.check` (and worker `self.fonts.check`) return `false` for hidden host fonts and `true` for declared profile fonts, including mixed fallback chains | Umbrella R02 | in-spec |
| R02.2 | `CanvasRenderingContext2D.prototype.measureText` and `OffscreenCanvasRenderingContext2D.prototype.measureText` strip hidden host fonts from chains, ensure declared fonts measure distinct from generic fallback deterministically, and never mutate `.font` | Umbrella R02 | in-spec |
| R02.3 | `HTMLElement.prototype.offsetWidth` and `offsetHeight` strip hidden host fonts so probes fall back to the next candidate or generic fallback without mutating `style.fontFamily` | Umbrella R02 | in-spec |
| R02.4 | `queryLocalFonts` rejects with `DOMException('Permission denied', 'NotAllowedError')` and `navigator.fonts` remains absent (`undefined`, `'fonts' in navigator === false`) | Umbrella R02 | in-spec |
| R02.5 | Per-OS font inventory (`resolveFontConfig`) and speech synthesis voice pool (`getSyntheticVoicePool`) remain coherent across `windows`, `macos`, `linux`, `android`, and `ios` without cross-OS leakage | Umbrella R02 | in-spec |
| R02.6 | Engine-owned remainder (DirectWrite/Blink fallback, CSS/canvas glyph rasterization of host fonts) recorded via explicit `TODO(engine-parity: fonts)` markers and a dated 2026-09-29 note in `docs/STEALTH_PARITY.md` | Umbrella R02 | in-spec |
