# Recon — local verification before release (v0.6.80 tree)

T1 lane: user asked to test the build locally and confirm correctness
BEFORE any new patch or release.

## Gates executed on this tree (all green, no release made)

- `npm run build:sdk` + `npm run typecheck` (main + renderer): clean.
- `npm run build` (main + renderer + mcp): succeeds; local
  `dist/renderer` bundle contains Open Window + openAndroidWindow +
  avc1 decode path; `bridge.js` sends `{ profile_id }`.
- `npm test`: 197 files / 1790 passed, 12 skipped, 0 failed.
- `npm run sbom:verify`: SBOM verification succeeded.
- `cargo test`: 58 passed, 0 failed; `cargo check`: Finished clean.
- `[DEBUG-*]` grep over `src/`: no hits. No scratch `.mjs` left in
  repo root. Test side effects (`evidence/`, `sbom.cyclonedx.json`)
  reverted — tree clean at `7d45855` (v0.6.80).

## Emulator E2E on the local tree (measured)

- Launch: `running`, `CPH2609`, fail-closed network (no proxy bound),
  `streamStats { bytes: 0 }` before first video byte.
- Stream: fresh ticket `412x915` (pre-meta fallback), 104 binary
  frames / 587 KB in 10 s; `streamStats.bytes` grows (916 KB after).
- Touch with the fixed layout (actionButton=1, buttons=1/0): guest
  TaplEvents shows ACTION_DOWN + ACTION_UP (4 events incl. service)
  → taps LAND.
- Stop: clean, no leftovers.

## Verdict

Local build verified correct. No code changes in this lane (recon
file only). Good to release whenever the user asks.
