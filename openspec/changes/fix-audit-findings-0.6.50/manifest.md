# Requirements manifest — the security and correctness fixes for 0.6.50

The operator asked for everything found by the audit to be fixed, step by step:
«Правь все по шагам» — fix all of it, in order. Twelve verified findings, each with the evidence that
made it a finding and the proof that it is fixed.

## R01 — The web panel must not execute a profile id as code

**Finding:** `uiPanel.ts` built each row as an HTML string and concatenated the RAW profile id into a
JS context: `onclick="stopP('<id>')"`. `esc()` is an HTML text escaper and does not escape a single
quote — **proven in a real browser**: `esc("p_1');window.PWNED=1;//")` returned the quote intact and
the resulting handler read `stopP('p_1');window.PWNED=1;//')`. Reachability was not limited to the
API: `adoptOrphanedProfileDirs` adopts a DIRECTORY NAME as `profiles.id` when it starts with `p_`.

**Fix:** rows are built with `createElement` + `textContent` + `addEventListener`, so the id is passed
as a JS value and never re-enters a markup or script context.
**Proof:** the hostile id renders as literal text, `#rows button` carries zero inline handlers, and
`window.PWNED` is undefined. **Red-checked:** restoring the old template produces 2 inline handlers.

## R02 — A caller-supplied URL must not be fetched from inside the machine

**Finding:** `GET /api/v1/catalog/code` validated only `/^https?:\/\//i`, and `POST /api/v1/cloud/connect`
had `normalizeUrl` with no policy at all. **Proven live:** the catalog route fetched
`http://127.0.0.1:50325/ui/key` and returned the automation API key inside its response body — and
`/ui/key` skips its same-origin check when no `Origin` header is sent, which a server-side `node-fetch`
never does.

**Fix:** one shared guard (`util/outboundUrl.ts`) requiring http(s), no embedded credentials, and a
hostname that resolves ONLY to public addresses. Applied to both routes.
**Proof:** 14/14 guard cases — loopback, `localhost`, `[::1]`, `169.254.169.254`, three RFC1918
ranges, CGNAT, embedded credentials, `file:`/`ftp:`, and a public NAME resolving private
(`127.0.0.1.nip.io`), while `https://example.com` still passes.

## R03 — Only an authenticated caller may publish agent activity

**Finding:** `eventsRouter` is mounted ABOVE `authMiddleware` so the SSE stream can validate its own
key; its `POST /api/v1/agent-activity` inherited that pre-auth position without inheriting the check.
**Proven live:** no `Authorization` header returned `200 {"ok":true}` while an auth-gated sibling
returned 401.
**Fix:** the POST validates the key through the same `suppliedKey`/`refuseUnauthorized` helpers the
stream route now shares, so the two cannot drift.

## R04 — A SOCKS5 proxy must resolve names itself

**Finding:** `proxyTransport.ts` dialed `socks5://`, which in `socks-proxy-agent` sets
`shouldLookup = true` — the LOCAL resolver sees every visited hostname before the proxy does, which is
the leak this product exists to prevent.
**Fix:** `socks5h://`. **Proof:** `shouldLookup` flips `true` → `false`, and the dependency's own
source is quoted for why. **Red-checked:** reverting the scheme fails the new guard in
`leakRegression.test.ts`.

## R05 — Every fingerprint family advertised must be selectable

**Finding:** `selectFamilyBySeed` compared a `[0,1)` fraction against a running sum of RAW weights, and
the Windows block (concatenated first, weights summing to exactly **1.000000**) always contained it.
**Measured over 20 000 seeds: 20000 Windows, 0 macOS, 0 Linux** — 12 families were unreachable dead
weight while the UI advertised the platforms.
**Fix:** scale the fraction by the catalog's total weight.
**Proof:** all 46 families now emitted; macOS 5819 and Linux 1153 over 20 000 seeds; determinism per
seed preserved; the Windows-only catalog still yields its 30 families.

