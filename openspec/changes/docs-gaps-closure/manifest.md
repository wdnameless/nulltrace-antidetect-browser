# Requirements Manifest: docs gaps closure

## Verbatim user input
> "Теперь проанализируй папку docs и поищи что еще не закрыто из наших планов"
> "Приступай"

## Gaps selected for this wave (from docs audit)
> "34 поверхности помечены TODO(engine-parity)" — docs/STEALTH_PARITY.md (font inventory surfaced per profile instead of engine patch)
> "Multi-Window Synchronizer" — docs/COMPETITIVE_ANALYSIS.md Tier 3 (scroll + special-key mirroring missing)
> "macOS / Linux — поставляются исключительно как конфигурация; артефакты под них пока не публикуются" — docs/DECISIONS.md ADR-008 (linux job added; macos already shipped)

## Requirements

| ID | Source quote | Requirement | Acceptance |
|----|--------------|-------------|------------|
| R01 | "Multi-Window Synchronizer" | Mirror scroll deltas and special keys from master to slaves via real CDP input | syncScrollKey.test.ts 5/5 pass; wheel accumulates deltas, Enter/Escape forwarded from fields |
| R02 | "50+ тюнюемых параметров фингерпринта" | Per-profile font inventory override editable in UI and applied at launch | fontListOverride.test.ts 3/3 pass; textarea in Fingerprint Overrides modal persists to fpCfg.fontList and reaches stealth.fontList |
| R03 | "артефакты под них пока не публикуются" (linux) | Ubuntu AppImage release job with vendored linux node sidecar | ci.yml release-linux job present, vendor-node linux target verified by real download+sha256, needs chain includes release-linux |
| R04 | reviewer P0: token login cookie path | Offline token injection must write to the real profile dir | resolveProfileDir used before getProfileCookiesPath/getProfileOsKey |
| R05 | reviewer P2: XLSX export fetch | Export must use getApiBase so packaged app reaches the service | Proxies.tsx + Databases.tsx fetch via getApiBase() |
