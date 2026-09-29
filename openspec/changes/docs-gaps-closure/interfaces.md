# Interfaces: docs gaps closure

## 1. Syncer scroll + key mirroring

```ts
// Master listener payloads (Runtime binding __syncerReport)
type SyncerReport =
  | { t: 'scroll'; deltaX: number; deltaY: number }
  | { t: 'key'; key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean };

// Slave replay (src/main/syncer/actionSyncer.ts)
async function slaveScroll(slave: SlaveState, ev: { deltaX: number; deltaY: number }): Promise<void>;
async function slaveKey(slave: SlaveState, ev: { key: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): Promise<void>;
async function mirrorScroll(session: Session, ev: { deltaX: number; deltaY: number }): Promise<void>;
async function mirrorKey(session: Session, ev: { key: string; code?: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): Promise<void>;
```

Boundaries: master collector is an injected JS string (no imports); replay uses
`Input.dispatchMouseEvent mouseWheel` and `Input.dispatchKeyEvent` only — never
scripted `scrollTo`/synthetic clicks. Owner: syncer module.

## 2. Font inventory override

```ts
// Fingerprint config blob (fingerprints.config_json)
interface FingerprintConfigFontOverride {
  fontList?: string[]; // operator override; absent/empty = seed inventory
}

// Launch assembly (profileManager.resolveLaunchConfig)
let fontListOverride: string[] | undefined; // parsed + trimmed from fpCfg.fontList
stealth.fontList = fontListOverride ?? hwVector.fontInventory;

// Renderer FpForm
interface FpForm {
  fontList?: string; // comma-separated textarea value
}
```

Owner: profileManager (backend), Profiles.tsx fingerprint modal (UI).

## 3. Linux release

```yaml
# .github/workflows/ci.yml
jobs:
  release-linux: { runs-on: ubuntu-latest, needs: [test, sdk], artifacts: NullTrace-linux-x64 }
  release: { needs: [test, sdk, release-macos, release-linux] }
```

```js
// scripts/vendor-node.mjs
TARGETS['node-x86_64-unknown-linux-gnu'] = {
  url: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz',
  sha256: 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307',
  archive: 'node-v22.23.2-linux-x64/bin/node',
};
```

Owner: CI/release pipeline.
