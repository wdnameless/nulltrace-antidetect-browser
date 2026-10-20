import type { AdbClient } from './adb';
import type { AndroidFingerprint } from './fingerprint';
import { logger } from '../util/logger';

/**
 * Per-profile device identity on the guest, the way a page sees it.
 *
 * `setprop` refuses `ro.*` even as uid 0 ("Failed to set property … See dmesg") and the
 * emulator's `-prop` is consumed before the product partition's values are applied, so the only
 * working seam is patching `/product/etc/build.prop` in the AVD's writable overlay
 * (`-writable-system`). The change survives emulator restarts because the overlay lives in the
 * profile's own userdata image.
 *
 * The block is deliberately ONLY the ten `ro.product.*` keys (generic + `ro.product.product.*`):
 * measured on this exact image, adding `ro.build.fingerprint` / `ro.build.version.*` makes the
 * next boot wedge — zygote reads the fingerprint through `-Xfingerprint`, invalidates the
 * precompiled boot image (`expected 23 uncompressed dex files, but found 1`), and re-runs
 * dex2oat forever while `sys.boot_completed` stays unset. The product keys alone publish a
 * coherent device (fingerprint included: `oppo/oppo_reno_11/…:14/…` on this android-34 image)
 * and boot in ~41 s. Keys outside this set are reported in `fixed`, not faked.
 */

/** The property file a profile's identity is written into (writable through the AVD overlay). */
export const PRODUCT_BUILD_PROP = '/product/etc/build.prop';

/** Marker appended to the file so a later pass replaces its own block instead of stacking. */
const BLOCK_START = '# >>> nulltrace device identity';
const BLOCK_END = '# <<< nulltrace device identity';

/**
 * Keys this path reports in `fixed`: owned by the emulator (`qemu-props` rewrites them after the
 * property files are read) or boot-image inputs that wedge the guest when rewritten (measured).
 */
export const FIXED_IDENTITY_KEYS = [
  'ro.serialno',
  'ro.hardware',
  'ro.build.fingerprint',
  'ro.build.version.release',
  'ro.build.version.sdk',
  'ro.kernel.qemu',
  'ro.boot.qemu',
  'ro.product.board',
];

export interface DeviceIdentityResult {
  /** Properties whose value the guest serves back after the identity was applied. */
  applied: string[];
  /** Properties the emulator owns (`qemu-props`) and this path cannot change. */
  fixed: string[];
  /** True when a reboot is required before the new identity is visible. */
  rebootRequired: boolean;
  errors: string[];
}

/**
 * Properties that define the device a page sees. Written as a block so the whole identity is one
 * atomic replacement and a second call is idempotent.
 */
function identityProperties(fp: AndroidFingerprint): Array<[string, string]> {
  const brand = fp.manufacturer.toLowerCase();
  const device = fp.presetId.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  // `ro.product.<partition>.*` wins over the generic key for that partition — this image keeps
  // its values under `ro.product.product.*`, which is what the emulator publishes as
  // `ro.product.model`. Nothing else is written: `ro.build.*`, `ro.kernel.qemu` and `ro.boot.*`
  // are either boot-image inputs (writing them wedges the next boot, measured) or owned by the
  // emulator (`qemu-props` rewrites them after the property files are read).
  return [
    ['ro.product.model', fp.model],
    ['ro.product.brand', brand],
    ['ro.product.manufacturer', fp.manufacturer],
    ['ro.product.name', device],
    ['ro.product.device', device],
    ['ro.product.product.model', fp.model],
    ['ro.product.product.brand', brand],
    ['ro.product.product.manufacturer', fp.manufacturer],
    ['ro.product.product.name', device],
    ['ro.product.product.device', device],
  ];
}

/** Escapes a value for a `.prop` line: `\` and control characters would break the parser. */
function propLine(key: string, value: string): string {
  return `${key}=${value.replace(/[\r\n]/g, ' ')}`;
}

/**
 * Applies the profile's device identity to the guest's product partition.
 *
 * Requires `-writable-system` and a successful `adb root` + `adb remount`; on a locked image this
 * returns `rebootRequired: false` with the failure in `errors` instead of pretending success.
 */
