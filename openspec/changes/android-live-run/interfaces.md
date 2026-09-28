# interfaces.md — android-live-run

Frozen before build. Boundaries, signatures, owners. Desktop slice untouched.

| Зона | Владелец | Файлы |
|---|---|---|
| A1 acquisition | AndroidCore | `src/main/android/packageManager.ts` |
| A2 adb resolve | AndroidStream | `src/main/android/adb.ts` (без изменений, только потребитель) |
| A3 install gate | AndroidWiring | `src/main/api/routes/android.ts` |
| B1 install UI | AndroidShell | `src/renderer/src/pages/Android.tsx` (только текст ошибки/прогресс, если уже есть) |
| T1 tests | AndroidCore | `tests/unit/android*.test.ts`, новый `tests/unit/androidLiveRun.test.ts` |

## Signatures (exact)

```ts
// packageManager.ts — новый ассет в таблице, формат без изменений:
interface AndroidAssetInfo {
  file: string; url: string; size: number | null;
  sha256: string | null; sha1: string | null;
  archiveType: 'zip' | 'tar.gz' | 'plain';
  marker: string; // platform-tools: path.join('platform-tools', '.installed')
}
export declare const ANDROID_ENGINE_ASSETS: Record<string, AndroidAssetInfo[]>;
export declare function ensureAndroidEngine(opts?: {
  apiLevel?: number;
  onProgress?: (p: { asset: string; received: number; total: number | null }) => void;
  signal?: AbortSignal; fetchFn?: typeof fetch; engineDir?: string;
  platform?: AndroidPlatform; assets?: Record<string, AndroidAssetInfo[]>;
  systemImages?: Record<number, Record<string, AndroidAssetInfo[]>>;
}): Promise<{ engineDir: string; emulatorPath: string; systemImageDir: string }>;

// platform.ts — без изменений, только вызывается из install-роута:
export declare function resolveAndroidPlatform(opts?: { platform?: NodeJS.Platform; arch?: string }): AndroidPlatform;
export declare function assertHypervisorReady(p: AndroidPlatform): Promise<void>;

// routes/android.ts — POST /api/v1/android/engine/install:
// до скачивания: resolveAndroidPlatform() → assertHypervisorReady(platform).
// Ошибка гипервизора → { code: -1, msg, data: { code: 'ERR_ANDROID_NO_HYPERVISOR' } }, 200 envelope.
// Прогресс уже есть через onProgress? — если нет, оставить как есть, не выдумывать SSE.
```

## Constraints

1. Digest pinning: каждый новый ассет несёт SHA-1 из живого `repository2-3.xml`; `sha256+sha1 === null` запрещён (`ERR_ANDROID_DIGEST_UNPINNED` уже покрывает).
2. platform-tools zip содержит верхнюю папку `platform-tools/`; marker и `resolveAdbPath` обязаны сойтись на `platform-tools/adb(.exe)`. Распаковка обязана сохранить это (проверить `extractZipStreaming` + выбор `extractDir` в acquisition: платформенный zip без `emulator/`-префикса может лечь не туда — чинить в зоне A1).
3. Эмулятор `16416033` / system image `x86_64-34_r14` — пины из живого фида на 2026-09-28; системный имидж уже сверен (`e0f6c9a0…`, 1563721130 B).
4. Install-gate не меняет успешный путь: гипервизор OK → тот же `ensureAndroidEngine({apiLevel})`.
5. R18/desktop: `resolveLaunchConfig`, `profileManager`, лаунчеры — вне зоны, не трогать.
6. Живой прогон (boot/inject/stream на железе) — делает оператор; здесь: юнит-зелень + эта спека.
