# Recon — fix-all round after v0.6.74

T1 lane: user asked to fix everything so everything works.

## Diagnosis (no code bug found)

- The only local red was `cargo test` failing with
  `resource path binaries/node-x86_64-pc-windows-msvc.exe doesn't exist`.
  Root cause: environment prerequisite, not code — `tauri.conf.json`
  declares `externalBin: ["binaries/node"]`, and the binary is gitignored
  by design (`.gitignore:38`), produced by `npm run vendor:node`.
- CI was already correct: both release jobs run `vendor:node` before
  `cargo test`. An attempted CI reorder was investigated and reverted —
  it fixed no observed failure.
- Fix: ran `npm run vendor:node` (Node 22.23.2, SHA-256 verified).

## Touched files

- None in code. This recon file only.

## Acceptance check

- `cargo test`: 58 passed, 0 failed.
- `npm test` (from release gate, same tree): 196 files / 1781 passed.
- `npm run typecheck`, `npm run build`, `npm run sbom:verify`: clean.
- CI run 39586874626 (tag v0.6.74): all 5 jobs green
  (test, sdk x2, macOS, Windows release).
- Release v0.6.74 published with 6 assets
  (setup + portable + macOS zip + sigs + latest.json);
  `latest.json` fetched live: `version 0.6.74`, signed updater URLs.