export async function applyDeviceIdentity(
  adb: AdbClient,
  fp: AndroidFingerprint,
): Promise<DeviceIdentityResult> {
  const applied: string[] = [];
  const fixed: string[] = [];
  const errors: string[] = [];

  const asRoot = await adb.root().catch((err: unknown) => ({
    ok: false,
    message: err instanceof Error ? err.message : String(err),
  }));
  if (!asRoot.ok) {
    errors.push(`adb root refused: ${asRoot.message}`);
    return { applied, fixed, rebootRequired: false, errors };
  }

  // The writable overlay needs uid 0 and a remount, and on the first boot after
  // `-writable-system` was enabled it also needs the guest to restart once before `/product`
  // stops being read-only. Retrying here (the sequence that works by hand: root, wait, remount,
  // write probe) is what makes a profile converge; the caller sees `read-only` in `errors` and
  // retries on the next start, at which point the overlay is already active.
  let writable = false;
  let current: { stdout: string; stderr: string; exitCode: number } | undefined;
  for (let attempt = 0; attempt < 6 && !writable; attempt++) {
    await adb.root().catch(() => undefined);
    // `adb root` restarts adbd, so the next command needs a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await adb.shellCode(['remount']).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // `cp` rather than a redirection: adb joins `shell` argv into one command string on the
    // device, so `>` passed as an argument is consumed by the outer shell and creates an empty
    // target (measured). Copying the file onto a probe name cannot damage it.
    const probePath = '/product/etc/.nulltrace-write-probe';
    const probe = await adb.shellCode(['cp', PRODUCT_BUILD_PROP, probePath]);
    writable = probe.exitCode === 0;
    if (writable) {
      await adb.shellCode(['rm', '-f', probePath]);
    }
  }

  if (!writable) {
    errors.push(`${PRODUCT_BUILD_PROP} stayed read-only after remount`);
    return { applied, fixed, rebootRequired: false, errors };
  }

  // Read the current file only once the partition accepts writes: an earlier attempt could have
  // truncated it, and the identity is built from whatever is actually there now.
  const backup = '/data/local/tmp/nulltrace-build.prop.bak';
  const backupResult = await adb.shellCode(['cp', PRODUCT_BUILD_PROP, backup]);
  if (backupResult.exitCode !== 0) {
    errors.push(`cannot back up ${PRODUCT_BUILD_PROP}: ${backupResult.stderr.trim()}`);
    return { applied, fixed, rebootRequired: false, errors };
  }

  const restoreBackup = async (): Promise<void> => {
    await adb.shellCode(['cp', backup, PRODUCT_BUILD_PROP]).catch(() => undefined);
  };

  current = await adb.shellCode(['cat', PRODUCT_BUILD_PROP]);
  if (current.exitCode !== 0 || current.stdout.trim().length === 0) {
    errors.push(`cannot read ${PRODUCT_BUILD_PROP}: ${current.stderr.trim() || 'file is empty'}`);
    return { applied, fixed, rebootRequired: false, errors };
  }

  // Drop a block this function wrote before, so re-applying an identity does not stack up.
  const existing = current.stdout.split(/\r?\n/);
  const kept: string[] = [];
  let insideBlock = false;
  for (const line of existing) {
    if (line.trim() === BLOCK_START) {
      insideBlock = true;
      continue;
    }
    if (line.trim() === BLOCK_END) {
      insideBlock = false;
      continue;
    }
    if (!insideBlock) kept.push(line);
  }

  const block = [
    BLOCK_START,
    ...identityProperties(fp).map(([key, value]) => propLine(key, value)),
    BLOCK_END,
  ];
  const next = `${kept.join('\n').replace(/\n+$/, '')}\n${block.join('\n')}\n`;

  // Written through a temp file by piping the bytes from this process into `adb shell cat`, so the
  // content never travels through the device's shell parser (heredocs, base64 and quoting all get
  // mangled there — measured: the staged file ended up 0 bytes, and an unquoted `>>>` marker even
  // produced a shell syntax error on the verification call).
  const temp = '/data/local/tmp/nulltrace-build.prop';
  const stage = await adb.writeFile(temp, Buffer.from(next, 'utf8'));
  if (stage.exitCode !== 0) {
    await restoreBackup();
    errors.push(`cannot stage ${PRODUCT_BUILD_PROP}: ${stage.stderr.trim()}`);
    return { applied, fixed, rebootRequired: false, errors };
  }
  // `cp` rather than `cat > file`: adb joins `shell` argv into one command string on the device,
  // so a `>` passed as a separate argument is consumed by the OUTER shell — measured: the target
  // file was created empty and `cat` wrote nowhere.
  const install = await adb.shellCode(['cp', temp, PRODUCT_BUILD_PROP]);
  if (install.exitCode !== 0) {
    await restoreBackup();
    errors.push(`cannot write ${PRODUCT_BUILD_PROP}: ${install.stderr.trim()}`);
    return { applied, fixed, rebootRequired: false, errors };
  }

  // Read the file back over adb and look for the marker locally: passing the marker (or a quoted
  // pattern) through `adb shell grep` lets the device shell tokenise it — measured: the `>>>`
  // marker produced "syntax error: unexpected '> '".
  const readBack = await adb.shellCode(['cat', PRODUCT_BUILD_PROP]);
  if (readBack.exitCode !== 0 || !readBack.stdout.includes(BLOCK_START)) {
    await restoreBackup();
    errors.push(`${PRODUCT_BUILD_PROP} does not contain the identity block after writing`);
    return { applied, fixed, rebootRequired: false, errors };
  }

  for (const [key] of identityProperties(fp)) {
    applied.push(key);
  }
  fixed.push(...FIXED_IDENTITY_KEYS);
  logger.info('Applied per-profile device identity', {
    model: fp.model,
    brand: fp.manufacturer,
    properties: applied.length,
  });

  return { applied, fixed, rebootRequired: true, errors };
}

/**
 * Reads what the guest currently reports, so the caller can state the effective device instead of
 * the intended one.
 */
export async function readDeviceIdentity(
  adb: AdbClient,
  keys: string[] = ['ro.product.model', 'ro.product.brand', 'ro.product.device', 'ro.build.fingerprint'],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    try {
      out[key] = (await adb.shell(['getprop', key])).trim();
    } catch {
      out[key] = '';
    }
  }
  return out;
}
