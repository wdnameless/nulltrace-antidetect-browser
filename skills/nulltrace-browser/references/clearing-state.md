# Clearing cookies, cache, and storage

Read this file before clearing any cookie, cache, or storage. In NullTrace,
each profile owns an isolated cookie jar and storage partition — but a clear
still reaches **everything inside that profile**: every tab (`p1`, `p2`, …),
every site session, every origin. There is no undo; every site on the profile
signs out at once.

## Scope rules

- Never clear profile-wide state to fix one site. Sign-in wall or a session
  you want anonymous → clear that one origin only:

```javascript
// One origin, via an allowlisted evaluate round — never a profile-wide wipe.
await app.browser.evaluate(
  (origin) => {
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0].trim();
      document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
    });
    return origin;
  },
  await app.browser.evaluate('location.origin')
);
```

- Stale document or a resource that will not reload → re-`goto()` the URL
  instead of emptying any storage.
- `cookies.export` before any destructive experiment: an exported jar is the
  only way to restore sessions (`cookies.import`) afterwards.

## What each tool reaches

| Tool | Reaches | Getting the state back |
|---|---|---|
| origin-scoped JS clear (above) | one origin | sign in to that site |
| `profiles.delete` | **the whole profile** (jar + storage + tabs) | restore from trash if kept |
| `profiles.cleanup_preserved` | **preserved legacy data archive** | **nothing you can do** |
| `cookies.import` (overwrite) | jar entries it touches | re-export beforehand |

A command sent "through tab p2" is not scoped to p2 — profile jars are
shared across all tabs of the profile. Do not read a rejection from one verb
as permission to use a broader one.
