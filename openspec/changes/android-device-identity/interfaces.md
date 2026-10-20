# Interfaces — android-device-identity

Boundaries this change owns or touches. Owner: main-process Android zone
(`src/main/android/`); callers: API routes, renderer.

## `AndroidInstance.prepareProfile()` (owner: `instance.ts`)

```ts
prepareProfile(): Promise<DeviceIdentityResult & { effective: Record<string, string> }>
```

- Precondition: instance exists and `status.state === 'running'` (route
  answers 409 `NOT_RUNNING` otherwise).
- Postcondition: instance left `running` with per-boot services up whenever
  the guest boots; failures returned in `result.errors`, never thrown
  (except a boot failure, which throws the coded boot error).
- Idempotent: expected model already served → no restart, empty `applied`.

## `DeviceIdentityResult` + `FIXED_IDENTITY_KEYS` (owner: `deviceIdentity.ts`)

```ts
interface DeviceIdentityResult {
  applied: string[];        // the ten ro.product.* keys, on a successful write
  fixed: string[];          // FIXED_IDENTITY_KEYS — reported, not faked
  rebootRequired: boolean;  // true after the write, false in every returned result
  errors: string[];
}
export const FIXED_IDENTITY_KEYS: string[]; // 8 keys, single source of truth
```

`instance.ts` (already-prepared short-circuit) and `deviceIdentity.ts`
(post-write result) MUST both use the constant — no second literal list.

## Internal instance helpers (owner: `instance.ts`)

```ts
private spawnAndWaitForBoot(): Promise<void>       // state → booting; spawn + boot race
private startGuestServices(): Promise<void>        // inject → network → geo → stream
private stopGuestServices(): Promise<void>         // best-effort teardown, shared by stop()
private restartGuestProcess(): Promise<void>       // stopGuestServices → kill → spawn → boot
```

`restartGuestProcess` tears services down and leaves them down; the caller
MUST call `startGuestServices()` before returning (both success and failure
paths do).

## `POST /api/v1/android/profiles/:id/prepare` (owner: `routes/android.ts`)

- No instance → launches the profile and returns `{ status, prepared }`.
- Not `running` → `409 { code: -1, data: { code: 'NOT_RUNNING' } }`.
- Running → `{ code: 0, data: { status, prepared: { effective, errors } } }`.
- Long call (one-time, minutes): the client MUST NOT time out aggressively.

## Renderer (owner: `pages/Android.tsx`, `api.ts`)

- `api.androidPrepare(profileId)` → `{ status, prepared }`.
- `Prepare Device` drops `streamTicket` BEFORE the call (the restart kills
  the stream host), then `await checkStatus()`; the poll loop re-acquires a
  fresh ticket on `running`.

## Removed

- `AdbClient.reboot()` — the host `adb reboot` verb; no callers remain.
  `waitForDisconnect()` stays: the restart path uses it to observe the gap.
