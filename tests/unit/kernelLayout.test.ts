// Kernel layout, per platform.
//
// These tests exist because the lookup worked on exactly ONE of the three platforms and nothing
// caught it: `findFingerprintChromium` searched for `chrome.exe` inside every subdirectory of the
// kernel root, which matches Windows' `<payload-dir>/chrome.exe` and neither of the others.
//
//   Linux   the kernel is a FILE (an AppImage) directly in the root — `!entry.isDirectory()` skipped it
//   macOS   the binary is `<root>/Chromium.app/Contents/MacOS/Chromium` — wrong name, never matched
//
// Both then fell through to a hardcoded `'chrome.exe'` string and failed to spawn. Measured against
// the published macOS artefact: with the pinned image installed and no system Chrome, the shipped
// `getChromiumPath()` still answered `chrome.exe`. Every platform is therefore asserted here, not
// just the one the developer happens to run.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findKernelExecutable,
  findKernelExecutableIn,
  writeKernelVersionMarker,
  readKernelVersionMarker,
  KERNEL_VERSION_FILE,
} from '../../src/main/util/kernelLayout';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-layout-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

/** Build the layout the Windows kernel ZIP extracts to. */
function seedWindows(root: string, version = '148.0.7778.215'): string {
  const payload = path.join(root, `ungoogled-chromium_${version}-1.1_windows_x64`);
  fs.mkdirSync(payload, { recursive: true });
  const exe = path.join(payload, 'chrome.exe');
  fs.writeFileSync(exe, 'binary');
  return exe;
}

/** Build the layout the macOS kernel DMG extracts to. */
function seedMac(root: string, bundle = 'Chromium.app'): string {
  const exe = path.join(root, bundle, 'Contents', 'MacOS', path.basename(bundle, '.app'));
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'binary');
  return exe;
}

describe('kernel layout: the executable is found on every platform', () => {
  it('finds the Windows payload inside its versioned directory', () => {
    const expected = seedWindows(tmp);
    expect(findKernelExecutable(tmp, 'win32')).toBe(expected);
  });

  it('finds the macOS bundle binary', () => {
    const expected = seedMac(tmp);
    expect(findKernelExecutable(tmp, 'darwin')).toBe(expected);
  });

  it('finds a macOS bundle under a name other than Chromium.app', () => {
    // Upstream has shipped other bundle names; rejecting them would recreate the original bug.
    const expected = seedMac(tmp, 'ungoogled-chromium.app');
    expect(findKernelExecutable(tmp, 'darwin')).toBe(expected);
  });

  it('finds the Linux AppImage, which is a FILE in the root', () => {
    // This is the case the old directory-only scan could never match.
    const appImage = path.join(tmp, 'ungoogled-chromium-148.0.7778.215-1-x86_64.AppImage');
    fs.writeFileSync(appImage, 'binary');
    expect(findKernelExecutable(tmp, 'linux')).toBe(appImage);
  });

  it('returns null when no kernel is installed, on any platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      expect(findKernelExecutable(tmp, platform)).toBeNull();
    }
    expect(findKernelExecutable(path.join(tmp, 'does-not-exist'), 'darwin')).toBeNull();
  });

  it('does not mistake another platform layout for the current one', () => {
    // A Windows payload present on macOS must NOT satisfy a macOS lookup: the binary cannot run,
    // and reporting it would move the failure from "install the kernel" to a launch error.
    seedWindows(tmp);
    expect(findKernelExecutable(tmp, 'darwin')).toBeNull();
  });

  it('treats a bundle directory as the build directory when the scan descends into it', () => {
    // `kernelAcquire` extracts to `<root>/Chromium.app`, so the scan reaches a directory that IS
    // the bundle. Missing this case would have made the fix reproduce the bug one level down.
    const expected = seedMac(tmp);
    const bundleDir = path.join(tmp, 'Chromium.app');
    expect(findKernelExecutableIn(bundleDir, 'darwin')).toBe(expected);
  });
});

describe('kernel version marker', () => {
  it('round-trips a version', () => {
    writeKernelVersionMarker(tmp, '148.0.7778.215');
    expect(readKernelVersionMarker(tmp)).toBe('148.0.7778.215');
    expect(fs.existsSync(path.join(tmp, KERNEL_VERSION_FILE))).toBe(true);
  });

  it('reports null when there is no marker', () => {
    expect(readKernelVersionMarker(tmp)).toBeNull();
    expect(readKernelVersionMarker(path.join(tmp, 'missing'))).toBeNull();
  });

  it('creates the directory rather than failing', () => {
    const nested = path.join(tmp, 'a', 'b');
    writeKernelVersionMarker(nested, '1.2.3.4');
    expect(readKernelVersionMarker(nested)).toBe('1.2.3.4');
  });

  it('ignores an empty marker file', () => {
    fs.writeFileSync(path.join(tmp, KERNEL_VERSION_FILE), '   \n', 'utf8');
    expect(readKernelVersionMarker(tmp)).toBeNull();
  });
});
