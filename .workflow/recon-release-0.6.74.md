# Recon — release v0.6.74 (Android emulator usable)

T1 lane: user asked to push everything to release so they can update and
use the Android profile.

## Touched files

- `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock`: version 0.6.73 → 0.6.74 (the four carriers the
  `tauriShell` version-consistency test checks).
- `CHANGELOG.md`: `[Unreleased]` + `[Unreleased — previous]` sections
  folded into `[0.6.74] - 2026-10-21` (+ continued section); added the
  missing guest-network and large-APK entries that were verified but
  never written to the changelog.
- Rebase: 4 local Android commits (`5ea17e6`, `3c1539b`, `9fa6cd0`,
  `ba58a7a`) replayed onto `origin/main` (`d261e89`, v0.6.73) as
  `2f14c17`, `95706ec`, `bf5bc42`, `18b5e3b`. One conflict
  (`CHANGELOG.md` head) resolved by keeping the Android `[Unreleased]`
  sections above the upstream `0.6.73`/`0.6.72` releases; `api.ts`
  auto-merged (disjoint hunks: gdrive switch vs androidPrepare).

## Acceptance check

- `npm run build:sdk` + `npm run typecheck` (main + renderer) clean.
- `npm run build` (main + renderer + mcp) succeeds.
- `npm test`: 196 files / 1781 passed, 12 skipped, 0 failed.
- `npm run sbom:verify`: SBOM verification succeeded.
- `cargo test`: NOT green locally — pre-existing environment gap
  (`resource path binaries/node-x86_64-pc-windows-msvc.exe doesn't
  exist`; needs `npm run vendor:node` / the release pipeline's vendored
  runtime). Same failure exists without these changes; CI builds it.
- Test side effects (`evidence/*.json`, `sbom.cyclonedx.json`
  timestamps) reverted — release commit carries only the 5 release
  files, matching the `673b4c5` shape.
- Pushed: `main` + tag `v0.6.74` to origin; CI release job is gated on
  `refs/tags/v*` and publishes the updater artefacts.
