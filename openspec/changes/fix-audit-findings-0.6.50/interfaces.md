# Interfaces — what this release changed at each boundary

## New module

```ts
// src/main/util/outboundUrl.ts — THE policy for a caller-supplied URL.
export interface UrlPolicyResult {
  ok: boolean;
  error?: string;   // operator-facing, safe to return and log
  url?: URL;        // present only when ok
}
export async function assertPublicHttpUrl(raw: string): Promise<UrlPolicyResult>;
```

Two routes took a URL from the request and fetched it server-side: the script catalog validated only
`/^https?:\/\//i`, and cloud-connect validated nothing. Both now call this one guard, so the policy
cannot drift between them.

## Hardened shared helper (fanout checked)

```ts
// src/main/util/ipInfo.ts
export function isPrivateOrLocal(ip: string): boolean;
```

Now unwraps IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`), strips zone indices, and adds
`0/8`, `198.18/15`, `240/4`, `255.255.255.255`, `192.0.0.0/24`, `::`.

**Fanout:** called by `proxyManager.resolveProxyHost`, which treats a RESOLUTION TO PRIVATE as
suspicious and retries over public DNS. The change makes that classification stricter, so it
strengthens that path rather than weakening it; its tests pass unchanged.

## Changed signatures and boundaries

| Module | Boundary | Change |
|---|---|---|
| `api/routes/events.ts` | pre-auth router (mounted above `authMiddleware` so `EventSource` can pass `?key=`) | `refuseUnauthorized(res)` and `suppliedKey(req)` are shared by the SSE GET and the agent-activity POST, so the pre-auth pair cannot drift apart |
| `api/uiPanel.ts` | panel markup | rows built via `createElement`/`textContent`/`addEventListener`; the profile id is a JS VALUE, never re-entering a markup or script context |
| `proxy/proxyTransport.ts` | SOCKS5 dial | `socks5h://` — the proxy resolves names; `shouldLookup` verified `true`→`false` at runtime |
| `fingerprints/derivation.ts` | `selectFamilyBySeed(seed, catalog?)` | scales the fraction by total catalog weight instead of a raw cumulative sum (Windows summed to exactly 1.0 and swallowed every seed) |
| `api/routes/cookies.ts` | import/export schema | `target_dir` REMOVED; `profileDirForCookies(userId)` derives and CONTAINS the path under `PROFILES_DIR` |
| `util/secretStore.ts` | `protectSecret` | key validated `/^[0-9a-fA-F]{64}$/`, written temp+rename; an unusable existing key is REFUSED (never silently re-keyed, which would orphan stored secrets); with no usable cipher it returns `null` instead of writing `plain:<secret>` |
| `cloud/gdriveTransfer.ts` | vault payload | secrets travel as revealed plaintext inside the passphrase-sealed file and are re-protected on pull; `parseRemoteJson` guards every remote payload so one bad file cannot abort a pull |
| `launcher/firefox.ts` | `startFirefox` error path | the launched browser is tracked outside the `try` and closed on failure |
| `launcher/chromium.ts` | launch args | `--user-agent=<value>` passed when `cfg.userAgent` is set (measured against the kernel) |
| `telegram/bot.ts` | `pollOnce` | `sleepInterruptibly(ms)` awaits the computed backoff and wakes immediately on shutdown |

## Deliberate ceilings, recorded

- `ponytail: DNS-rebinding window remains` — the SSRF guard resolves and rejects private answers, but a
  name can resolve public at check time and private at dial time. Closing it properly needs the
  resolved IP pinned into the request, which `node-fetch` does not expose. `upgrade: pin the IP when a
  fetch stack that allows it is adopted.`
- The SSRF guard does not follow redirects itself, so a public URL that 302s to a private one is
  still a residual path when the caller follows it. `upgrade: re-check the Location on each hop.`
- `secretStore` refuses to write when no cipher is available rather than degrading to cleartext. An
  operator with a corrupt key file sees a logged refusal and a failed save, which is the intended
  trade: a visible failure over a silent one.

## Ownership

Single author for this release. No concurrent writer touched these files; the kernel-lookup fix that
landed as 0.6.49 upstream overlaps only `launcher/chromium.ts`, and the rebase was resolved by
keeping both changes.
