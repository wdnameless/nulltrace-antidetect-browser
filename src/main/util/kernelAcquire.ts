// Pinned browser kernel assets and SHA256 digests.
// NOTE: These digests are external and pinned for upstream release 148.0.7778.215.
// They MUST be re-pinned when the upstream fingerprint-chromium version changes.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import { CHROMIUM_DIR } from '../config';
import { writeKernelVersionMarker } from './kernelLayout';

export const PINNED_KERNEL_VERSION = '148.0.7778.215';
export const UPSTREAM_RELEASE_BASE_URL = `https://github.com/adryfish/fingerprint-chromium/releases/download/${PINNED_KERNEL_VERSION}`;

export interface KernelAssetInfo {
  asset: string;
  size: number;
  sha256: string;
  archiveType: 'zip' | 'appimage' | 'tar.xz' | 'dmg';
  executableSubpath: string;
}

export const PINNED_PLATFORM_ASSETS: Record<string, KernelAssetInfo> = {
  win32: {
    asset: `ungoogled-chromium_${PINNED_KERNEL_VERSION}-1.1_windows_x64.zip`,
    size: 189767686,
    sha256: '9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579',
    archiveType: 'zip',
    executableSubpath: path.join(`ungoogled-chromium_${PINNED_KERNEL_VERSION}-1.1_windows_x64`, 'chrome.exe'),
  },
  linux: {
    asset: `ungoogled-chromium-${PINNED_KERNEL_VERSION}-1-x86_64.AppImage`,
    size: 188811768,
    sha256: 'a5fa5e6c05cb7fa3617ec2ca642ad3cc6e586ac5249cc29edb0a602d695685f0',
    archiveType: 'appimage',
    executableSubpath: `ungoogled-chromium-${PINNED_KERNEL_VERSION}-1-x86_64.AppImage`,
  },
  darwin: {
    asset: `ungoogled-chromium_${PINNED_KERNEL_VERSION}-1.1_macos.dmg`,
    size: 140187500,
    sha256: 'b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679',
    archiveType: 'dmg',
    executableSubpath: path.join('Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  },
};

export class KernelAcquireError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'KernelAcquireError';
  }
}

export interface EnsureKernelOptions {
  onProgress?: (p: { received: number; total: number }) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  targetDir?: string;
  expectedDigests?: Record<string, KernelAssetInfo>;
}

export function getPlatformAsset(
  platform: NodeJS.Platform = process.platform,
  assets: Record<string, KernelAssetInfo> = PINNED_PLATFORM_ASSETS
): KernelAssetInfo {
  const assetInfo = assets[platform];
  if (!assetInfo) {
    throw new KernelAcquireError(`Unsupported platform for kernel acquisition: ${platform}`, 'ERR_UNSUPPORTED_PLATFORM');
  }
  return assetInfo;
}

export function getKernelDirectory(overrideDir?: string): string {
  return overrideDir ?? path.join(CHROMIUM_DIR, 'fingerprint-chromium');
}

/**
 * Mount a macOS kernel disk image, copy the application bundle out of it, and detach.
 *
 * Measured on an M1 runner against the pinned image, which is what the code below assumes:
 *   - the image mounts read-only and contains exactly one `.app` plus an `Applications` symlink;
 *   - the bundle carries the upstream ad-hoc signature (`org.chromium.Chromium`, Mach-O arm64);
 *   - it arrives with `com.apple.quarantine` set, and macOS refuses to launch a quarantined
 *     download — so the attribute is cleared, exactly as the README documents for our own app;
 *   - the executable lives at `Contents/MacOS/<name>`, matching the pinned `executableSubpath`.
 *
 * `hdiutil` output is parsed rather than assumed because the mount point is NOT fixed: with a
 * stale mount present the same image lands on `/Volumes/Chromium 1`.
 */
