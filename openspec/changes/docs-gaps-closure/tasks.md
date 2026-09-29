# Tasks: docs-gaps-closure

## 1. Specification & Interfaces
- [x] 1.1 Create openspec change bundle (`manifest.md`, `proposal.md`, `specs/docs-gaps-closure/spec.md`, `tasks.md`, `interfaces.md`, `.openspec.yaml`).

## 2. Font Inventory Override (R02)
- [x] 2.1 Update `src/renderer/src/pages/Profiles.tsx`: add `fontList?: string` to `FpForm`, add textarea with label `Font Inventory Override (comma-separated)`, and assign `cfg.fontList = fonts` upon save.
- [x] 2.2 Update `src/main/profiles/profileManager.ts`: in `resolveLaunchConfig`, extract `fpCfg.fontList` and wire to `stealth.fontList` with default fallback to `hwVector.fontInventory`.
- [x] 2.3 Verify `tests/unit/fontListOverride.test.ts` passes 3/3.

## 3. Synchronizer Scroll & Key Mirroring (R01)
- [x] 3.1 Update `src/main/syncer/actionSyncer.ts` for CDP wheel delta and key event mirroring.
- [x] 3.2 Verify `tests/unit/syncer/syncScrollKey.test.ts`.

## 4. Release & Validation
- [x] 4.1 Type check: `npx tsc -p tsconfig.main.json --noEmit`.
