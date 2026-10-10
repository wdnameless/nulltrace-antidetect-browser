# sync-scope-settings — Spec

## ADDED Requirements

### Requirement: self-hosted traces removed
No self-hosted sync surface MUST remain in UI, API, packages, deploy scripts, or docs.

#### Scenario: clean grep
- **GIVEN** the removal is complete
- **WHEN** grepping `self-hosted|sync-server|bootstrap.ps1|dedicated team` in `src/`, `packages/`, `deploy/`, `docs/`
- **THEN** zero hits (except the unrelated "Inter, self-hosted" font comment and historical CHANGELOG)

### Requirement: six scope categories
The CloudSync page MUST offer 6 per-machine toggles: Profiles, Proxies, Vault credentials,
Scripts, Tags/Groups/Extensions, App settings — all ON by default.

#### Scenario: toggle visible and persistent
- **GIVEN** a connected Google Drive
- **WHEN** the operator turns Proxies OFF and reloads the page
- **THEN** the toggle still reads OFF (persisted in settings.json)

### Requirement: scope filters both directions
A disabled category's tables MUST be excluded from the outgoing payload and skipped on
remote apply; enabled categories keep converging.

#### Scenario: isolation
- **GIVEN** machine A with Proxies OFF and machine B with Proxies ON
- **WHEN** both sync against the shared folder
- **THEN** no proxy row from either machine crosses, while profiles still converge

### Requirement: scope never syncs itself
The scope setting MUST travel on no payload and MUST never be overwritten by a peer.

#### Scenario: asymmetric scopes persist
- **GIVEN** A syncs with Scripts OFF and B with Scripts ON
- **WHEN** several cycles complete in both directions
- **THEN** each machine keeps its own scope value

### Requirement: two-machine E2E proof
An automated test with two databases and one shared Drive mock MUST prove profiles, proxies,
and settings travel machine-to-machine, including per-category isolation.

#### Scenario: green E2E
- **GIVEN** the E2E test
- **WHEN** it runs in CI
- **THEN** it passes deterministically with no network and no Google account
