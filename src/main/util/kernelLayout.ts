// Where the browser kernel's executable lives inside its installation root, per platform.
//
// A LEAF module on purpose. `config.ts` must FIND an installed kernel and `util/kernelAcquire.ts`
// must EXTRACT one; `kernelAcquire` already imports `config` (for CHROMIUM_DIR), so `config`
// importing `kernelAcquire` back would close a cycle this project has been bitten by before (see
// the note in `fingerprints/crc32.ts`). Both sides depend on this file instead, so the knowledge
// has one home.
//
// WHY ONE HOME MATTERS HERE. The two sides disagreed, and the disagreement was invisible on the one
// platform that was tested. `findFingerprintChromium` looked for `chrome.exe` inside every
// SUBDIRECTORY of the kernel root, which matches exactly one of the three layouts:
//
//   Windows  <root>/<payload-dir>/chrome.exe                       — a directory, found
//   Linux    <root>/ungoogled-chromium-<version>.AppImage          — a FILE, never found
//   macOS    <root>/Chromium.app/Contents/MacOS/Chromium           — a directory, wrong name, never found
//
// On Windows the lookup succeeded and profiles launched, so nothing looked wrong. On the other two
// the lookup returned nothing, fell through to a hardcoded `'chrome.exe'` string, and the spawn
// failed with ENOENT — a kernel correctly installed and unusable. Measured against the published
// macOS artefact: with the pinned image installed and no system Chrome, `getChromiumPath()` still
// answered `chrome.exe`.
import * as fs from 'fs';
import * as path from 'path';

/** The file `kernelAcquire` writes to record which kernel version a directory holds. */
export const KERNEL_VERSION_FILE = '.kernel-version';

/**
 * The executable's path INSIDE a macOS bundle, relative to the bundle directory.
 *
 * Deliberately excludes the bundle name: callers join this with either the bundle itself or the
 * root that contains it. Returning the whole `Chromium.app/Contents/…` from here made the
 * scan-into-a-bundle case produce `Chromium.app/Chromium.app/Contents/…` — a bug its own test
 * caught before it shipped.
 */
function bundleInnerExecutable(bundleName: string): string {
  return path.join('Contents', 'MacOS', path.basename(bundleName, '.app'));
}

/**
 * The executable for `platform` inside a single kernel build directory, or null.
 *
 * `buildDir` is ONE build (e.g. `…/fingerprint-chromium/ungoogled-chromium_148…_windows_x64`), not
 * the root that contains it — `findKernelExecutable` walks the root, because several builds may
 * coexist there.
 */
export function findKernelExecutableIn(
  buildDir: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform === 'linux') {
    // The AppImage is itself the executable and sits directly in the build directory.
    try {
      const found = fs
        .readdirSync(buildDir)
        .find((f) => f.endsWith('.AppImage') || f === 'chrome' || f === 'chromium');
      return found ? path.join(buildDir, found) : null;
    } catch {
      return null;
    }
  }

  if (platform === 'darwin') {
    // A bundle is BOTH the build directory and the container, depending on which level the caller
    // is at: `kernelAcquire` extracts to `<root>/Chromium.app`, so when the scan descends into that
    // name the directory IS the bundle. Checking only for a nested `.app` would miss it and
    // reproduce the original bug with extra steps.
    if (buildDir.endsWith('.app')) {
      const exe = path.join(buildDir, bundleInnerExecutable(path.basename(buildDir)));
      return fs.existsSync(exe) ? exe : null;
    }
    // Otherwise the caller is at the kernel root: accept ANY `*.app` whose binary is named after
    // the bundle, because upstream has shipped other names and a kernel placed by hand should not
    // be rejected for that.
    try {
      for (const entry of fs.readdirSync(buildDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
        const exe = path.join(buildDir, entry.name, bundleInnerExecutable(entry.name));
        if (fs.existsSync(exe)) return exe;
      }
    } catch {
      // unreadable directory counts as "no kernel here", like a missing one
    }
    return null;
  }

  const exe = path.join(buildDir, 'chrome.exe');
  return fs.existsSync(exe) ? exe : null;
}

/**
 * The kernel executable under `root`, or null.
 *
 * Tries the root ITSELF first (Linux keeps its AppImage there) and then each subdirectory
 * (Windows' payload directory, macOS's bundle). Both shapes are checked because assuming only one
 * is how the lookup came to work on Windows alone.
 */
export function findKernelExecutable(root: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!fs.existsSync(root)) return null;

  const direct = findKernelExecutableIn(root, platform);
  if (direct) return direct;

  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = findKernelExecutableIn(path.join(root, entry.name), platform);
      if (found) return found;
    }
  } catch {
    // ignore scan errors, as before
  }
  return null;
}

/**
 * Record the kernel version extracted into `kernelDir`.
 *
 * The version is otherwise inferred from a DIRECTORY NAME, which works on Windows (the payload
 * directory carries it) and fails on macOS, where the directory is `Chromium.app` and contains no
 * version at all. Without this marker a macOS install is reported as "not installed", so the UI
 * offers a 134 MB download that is already on disk.
 *
 * Best-effort by design: an unmarked kernel still RUNS, it is only reported less precisely.
 */
export function writeKernelVersionMarker(kernelDir: string, version: string): void {
  try {
    fs.mkdirSync(kernelDir, { recursive: true });
    fs.writeFileSync(path.join(kernelDir, KERNEL_VERSION_FILE), `${version}\n`, 'utf8');
  } catch {
    // Not fatal — see above.
  }
}

/** The version recorded by `writeKernelVersionMarker`, or null when there is none. */
export function readKernelVersionMarker(kernelDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(kernelDir, KERNEL_VERSION_FILE), 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
