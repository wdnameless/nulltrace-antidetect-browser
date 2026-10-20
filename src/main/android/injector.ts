// Android guest identity injector over ADB.
// Traced to requirements R08, R09: hardware identity spoofing and emulator artifact removal.
// Every step is try/caught individually so partial failures are recorded in `errors`
// while all remaining steps continue executing.

import type { AdbClient } from './adb';
import type { AndroidFingerprint } from './fingerprint';
import { logger } from '../util/logger';

export interface InjectResult {
  applied: string[];
  skipped: string[];
  errors: string[];
  /**
   * How much of the identity could actually be applied. `full` means the read-only `ro.*`
   * properties and the emulator artefacts were rewritten; `setprop-only` means the guest still
   * answers as an emulator to a careful check. Callers must surface the difference rather than
   * treating a partial application as a clean spoof.
   */
  privilege: 'full' | 'setprop-only';
}

/** Message of an unknown thrown value. */
function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Attempts to give the ADB daemon root on the guest.
 *
 * This is the enabling step for R08/R09: read-only `ro.*` properties cannot be rewritten through
 * an unprivileged `setprop`, and the goldfish/QEMU artefacts live where only root may write. It
 * succeeds only on a `userdebug`/`eng` image — which is why the engine installs the `google_apis`
 * variant rather than the locked Play Store one — and returns false rather than throwing when the
 * guest refuses, so the caller can report the downgrade instead of failing the whole launch.
 *
 * The proof is a follow-up `id` reading `uid=0`, not the text of the `root` answer: the daemon
 * restarts asynchronously, and a `root` that printed "restarting adbd as root" over a guest that
 * still answers as `shell` would otherwise be reported as success.
 */
export async function enableGuestRoot(adb: AdbClient): Promise<boolean> {
  const answer = await adb.root().catch((err: unknown) => ({
    ok: false,
    message: toErrorMessage(err),
  }));

  if (!answer.ok) {
    logger.warn('Guest refused adb root; identity spoofing is limited to settable properties', {
      answer: answer.message,
    });
    return false;
  }

  // `adb root` restarts adbd, so the next command needs a moment to land.
  for (let attempt = 1; attempt <= 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const id = await adb.shell(['id']);
      if (/\buid=0\b/.test(id)) {
        return true;
      }
    } catch {
      // adbd is still restarting; try again.
    }
  }

  logger.warn('adb root answered but the guest still runs adbd as a non-root uid');
  return false;
}

/**
 * Probes the guest over ADB to detect whether a Magisk/Zygisk spoof module (or resetprop) is present.
 * Fails closed and returns false on any shell error.
 */
export async function detectSpoofModule(adb: AdbClient): Promise<boolean> {
  try {
    const res = await adb.shell(['which', 'resetprop']);
    if (res && res.trim().length > 0 && !res.includes('not found')) {
      return true;
    }
  } catch {
    // resetprop not found in guest PATH
  }

  try {
    const res = await adb.shell(['ls', '/data/adb/modules']);
    if (res && !res.includes('No such file') && !res.includes('not found')) {
      return true;
    }
  } catch {
    // /data/adb/modules missing or inaccessible
  }

  return false;
}

/**
 * Applies the mobile identity to a booted guest over ADB.
 * Every step is idempotent and individually try/caught so that errors are reported in `errors`
 * rather than terminating the pipeline prematurely.
 *
 * Steps:
 * 1. build.prop props via `resetprop` when Zygisk is present and supported, else `setprop`
 *    (reports downgrade in skipped list).
 * 2. android_id via `settings put secure android_id`.
 * 3. IMEI/MAC written to /data/adb/ JSON config if spoof module is detected, else recorded in skipped.
 * 4. Emulator artifact removal (ro.kernel.qemu, goldfish hardware/board, qemu props) when module is present.
 * 5. Locale and timezone settings.
 * 6. Screen density via `wm density`.
 */
