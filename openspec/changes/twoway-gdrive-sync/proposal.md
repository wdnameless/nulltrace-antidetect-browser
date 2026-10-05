# two-way-gdrive-sync

## Why

The Google Drive sync in this repo is one-way in practice and structurally unable to be two-way.
`.workflow/recon-gdrive-sync-gaps.md` recorded 14 concrete gaps; four of them make the feature
non-functional rather than merely incomplete:

- `requestSync('change')` has **zero producers** — the "automatic on change" promise never fires.
- The mirror tiers (`downloadMirrorArchive`/`restoreMirrorArchive`) are **never called**, so a second
  machine restores the database but never the browser site-state that actually holds logins.
- `keep_local` is **not implemented** — `pullFromGDrive` throws unless the caller passes
  `overwrite_remote`, and the engine always passes `keep_local`, so a pull on a machine that has any
  local edit fails outright.
- `uploadFile` is multipart-only. Drive caps non-resumable uploads at 5 MB, so the opt-in full
  mirror tier (~25 MB) **cannot upload at all**.

The operator asked for the whole thing fixed and for a genuinely two-way sync covering profiles,
sessions, cookies and everything else, where connecting a Google account is enough for the app to
find the folder, validate it, sync it and verify the result.

## What changes

### 1. Revision-committed single payload (closes G4, G7)

Five files uploaded sequentially with `manifest.json` written last is a corruption machine: an
interruption after file 3 leaves the new payload next to the old digests, and every later pull fails
the integrity check permanently.

The payload becomes **one sealed file per revision**, named `state-<exportedAt>.bin`, plus a small
plaintext `manifest.json` that names the current revision and its SHA-256. Push order is: upload the
new state file under a fresh name, then write the manifest. A failure anywhere before the manifest
write leaves the previous revision fully intact and readable. After the manifest lands, older state
files are pruned (two kept). Uploads over ~5 MB go through a chunked resumable session.

### 2. Three-way merge over row hashes (closes G2, G3, G5, G6)

A local **base snapshot** — the row hashes as of the last successful sync — turns the one-shot
overwrite into a real merge. Per row:

| local vs base | remote vs base | result |
|---|---|---|
| unchanged | changed | apply remote |
| changed | unchanged | push local |
| unchanged | unchanged | nothing |
| changed | changed, equal | nothing |
| changed, differing | changed, differing | conflict → policy (`keep_local` default, `overwrite_remote` on request) |
| **row gone** | present | local deleted → tombstone propagates |
| present | **row gone** | remote deleted → delete applies locally |

That is what makes it two-way: a deletion on either machine propagates instead of resurrecting, and a
profile edited on both machines merges per row rather than one side losing wholesale. Conflicts
default to keeping the local copy and pushing it, so background sync never silently discards the
machine the operator is sitting at.

### 3. Generic entity coverage (closes G11, G12)

Portable data is described once, as a table spec (primary key columns + portable columns), and
dumped/restored generically. Profiles and vault credentials plug in through the codecs that already
exist (`exportProfileBundle`/`importProfileBundle`, `revealSecret`/`protectSecret`) because those
handle cross-machine relinking of device/group/proxy by id-or-name — a plain row copy would leave
dangling foreign keys.

Settings sync from an explicit **denylist** (data dir, machine ports, the passphrase verifier, Drive
secrets) rather than the current three-key allowlist, so language, theme and shortcuts travel too.

### 4. Real change trigger (closes G1)

Every write in the app funnels through exactly two chokepoints: `Database.prepare(...).run/exec` in
`src/main/db/index.ts`, and `writeSettings` in `src/main/config.ts`. Both gain a write notification.
The sync engine subscribes, debounces 3 s, and requests a `'change'` sync. No call-site edits
anywhere else, and no mutation can slip past it.

Writes made *by* the sync engine are suppressed by a flag so a pull does not trigger a push.

### 5. Validation and verification (R5)

- **Before use**: the discovered folder must either be empty or carry a `manifest.json` whose `app` is
  `nulltrace`. A folder holding someone else's data is refused, not adopted. A stored folder id that
  Drive no longer knows is cleared and re-discovered rather than failing every call.
- **After write**: the push re-downloads the manifest and the state file it points at and verifies the
  digest. A mismatch is reported as a failure, not as a success.

### 6. Operator-visible state (closes G9, G10, G13, G14)

- A `sync_log` table records every run: direction, outcome, counts, error. Surfaced in the UI.
- Changing the passphrase re-pushes a fresh revision under the new key — the payload is built from
  local data, so re-encryption is just another push. Old revisions are pruned.
- Conflict inspection counts vault and settings changes, not only profiles and scripts.
- Background failures are logged and returned in status instead of being swallowed into one string.

## Scope

**In**: `src/main/cloud/*`, `src/main/api/routes/cloud.ts`, `src/main/db/index.ts`,
`src/main/db/schema.ts`, `src/main/config.ts`, the Cloud Sync renderer page and its API client.

**Out**: teams sync (separate subsystem with its own crypto), the self-hosted `/api/v1/cloud/*`
endpoint, licensing.

**Not breaking**: `/gdrive/push|pull|inspect-pull|credentials|auth/*|disconnect|status|connect|unlock|sync-now|mirror/*`
keep their routes, request shapes and response shapes. New fields are additive.