## R06 — A failed launch must not leave a browser process behind

**Finding:** `firefox.ts` called `browser.launch()` before `newContext()`/`newPage()`, and the catch
returned the error without `browser.close()`, so the Camoufox process kept its user-data lock while
`running` held no record of it.
**Fix:** the launched browser is tracked outside the `try` and closed on the failure path.

## R07 — An operator-set User-Agent must reach the browser

**Finding:** `LaunchConfig.userAgent` was populated from `profiles.user_agent` and read by NEITHER
launcher (Chromium ignored it; Firefox hardcoded `undefined`), so the field appeared in the editor and
did nothing.
**Fix:** `--user-agent=<value>` is passed after the fingerprint flags. **Proof:** measured against the
kernel — `--fingerprint=1234` alone derives the UA, and adding the flag replaced it.

## R08 — A cookie database must stay inside the profiles tree

**Finding:** `target_dir` was caller-supplied, used verbatim as the profile directory, then
`mkdirSync`+`writeFileSync`'d — an arbitrary-path write, with the export variants reading an arbitrary
existing file back.
**Fix:** the field is REMOVED. Nothing needed it: the renderer, SDK and MCP never send it, and the only
callers were two tests exercising the running-profile guard. The path is now derived from `user_id`
and **contained** against `PROFILES_DIR` (a traversing id is refused rather than joined).

## R09 — One malformed row must not take down a list

**Finding:** `GET /api/v1/device/list` was the only route-layer `JSON.parse` with no `try/catch`
anywhere in the handler, so one corrupt `config_json` threw out of the map and turned the whole list
into a 500.
**Fix:** contained per row, reported as `null` rather than a fabricated `{}`.
**Proof:** two rows inserted, one malformed — both survive, the bad one yields `null`.

## R10 — A failing poll must back off, not spin

**Finding:** `pollOnce` computed the backoff from `handlePollError` into a local and `return`ed without
waiting, while `pollLoop` is a bare `while` — so a failure spun as fast as the network answered,
hammering the Telegram API during exactly the outage the backoff exists for.
**Fix:** the delay is awaited on both failing branches, interruptibly so shutdown is not held open.
**Proof:** the new guard fails if the delay is discarded again (red-checked).
**Not a bug:** the audit also claimed shutdown never stops the poller. That was WRONG —
`resetTelegramBotInstance()` → `stopPolling()` is already called from `shutdown()`. Reported honestly
rather than "fixed".

## R11 — A corrupt key file must never cause a cleartext write

**Finding:** a zero-byte `secret.key` made `Buffer.from(hex,'hex')` empty, `createCipheriv` threw, the
throw was swallowed, and `protectSecret` fell back to `'plain:' + plain`. **Reproduced:** it returned
`plain:hunter2` and reported success — a proxy password persisted in cleartext with no error anywhere.
**Fix:** the key is validated (`/^[0-9a-fA-F]{64}$/`), generated atomically (temp + rename), an
unusable existing key is REFUSED rather than silently re-keyed (which would orphan every stored
secret), and a write with no usable cipher refuses instead of storing plaintext. `plain:` remains
readable for values older builds wrote.

## R12 — A synced credential must be usable on the other machine

**Finding:** `pushToGDrive` uploaded `password_enc` VERBATIM. Those values are machine-bound (the
shipped build never calls `setSecretCipher`), so a peer's vault listed every credential while
`revealSecret` returned `undefined` for all of them — invisible on the machine that pushed.
**Proof:** two key files, one process each — verbatim gives `undefined`, re-protected gives `hunter2`.
**Fix:** the push reveals the secret on the machine that can still read it and carries it inside the
passphrase-sealed file; the pull re-protects it under the receiving machine's key. An entry with only
old-style ciphertext is SKIPPED rather than overwriting a working local credential with an unreadable
one. Malformed remote payloads are now parsed through one guarded helper, so a single bad file no
longer aborts the whole pull as an unhandled `SyntaxError`.
