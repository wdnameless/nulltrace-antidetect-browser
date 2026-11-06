---
name: nulltrace-browser
description: When you need to operate a website inside a NullTrace profile, read this Skill by default. Use it to run sandboxed browser rounds, fill forms, click buttons, take CSS-pixel screenshots, capture semantic snapshots, extract page data, and orchestrate tabs. Prefer browser.run_round single-round scripts over chains of one-action tool calls.
metadata:
  version: "0.6.90"
  bootstrap: "true"
---

# nulltrace-browser

Before any browser task, read the full guide for the installed version:

- `references/round-guide.md` in this Skill directory.

It lists every `app.browser.*` / `app.motion.*` verb, the selector grammar,
snapshot scopes, receipt/handoff rules, and runnable round examples. Re-read
it after an app upgrade, or when any output says to.

The guide ends with a line starting `[nulltrace:skill] end of guide`. If that
line is missing, the read was truncated: read the file in parts.

## Quick start

One round, not N tool calls. Put the whole action chain in one script:

```json
{
  "name": "browser.run_round",
  "arguments": {
    "profile_id": "prof_123",
    "timeout_ms": 25000,
    "code": "await app.browser.goto('https://example.com/login');\nconst snap = await app.browser.snapshot({ scope: 'viewport' });\nreturn { snapshot: snap.text };"
  }
}
```

Rules that are always true:

- One `profile_id` per goal; tabs inside it are `p1`, `p2`, ….
- Semantic first: `snapshot()` + `@ref` selectors. Screenshots + `motion.click`
  coordinates only for canvas / maps / editors without DOM semantics.
- Screenshot pixels are CSS pixels — click them as-is, no DPR math.
- `USER_IN_CONTROL` (HTTP 409): the operator took the profile. Stop, do not
  retry or route around. Resume only after they hand it back.
- End the final round with a fresh `snapshot()` so the next round can act.

## References

- [Full round guide](references/round-guide.md) — required reading, re-read after upgrades.
- [Clearing cookies, cache, and storage](references/clearing-state.md) — read
  before clearing any cookie, cache, or storage; some clears reach the whole
  browser profile.
