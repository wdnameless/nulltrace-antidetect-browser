# Recon — launch Android emulator and install TikTok

T1 lane: user asked to launch the emulator and install TikTok, fixing
blockers; the emulator itself is the goal.

## Touched files

- `src/main/android/adb.ts` — `install()` takes an optional timeout
  (default 600 s instead of the 20 s global). A 477 MB APK needs minutes
  for push + dexopt; the old budget killed every large install mid-push
  (`ERR_ANDROID_ADB_TIMEOUT`).
- No other code changed: launch, prepare, stream, network paths untouched.

## Acceptance check

- Launch: `launchAndroidProfile(p_31c8acbb-…)` → `state=running` in ~47 s
  as `CPH2609 / oppo_reno_11`, 223 packages, stream ticket issuable.
- APK: TikTok 47.4.2 (`versionCode=2024704020`, 477 289 021 bytes, ZIP
  magic + EOCD verified) from APKPure direct link
  `https://d.apkpure.com/b/APK/com.zhiliaoapp.musically?versionCode=…`
  (apkcombo.com is NXDOMAIN; host DNS broken, resolved via DoH).
- Install: `adb install` → `pm path` returns
  `/data/app/…/com.zhiliaoapp.musically-…/base.apk`,
  `versionName=47.4.2`, launcher `SplashActivity` resolvable.
- Run: TikTok process alive (`pidof` answers), `mFocusedApp` is
  `I18nSignUpActivityWithNoAnimation`, screencap shows the real
  Terms-of-Service / Sign-up screen (ARM-only APK runs through
  `libndk_translation`, no crash, no tombstone).
- `npx tsc -p tsconfig.main.json --noEmit` clean.

## Notes for automation

- The APK ships ARM native libs only (301 arm64-v8a + 296 armeabi-v7a
  `.so`, zero x86_64); the x86_64 guest runs it via NDK translation.
- This profile has no proxy, so `blockGuestNetwork` drops guest OUTPUT
  (fail-closed) — TikTok UI renders but cannot reach the network until a
  profile proxy is configured.
- Saved under `.tmp/` (gitignored): `tiktok.apk`, screencaps; scratch
  launch scripts removed.
