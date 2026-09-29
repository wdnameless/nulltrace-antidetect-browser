# Recon: docs gaps closure

## Gaps audited (7 docs plans)
1. Scroll + keyboard mirroring in syncer — GAP CONFIRMED: master listener had click/input/navigate only, no wheel/keydown reporting, no slave replay.
2. Font inventory editor — GAP CONFIRMED: fontList override existed in stealth layer but no per-profile UI and no launch-config plumbing from fingerprint config.
3. Linux release artifacts — GAP CONFIRMED: only windows + macos jobs, linux commented out.
4. vendor-node linux sidecar — LATENT BLOCKER found during review: no linux/x64 target.
5. Token login cookie path — BUG found during review: profile id passed as dir.
6. Proxy/DB XLSX export fetch — BUG found during review: relative URL bypasses getApiBase.
7. WebRTC policy, noise surfaces, electron leftovers — NO GAP: already implemented/absent.

## Files touched
- src/main/syncer/actionSyncer.ts (wheel accumulator + keydown submit-keys + slaveScroll/slaveKey + mirrorScroll/mirrorKey)
- src/main/profiles/profileManager.ts (fontListOverride from fpCfg.fontList, catalog arg fix)
- src/main/profiles/tokenLogin.ts (resolveProfileDir fix)
- src/renderer/src/pages/Profiles.tsx (Font Inventory Override textarea + load/save)
- src/renderer/src/pages/Proxies.tsx + Databases.tsx (getApiBase export fetch)
- scripts/vendor-node.mjs (linux/x64 target + real digest from nodejs.org SHASUMS256)
- .github/workflows/ci.yml (release-linux job + needs chain + publish glob)
- tests/unit/syncScrollKey.test.ts, tests/unit/fontListOverride.test.ts (+ fixes to stale assertions)

## Acceptance check
- New tests: 8 pass (5 sync + 3 font). Parity suite: 10 pass.
- Typechecks: main OK, renderer OK.
- Full suite + build: pending in verify step.
