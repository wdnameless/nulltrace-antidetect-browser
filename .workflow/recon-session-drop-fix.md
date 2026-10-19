# Recon: Sessions drop after browser update

## Root Cause (reproduced & proven)
1. **Broken DPAPI unprotect on Windows**:
   `src/main/io/cookieSqlite.ts:defaultDpapiUnprotect` invoked PowerShell:
   `powershell -NoProfile -NonInteractive -Command "[System.Security.Cryptography.ProtectedData]::Unprotect(...)"`
   Without `Add-Type -AssemblyName System.Security;`, PowerShell 5.1 throws:
   `Unable to find type [System.Security.Cryptography.ProtectedData].`
   Because `defaultDpapiUnprotect` always failed on real Windows machines, `getProfileOsKey(profileDir)` returned `undefined`.

2. **Poisoning `cookies_json` with empty strings**:
   When `persistLiveCookies` ran on profile stop/exit (including during app update graceful teardown):
   `readCookieDb` read the Chromium `Cookies` SQLite file with `osKey = undefined`.
   Every encrypted cookie returned `value: ""`.
   `persistLiveCookies` wrote these empty-string cookies into `profiles.cookies_json` in `antidetect.db`.

3. **Session clobbering on profile start**:
   On the next launch, `startProfile` passed `cfg.cookies` (`cookies_json`) to `injectCookies`.
   `injectCookies` sent CDP commands to Chromium (`browser.setCookie({ name, value: "", domain })`),
   clobbering Chromium's authenticated session cookies with blank values and logging the user out.

## Fix
1. `src/main/io/cookieSqlite.ts`:
   - Added `Add-Type -AssemblyName System.Security;` to `defaultDpapiUnprotect`. Verified real DPAPI unprotect works on Windows and yields the 32-byte AES key.
   - In `readCookieDb`, skip cookies if `row.encrypted_value` could not be decrypted and `row.value` is empty, never emitting empty string values.
2. `src/main/proxy/cookieInjector.ts`:
   - In `toSetCookieParams` and `injectCookies`, reject/skip any cookie with empty or whitespace-only `value`.
3. `src/main/launcher/chromium.ts`:
   - In `startProfile`, filter out empty cookies before calling `injectCookies`.
   - In `persistLiveCookies`, return 0 if `!osKey && process.platform === 'win32'`, and filter for non-empty cookies so empty values never overwrite `cookies_json`.
4. `src/main/db/schema.ts`:
   - In `migrate(db)`, automatically self-heal profiles where `cookies_json` was poisoned with empty values by resetting `cookies_json = NULL`, allowing Chromium to load its intact on-disk `Cookies` file.

## Verification
- Unit test added for real Windows DPAPI unprotect in `tests/unit/cookieSqlite.test.ts`.
- Unit test added in `tests/unit/proxy/cookieInjector.test.ts` for empty value rejection.
- All 18 tests in `cookieSqlite.test.ts` + `cookieInjector.test.ts` pass.
- Full typecheck (`typecheck:main` and `typecheck:renderer`) passes with 0 errors.