export async function injectGuestIdentity(
  adb: AdbClient,
  fp: AndroidFingerprint,
  opts?: {
    timezone?: string | null;
    locale?: string | null;
    hasZygisk?: boolean;
  }
): Promise<InjectResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  /** Identity properties whose value the guest actually serves after the write. */
  let roPropsApplied = 0;

  // Root is the prerequisite for every write below that touches a read-only property or an
  // emulator artefact. Detected once here so the rest of the pipeline can branch on a fact
  // rather than on a guess.
  const hasRoot = await enableGuestRoot(adb);
  const hasModule = await detectSpoofModule(adb);
  // `resetprop` (from Magisk) is the other way to rewrite `ro.*`; either mechanism is enough.
  const useResetProp = hasModule;
  const canWriteReadOnlyProps = hasRoot || useResetProp;

  if (!canWriteReadOnlyProps) {
    logger.warn(
      'Guest has neither root nor a spoof module: read-only identity properties and emulator ' +
        'artefacts cannot be rewritten, so the guest remains detectable as an emulator',
    );
  }

  if (opts?.hasZygisk && !hasModule) {
    skipped.push('resetprop (spoof module not present; relying on adb root instead)');
    logger.warn('Zygisk requested but spoof module not detected on guest');
  }

  // 1. build.prop identity properties
  const propsToSet: Array<{ key: string; value: string }> = [
    { key: 'ro.product.model', value: fp.model },
    { key: 'ro.product.brand', value: fp.manufacturer.toLowerCase() },
    { key: 'ro.product.name', value: fp.presetId },
    { key: 'ro.product.device', value: fp.presetId },
    { key: 'ro.product.manufacturer', value: fp.manufacturer },
    { key: 'ro.build.id', value: fp.buildId },
    { key: 'ro.build.display.id', value: fp.buildId },
    { key: 'ro.build.version.release', value: fp.androidVersion },
    { key: 'ro.build.version.sdk', value: String(fp.sdkInt) },
    { key: 'ro.build.fingerprint', value: fp.buildFingerprint },
    { key: 'ro.serialno', value: fp.serial },
  ];

  const tool = useResetProp ? 'resetprop' : 'setprop';
  for (const { key, value } of propsToSet) {
    try {
      await adb.shell([tool, key, value]);
      // A `ro.` property is immutable after init even for uid 0: `setprop` exits non-zero and
      // the old value stays. Only a read-back can tell an applied spoof from a no-op, so the
      // classification below is made from the guest's answer, never from the command's success.
      const actual = await adb.shell(['getprop', key]);
      if (actual === value) {
        applied.push(`${tool}:${key}`);
        roPropsApplied += 1;
      } else {
        skipped.push(`${tool}:${key} (still ${actual || '<unset>'})`);
      }
    } catch (err: unknown) {
      errors.push(`${tool}:${key}: ${toErrorMessage(err)}`);
    }
  }

  // These properties are `ro.` (read-only). Without root or resetprop the writes above either
  // fail or appear to succeed while the old value is still served, so say plainly that the
  // identity is not fully applied rather than reporting a spoof that will not survive a check.
  if (!canWriteReadOnlyProps) {
    skipped.push('build_prop:ro.* (needs adb root or a spoof module; values unchanged)');
  }

  // 2. Android ID
  try {
    await adb.shell(['settings', 'put', 'secure', 'android_id', fp.androidId]);
    applied.push('settings:android_id');
  } catch (err: unknown) {
    errors.push(`settings:android_id: ${toErrorMessage(err)}`);
  }

  // 3. IMEI and MAC identity config in /data/adb/ (requires spoof module)
  if (hasModule) {
    try {
      const configPayload = JSON.stringify({
        imei: fp.imei,
        mac: fp.wifiMac,
        serial: fp.serial,
        model: fp.model,
        manufacturer: fp.manufacturer,
        android_id: fp.androidId,
      });
      await adb.shell(['sh', '-c', `echo '${configPayload}' > /data/adb/identity.json`]);
      applied.push('spoof_module:identity_config');
    } catch (err: unknown) {
      errors.push(`spoof_module:identity_config: ${toErrorMessage(err)}`);
    }
  } else {
    skipped.push('spoof_module:identity_config (spoof module not present)');
  }

  // 4. Emulator artefact removal. Needs either resetprop or root: these props are `ro.*`, and
  // the files they mirror are outside what an unprivileged shell may write. As above, only a
  // read-back proves the artefact is gone — `setprop x ''` on an immutable prop exits 0 and
  // leaves the value in place on some builds.
  let artifactsRemoved = 0;
  if (canWriteReadOnlyProps) {
    const clearProp = async (key: string): Promise<boolean> => {
      await adb.shellCode([tool, '--delete', key]);
      const remaining = await adb.shell(['getprop', key]);
      return remaining.length === 0;
    };

    const clearOne = async (key: string) => {
      try {
        if (await clearProp(key)) {
          applied.push(`emulator_artifacts:${key}`);
          artifactsRemoved += 1;
        } else {
          skipped.push(`emulator_artifacts:${key} (still served by the guest)`);
        }
      } catch (err: unknown) {
        errors.push(`emulator_artifacts:${key}: ${toErrorMessage(err)}`);
      }
    };

    await clearOne('ro.kernel.qemu');
    await clearOne('ro.boot.qemu');
    await clearOne('ro.kernel.android.qemud');

    // Force ro.hardware and ro.product.board off goldfish
    try {
      await adb.shellCode([tool, 'ro.hardware', fp.presetId]);
      await adb.shellCode([tool, 'ro.product.board', fp.presetId]);
      const hardware = await adb.shell(['getprop', 'ro.hardware']);
      if (hardware === fp.presetId) {
        applied.push('emulator_artifacts:goldfish');
        artifactsRemoved += 1;
      } else {
        skipped.push(`emulator_artifacts:goldfish (still ${hardware || '<unset>'})`);
      }
    } catch (err: unknown) {
      errors.push(`emulator_artifacts:goldfish: ${toErrorMessage(err)}`);
    }
  } else {
    skipped.push('emulator_artifacts:ro.kernel.qemu (needs adb root or a spoof module)');
    skipped.push('emulator_artifacts:goldfish (needs adb root or a spoof module)');
    skipped.push('emulator_artifacts:qemu_props (needs adb root or a spoof module)');
  }

  // 5. Locale
  if (opts?.locale) {
    try {
      await adb.shell(['setprop', 'persist.sys.locale', opts.locale]);
      applied.push(`locale:${opts.locale}`);
    } catch (err: unknown) {
      errors.push(`locale: ${toErrorMessage(err)}`);
    }
  } else {
    skipped.push('locale');
  }

  // 6. Timezone
  if (opts?.timezone) {
    try {
      await adb.shell(['setprop', 'persist.sys.timezone', opts.timezone]);
      applied.push(`timezone:${opts.timezone}`);
    } catch (err: unknown) {
      errors.push(`timezone: ${toErrorMessage(err)}`);
    }
  } else {
    skipped.push('timezone');
  }

  // 7. Screen density
  if (fp.screen && typeof fp.screen.densityDpi === 'number') {
    try {
      await adb.shell(['wm', 'density', String(fp.screen.densityDpi)]);
      applied.push(`density:${fp.screen.densityDpi}`);
    } catch (err: unknown) {
      errors.push(`density: ${toErrorMessage(err)}`);
    }
  } else {
    skipped.push('density');
  }

  // `full` claims the identity survives a careful check, so it is granted only when the read-back
  // proved it: an emulator that answered as `root` but still serves the old `ro.*` values is
  // `setprop-only`, which is a degraded posture the caller surfaces rather than a launch failure.
  const privilege: InjectResult['privilege'] =
    roPropsApplied === propsToSet.length && artifactsRemoved > 0 ? 'full' : 'setprop-only';

  if (privilege === 'setprop-only') {
    logger.warn(
      `Guest identity is only partially applied: ${roPropsApplied}/${propsToSet.length} identity ` +
        `properties verified, ${artifactsRemoved} emulator artefacts removed`,
    );
  }

  logger.info('Injected guest identity', {
    appliedCount: applied.length,
    skippedCount: skipped.length,
    errorsCount: errors.length,
    privilege,
    hasRoot,
    hasModule,
  });

  return { applied, skipped, errors, privilege };
}