function extractDmg(dmgPath: string, kernelDir: string, assetInfo: KernelAssetInfo): void {
  const run = (cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  const attach = run('hdiutil', ['attach', '-nobrowse', '-readonly', '-plist', dmgPath]);
  if (attach.status !== 0) {
    throw new KernelAcquireError(
      `Failed to mount kernel disk image: ${attach.stderr.trim() || `hdiutil exited ${attach.status}`}`,
      'ERR_EXTRACTION_FAILED'
    );
  }
  const mountPoint = (attach.stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
  if (!mountPoint) {
    throw new KernelAcquireError('hdiutil reported success but no mount point', 'ERR_EXTRACTION_FAILED');
  }

  try {
    // The bundle name comes from the pinned `executableSubpath` rather than from listing the
    // image: the subpath is what `ensureKernel` later resolves the executable against, so taking
    // the name from anywhere else could copy one bundle and then look for another.
    const appName = assetInfo.executableSubpath.split(path.sep)[0];
    const srcApp = path.join(mountPoint, appName);
    if (!fs.existsSync(srcApp)) {
      throw new KernelAcquireError(
        `The image does not contain the expected bundle ${appName}`,
        'ERR_EXTRACTION_FAILED'
      );
    }

    // A previous interrupted run can leave a half-copied bundle. Replacing it is the intent, but
    // the removal must be VERIFIED: if the old tree survives, `cp -R` merges into it and the
    // result is a blend of two extractions, which no digest covers and which can hold a mix of
    // binaries. Better to fail than to leave a kernel that is neither version.
    const destApp = path.join(kernelDir, appName);
    fs.rmSync(destApp, { recursive: true, force: true });
    if (fs.existsSync(destApp)) {
      throw new KernelAcquireError(
        `Cannot replace the existing kernel bundle at ${destApp} (still present after removal)`,
        'ERR_EXTRACTION_FAILED'
      );
    }

    // `cp -R` and not a recursive JavaScript copy: the bundle contains symlinks (its frameworks),
    // and `fs.cpSync`'s default would either follow or flatten them, producing a bundle macOS
    // refuses to load.
    const copy = run('cp', ['-R', srcApp, destApp]);
    if (copy.status !== 0) {
      throw new KernelAcquireError(
        `Failed to copy the kernel bundle out of the image: ${copy.stderr.trim() || `cp exited ${copy.status}`}`,
        'ERR_EXTRACTION_FAILED'
      );
    }

    // A downloaded bundle is quarantined; without this macOS refuses the launch inside it.
    run('xattr', ['-dr', 'com.apple.quarantine', destApp]);
  } finally {
    // In a finally so a failure above cannot leave the image mounted — a leaked mount would make
    // the NEXT acquisition land on `/Volumes/Chromium 1` and confuse anything that assumed a path.
    //
    // A failed detach is REPORTED, not swallowed: an image left mounted keeps its volume in the
    // user's Finder and, worse, silently changes the mount point of the next attempt. The error
    // says what to do, because nothing in the app can unmount it later.
    const detach = run('hdiutil', ['detach', mountPoint, '-force']);
    if (detach.status !== 0) {
      console.error(
        `[kernelAcquire] the kernel image could not be unmounted and is still mounted at ${mountPoint}. ` +
          `Eject it in Finder, or run: hdiutil detach '${mountPoint}' -force. ` +
          `Reason: ${detach.stderr.trim() || `hdiutil exited ${detach.status}`}`
      );
    }
  }
}

/** How long an abandoned download must be untouched before it is safe to remove. */
const STALE_DOWNLOAD_MS = 60 * 60 * 1000;

/**
 * Remove download files abandoned by an earlier attempt.
 *
 * A 134-190 MB partial `.download-*` file is otherwise never reclaimed: the cleanup paths only
 * know the file they created themselves, so a crash or a kill during the download leaves that
 * payload in the operator's kernel folder forever.
 *
 * Age-gated on purpose. Two acquisitions of the SAME kernel cannot run concurrently in this
 * process (`api/routes/kernel.ts` joins an in-flight install, and the desktop shell is a
 * single-instance app), so a recent file belongs to a live attempt — most likely this very call —
 * and only files older than `STALE_DOWNLOAD_MS` are treated as abandoned. The check is a
 * heuristic, and it is deliberately biased towards leaving a file alone.
 */
function removeStaleDownloads(kernelDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(kernelDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_DOWNLOAD_MS;
  for (const name of entries) {
    if (!name.startsWith('.download-') || !name.endsWith('.tmp')) continue;
    const file = path.join(kernelDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
      }
    } catch {
      // A file that vanished or cannot be read is not this function's problem.
    }
  }
}

/**
 * Ensures the browser kernel is present, downloaded, verified, and extracted.
 * Fails closed on hash mismatch, network failure, or truncation.
 */
export async function ensureKernel(opts: EnsureKernelOptions = {}): Promise<{ executablePath: string; kernelDir: string }> {
  const platform = opts.platform ?? process.platform;
  const assets = opts.expectedDigests ?? PINNED_PLATFORM_ASSETS;
  const assetInfo = getPlatformAsset(platform, assets);
  const kernelDir = getKernelDirectory(opts.targetDir);
  const executablePath = path.join(kernelDir, assetInfo.executableSubpath);

  // If kernel is already present and executable exists, return early without downloading
  if (fs.existsSync(executablePath)) {
    return { executablePath, kernelDir };
  }

  const fetchImpl = opts.fetchFn ?? fetch;
  const downloadUrl = `${UPSTREAM_RELEASE_BASE_URL}/${assetInfo.asset}`;

  fs.mkdirSync(kernelDir, { recursive: true });
  // Reclaim what a previous crash left behind, before adding to it.
  removeStaleDownloads(kernelDir);

  const tmpDownloadPath = path.join(kernelDir, `.download-${Date.now()}-${assetInfo.asset}.tmp`);

  try {
    let res;
    try {
      res = await fetchImpl(downloadUrl, {
        signal: opts.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'antidetect-browser/kernelAcquire' },
      });
    } catch (netErr: unknown) {
      if (opts.signal?.aborted) {
        throw new KernelAcquireError('Kernel download aborted', 'ERR_ABORTED');
      }
      const message = netErr instanceof Error ? netErr.message : String(netErr);
      throw new KernelAcquireError(
        `Cannot acquire browser kernel: no network connection available (${message})`,
        'ERR_NO_NETWORK'
      );
    }

    if (!res.ok || !res.body) {
      throw new KernelAcquireError(`Kernel download failed with HTTP ${res.status}: ${res.statusText}`, 'ERR_HTTP');
    }

    const contentLengthHeader = res.headers.get('content-length');
    const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : assetInfo.size;

    const hash = crypto.createHash('sha256');
    const writeStream = fs.createWriteStream(tmpDownloadPath);

    let receivedBytes = 0;

    await new Promise<void>((resolve, reject) => {
      res.body.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        hash.update(chunk);
        opts.onProgress?.({ received: receivedBytes, total: totalBytes });
      });

      res.body.on('error', (err: Error) => {
        reject(new KernelAcquireError(`Kernel download interrupted: ${err.message}`, 'ERR_STREAM'));
      });

      writeStream.on('error', (err: Error) => {
        reject(new KernelAcquireError(`Failed to write kernel download: ${err.message}`, 'ERR_FS_WRITE'));
      });

      writeStream.on('finish', () => {
        resolve();
      });

      res.body.pipe(writeStream);
    });

    const actualSha256 = hash.digest('hex').toLowerCase();
    const expectedSha256 = assetInfo.sha256.toLowerCase();

    if (actualSha256 !== expectedSha256) {
      // Fail closed: Remove the corrupted payload immediately so nothing usable or broken remains
      try {
        fs.unlinkSync(tmpDownloadPath);
      } catch {
        // ignore unlink error
      }
      throw new KernelAcquireError(
        `Kernel digest mismatch for ${assetInfo.asset}: expected ${expectedSha256}, got ${actualSha256}`,
        'ERR_DIGEST_MISMATCH'
      );
    }

    // Verification succeeded: Extract or prepare binary
    if (assetInfo.archiveType === 'zip') {
      try {
        const zip = new AdmZip(tmpDownloadPath);
        zip.extractAllTo(kernelDir, true);
      } catch (extractErr: unknown) {
        const message = extractErr instanceof Error ? extractErr.message : String(extractErr);
        throw new KernelAcquireError(`Failed to extract kernel zip archive: ${message}`, 'ERR_EXTRACTION_FAILED');
      }
    } else if (assetInfo.archiveType === 'appimage') {
      // For AppImage on Linux, moving it to executable location and making it executable
      if (platform === 'linux') {
        const dest = executablePath;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(tmpDownloadPath, dest);
        try {
          fs.chmodSync(dest, 0o755);
        } catch {
          // ignore chmod errors if running on unsupported FS
        }
      } else {
        throw new KernelAcquireError(
          `AppImage extraction for ${platform} is not supported on host OS ${process.platform}`,
          'ERR_UNSUPPORTED_HOST_EXTRACTION'
        );
      }
    } else if (assetInfo.archiveType === 'dmg') {
      // macOS ships the kernel as a disk image, not a zip, so this branch has its own shape:
      // mount, copy the bundle out, detach. Every step was measured on Apple Silicon (M1) before
      // being written — `scripts/probe-macos-kernel.mjs` mounted this exact pinned image and
      // recorded what it produced.
      if (platform !== 'darwin' || process.platform !== 'darwin') {
        throw new KernelAcquireError(
          `macOS DMG extraction is not supported on host OS ${process.platform}`,
          'ERR_UNSUPPORTED_HOST_EXTRACTION'
        );
      }
      extractDmg(tmpDownloadPath, kernelDir, assetInfo);
    } else {
      throw new KernelAcquireError(`Unsupported archive type: ${assetInfo.archiveType}`, 'ERR_UNSUPPORTED_ARCHIVE');
    }

    // Clean up temporary download file after successful extraction
    try {
      fs.unlinkSync(tmpDownloadPath);
    } catch {
      // ignore
    }

    if (!fs.existsSync(executablePath)) {
      throw new KernelAcquireError(
        `Kernel extracted successfully but executable not found at expected path: ${executablePath}`,
        'ERR_EXECUTABLE_NOT_FOUND'
      );
    }

    // Record the version where the report can find it on EVERY platform. A directory name carries
    // it on Windows and a file name on Linux; the macOS build directory is `Chromium.app` and
    // carries nothing, so without this marker a macOS install reads as "not installed".
    writeKernelVersionMarker(kernelDir, PINNED_KERNEL_VERSION);

    return { executablePath, kernelDir };
  } catch (err) {
    // Fail closed: clean up tmp download file if it exists
    if (fs.existsSync(tmpDownloadPath)) {
      try {
        fs.unlinkSync(tmpDownloadPath);
      } catch {
        // ignore
      }
    }
    throw err;
  }
}
