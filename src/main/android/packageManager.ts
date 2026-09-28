import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { DATA_DIR } from '../config';
import { logger } from '../util/logger';
import { resolveAndroidPlatform, AndroidPlatform, AndroidPlatformError } from './platform';
import { listZipEntries, extractZipStreaming } from './zipExtract';

export interface AndroidAssetInfo {
  /** File name inside the engine dir. */
  file: string;
  url: string;
  /** Byte size, or null when the vendor did not publish one. */
  size: number | null;
  /**
   * Pinned SHA-256, lowercase hex — or null when not pinned at that strength.
   * Preferred when present; verification falls back to `sha1` otherwise.
   */
  sha256: string | null;
  /**
   * Pinned SHA-1, lowercase hex — the digest Google actually publishes.
   *
   * Google's repository XML (`repository2-3.xml`, and the `sys-img` family) carries only
   * `<checksum type="sha1">`: there is no SHA-256 feed to pin against. Declaring null here
   * rather than recording a digest would mean shipping an installer that can never verify
   * anything, so the published SHA-1 is pinned and reported honestly as SHA-1 rather than
   * being laundered into the `sha256` field. When both are null, acquisition throws
   * ERR_ANDROID_DIGEST_UNPINNED — null is never "skip verification".
   */
  sha1: string | null;
  /**
   * How the payload is unpacked after verification.
   * `plain` = the verified bytes ARE the artifact (no archive to expand).
   */
  archiveType: 'zip' | 'tar.gz' | 'plain';
  /** Marker path (relative to engine dir) whose existence means "already installed". */
  marker: string;
}

// Google publishes the official Android emulator and system image archives under dl.google.com,
// and does publish their digests — but only SHA-1, as <checksum type="sha1"> entries inside
// repository2-3.xml (emulator) and sys-img/google_apis/sys-img2-3.xml (system images).
// There is no SHA-256 feed, so these builds are pinned with the published SHA-1 rather than
// nulled out: a null digest would make acquisition impossible rather than merely weaker.
// Digests and file names below are transcribed from those manifests; the build/revision numbers
// matter, because a stale revision yields a URL that 404s rather than a clean digest failure.
// Genymobile publishes the scrcpy server jar for each release; the version here MUST match the
// version string passed to `app_process ... com.genymobile.scrcpy.Server` in streamHost.ts, or the
// guest server rejects the invocation. Unlike the Google feeds above, scrcpy publishes no digest
// file, so this SHA-256 was computed from the real release asset
// (https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4, 69007 bytes)
// and reproduced byte-identically across two independent fetches.
export const SCRCPY_SERVER_VERSION = '2.4';
export const SCRCPY_SERVER_FILE = `scrcpy-server-v${SCRCPY_SERVER_VERSION}`;
export const SCRCPY_SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_SERVER_VERSION}/${SCRCPY_SERVER_FILE}`;
export const SCRCPY_SERVER_SHA256 = '93c272b7438605c055e127f7444064ed78fa9ca49f81156777fd201e79ce7ba3';
export const SCRCPY_SERVER_SIZE = 69007;
/** Installed name: the guest-side classpath entry streamHost pushes and executes. */
export const SCRCPY_SERVER_JAR_NAME = 'scrcpy-server.jar';

/**
 * The scrcpy server jar, acquired like every other engine artifact: downloaded, digest-verified
 * while streaming, and only then installed. It is not an archive, so it is written straight to
 * its final name once the digest matches.
 */
const SCRCPY_SERVER_ASSET: AndroidAssetInfo = {
  file: SCRCPY_SERVER_JAR_NAME,
  url: SCRCPY_SERVER_URL,
  size: SCRCPY_SERVER_SIZE,
  sha256: SCRCPY_SERVER_SHA256,
  sha1: null,
  archiveType: 'plain',
  marker: SCRCPY_SERVER_JAR_NAME,
};
// Pin source: repository2-3.xml <remotePackage path="platform-tools"> r37.0.1 (macosx universal)
const PLATFORM_TOOLS_DARWIN_ASSET: AndroidAssetInfo = {
  file: 'platform-tools_r37.0.1-darwin.zip',
  url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-darwin.zip',
  size: 16110554,
  sha256: null,
  sha1: '6ae73f4de6452dc57e62ec02b68eed92a4c21661',
  archiveType: 'zip',
  marker: path.join('platform-tools', '.installed'),
};

// The guest-side server is architecture-independent Java, so one asset serves every host.
export const ANDROID_ENGINE_ASSETS: Record<string, AndroidAssetInfo[]> = {
  'windows-x86_64': [
    // Pin source: repository2-3.xml <remotePackage path="emulator"> 37.2.11 (windows x64)
    {
      file: 'emulator-windows_x64-16416033.zip',
      url: 'https://dl.google.com/android/repository/emulator-windows_x64-16416033.zip',
      size: 455343456,
      sha256: null,
      sha1: '387bb4bbfd873525629ed6d763e83c56c9ea0bee',
      archiveType: 'zip',
      marker: path.join('emulator', '.installed'),
    },
    // Pin source: repository2-3.xml <remotePackage path="platform-tools"> r37.0.1 (windows)
    {
      file: 'platform-tools_r37.0.1-win.zip',
      url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-win.zip',
      size: 8044989,
      sha256: null,
      sha1: 'e03e78b1d80b396f1c3358e31251cb31740e1110',
      archiveType: 'zip',
      marker: path.join('platform-tools', '.installed'),
    },
    SCRCPY_SERVER_ASSET,
  ],
  'macos-arm64-v8a': [
    // Pin source: repository2-3.xml <remotePackage path="emulator"> revision 16416033 (darwin aarch64)
    {
      file: 'emulator-darwin_aarch64-16416033.zip',
      url: 'https://dl.google.com/android/repository/emulator-darwin_aarch64-16416033.zip',
      size: 416112721,
      sha256: null,
      sha1: 'c4495b1e8754e1bcbc2377c2bf848f0f49375451',
      archiveType: 'zip',
      marker: path.join('emulator', '.installed'),
    },
    PLATFORM_TOOLS_DARWIN_ASSET,
    SCRCPY_SERVER_ASSET,
  ],
  'macos-x86_64': [
    // Pin source: repository2-3.xml <remotePackage path="emulator"> revision 16416033 (darwin x64)
    {
      file: 'emulator-darwin_x64-16416033.zip',
      url: 'https://dl.google.com/android/repository/emulator-darwin_x64-16416033.zip',
      size: 488735281,
      sha256: null,
      sha1: 'a316e93e9cf7a706ac35e194f896d8c6d019c6b3',
      archiveType: 'zip',
      marker: path.join('emulator', '.installed'),
    },
    PLATFORM_TOOLS_DARWIN_ASSET,
    SCRCPY_SERVER_ASSET,
  ],
  'linux-x86_64': [
    // Pin source: repository2-3.xml <remotePackage path="emulator"> revision 16416033 (linux x64)
    {
      file: 'emulator-linux_x64-16416033.zip',
      url: 'https://dl.google.com/android/repository/emulator-linux_x64-16416033.zip',
      size: 349656125,
      sha256: null,
      sha1: 'e25fcb8a7afcdb5b4e2930ee236f7e3819e60291',
      archiveType: 'zip',
      marker: path.join('emulator', '.installed'),
    },
    // Pin source: repository2-3.xml <remotePackage path="platform-tools"> r37.0.1 (linux)
    {
      file: 'platform-tools_r37.0.1-linux.zip',
      url: 'https://dl.google.com/android/repository/platform-tools_r37.0.1-linux.zip',
      size: 9054187,
      sha256: null,
      sha1: '477254aa5f903c15cf51001717bdf347fb6b53e0',
      archiveType: 'zip',
      marker: path.join('platform-tools', '.installed'),
    },
    SCRCPY_SERVER_ASSET,
  ],
};

// The system image is the `google_apis` variant, NOT `google_apis_playstore`.
//
// This is what makes R08/R09 possible at all: spoofing identity needs writes to read-only
// `ro.*` properties and the removal of goldfish/QEMU artefacts, and both require root. The
// Play Store image ships as a locked production build where `adb root` is refused, so on it
// every one of those steps can only ever be reported as skipped. The operator's chosen stack
// («AOSP + Zygisk/Magisk + tun2socks») presumes a rootable AOSP-based image, which is this one.
//
// Digests are the SHA-1 values Google publishes for these builds in
// sys-img/google_apis/sys-img2-3.xml; sizes match the byte counts the CDN advertises.
/** SDK tag of the system image variant above; the marker, the asset URL and the extraction
 * target all derive from it, so they cannot disagree about which image is installed. */
export const ANDROID_SYSTEM_IMAGE_TAG = 'google_apis';

export const ANDROID_SYSTEM_IMAGES: Record<number, Record<string, AndroidAssetInfo[]>> = {
  34: {
    'windows-x86_64': [
      {
        file: 'x86_64-34_r14.zip',
        url: 'https://dl.google.com/android/repository/sys-img/google_apis/x86_64-34_r14.zip',
        size: 1563721130,
        sha256: null,
        sha1: 'e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7',
        archiveType: 'zip',
        marker: path.join('system-images', 'android-34', 'google_apis', 'x86_64', '.installed'),
      },
    ],
    'macos-arm64-v8a': [
      {
        file: 'arm64-v8a-34_r14.zip',
        url: 'https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-34_r14.zip',
        size: 1610393229,
        sha256: null,
        sha1: '2fe8b46d419a3400e30f31b0152b241b50c8b99f',
        archiveType: 'zip',
        marker: path.join('system-images', 'android-34', 'google_apis', 'arm64-v8a', '.installed'),
      },
    ],
    'macos-x86_64': [
      {
        file: 'x86_64-34_r14.zip',
        url: 'https://dl.google.com/android/repository/sys-img/google_apis/x86_64-34_r14.zip',
        size: 1563721130,
        sha256: null,
        sha1: 'e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7',
        archiveType: 'zip',
        marker: path.join('system-images', 'android-34', 'google_apis', 'x86_64', '.installed'),
      },
    ],
    'linux-x86_64': [
      {
        file: 'x86_64-34_r14.zip',
        url: 'https://dl.google.com/android/repository/sys-img/google_apis/x86_64-34_r14.zip',
        size: 1563721130,
        sha256: null,
        sha1: 'e0f6c9a0691aa27bd597d0deb1bcfdc943ac8ca7',
        archiveType: 'zip',
        marker: path.join('system-images', 'android-34', 'google_apis', 'x86_64', '.installed'),
      },
    ],
  },
};interface FetchResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: {
    get?(name: string): string | null;
    [key: string]: unknown;
  };
  body?: unknown;
}

/** What the Node stream shim returns from `on()`/`pipe()`: the emitter itself, or the sink. */
interface StreamSubscription {
  addListener(listener: (chunk: Buffer) => void): StreamSubscription;
  cancel(): void;
}

interface NodeStreamLike {
  on(event: 'data', listener: (chunk: Buffer) => void): StreamSubscription | void;
  on(event: 'error', listener: (err: Error) => void): StreamSubscription | void;
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
}

interface WebReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array | Buffer }>;
}

interface WebStreamLike {
  getReader(): WebReaderLike;
}

function isNodeStreamLike(val: unknown): val is NodeStreamLike {
  return (
    typeof val === 'object' &&
    val !== null &&
    'on' in val &&
    typeof (val as { on: unknown }).on === 'function' &&
    'pipe' in val &&
    typeof (val as { pipe: unknown }).pipe === 'function'
  );
}

function isWebStreamLike(val: unknown): val is WebStreamLike {
  return (
    typeof val === 'object' &&
    val !== null &&
    'getReader' in val &&
    typeof (val as { getReader: unknown }).getReader === 'function'
  );
}


export interface AndroidEngineStatus {
  installed: boolean;
  engineDir: string;
  emulatorPath: string | null;
  /** API levels whose system image is present. */
  installedApiLevels: number[];
  /** Asset files that are defined with `sha256: null`; non-empty => install is refused. */
  unpinnedAssets: string[];
  platform: AndroidPlatform | null;
  error?: { code: string; message: string };
}

export type AndroidAcquireErrorCode =
  | 'ERR_ANDROID_DIGEST_UNPINNED'
  | 'ERR_ANDROID_DIGEST_MISMATCH'
  | 'ERR_ANDROID_DOWNLOAD_FAILED'
  | 'ERR_ANDROID_EXTRACTION_FAILED'
  | 'ERR_ANDROID_ABORTED';

export class AndroidAcquireError extends Error {
  constructor(message: string, public readonly code: AndroidAcquireErrorCode) {
    super(message);
    this.name = 'AndroidAcquireError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * How long an abandoned download file must remain untouched before it is safe to reclaim.
 * Matches the 1-hour heuristic established in kernelAcquire.
 */
const STALE_DOWNLOAD_MS = 60 * 60 * 1000;

/**
 * Cleans up abandoned .download-*.tmp files left behind by an earlier process crash or abrupt abort.
 * Only files older than STALE_DOWNLOAD_MS are removed so we never race with a concurrent live attempt.
 */
export function removeStaleDownloads(engineDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(engineDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_DOWNLOAD_MS;
  for (const name of entries) {
    if (!name.startsWith('.download-') || !name.endsWith('.tmp')) continue;
    const file = path.join(engineDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
      }
    } catch {
      // File already vanished or inaccessible; not this function's concern.
    }
  }
}

/**
 * Synchronously checks whether the Android engine and system images are installed on disk.
 * Performs NO network requests.
 *
 * An engine is considered `installed` only when its installation marker file is present AND
 * the emulator executable actually exists on disk.
 */
export function getAndroidEngineStatus(opts?: {
  engineDir?: string;
  platform?: AndroidPlatform;
  assets?: Record<string, AndroidAssetInfo[]>;
}): AndroidEngineStatus {
  let platform: AndroidPlatform | null = null;
  let error: { code: string; message: string } | undefined;

  try {
    platform = opts?.platform ?? resolveAndroidPlatform();
  } catch (err: unknown) {
    if (err instanceof AndroidPlatformError) {
      error = { code: err.code, message: err.message };
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      error = { code: 'ERR_ANDROID_UNSUPPORTED_HOST', message: msg };
    }
  }

  const engineDir = opts?.engineDir ?? path.join(DATA_DIR, 'android');

  let emulatorPath: string | null = null;
  let emulatorExecutableExists = false;
  if (platform) {
    const candidatePath = path.join(engineDir, platform.emulatorSubpath);
    if (fs.existsSync(candidatePath)) {
      emulatorPath = candidatePath;
      emulatorExecutableExists = true;
    }
  }

  // Scan disk for installed API levels under system-images/
  const installedApiLevels: number[] = [];
  const sysImgBase = path.join(engineDir, 'system-images');
  if (fs.existsSync(sysImgBase)) {
    try {
      const dirs = fs.readdirSync(sysImgBase);
      for (const d of dirs) {
        const match = d.match(/^android-(\d+)$/);
        if (match) {
          const lvl = parseInt(match[1], 10);
          const lvlDir = path.join(sysImgBase, d);
          if (fs.existsSync(lvlDir)) {
            installedApiLevels.push(lvl);
          }
        }
      }
    } catch {
      // Disk read errors result in empty scan.
    }
  }

  // Check known API levels from ANDROID_SYSTEM_IMAGES
  if (platform) {
    const platformKey = `${platform.host}-${platform.abi}`;
    for (const [levelStr, imagesByPlatform] of Object.entries(ANDROID_SYSTEM_IMAGES)) {
      const lvl = parseInt(levelStr, 10);
      const assets = imagesByPlatform[platformKey] ?? [];
      if (assets.length > 0 && assets.every((a) => fs.existsSync(path.join(engineDir, a.marker)))) {
        if (!installedApiLevels.includes(lvl)) {
          installedApiLevels.push(lvl);
        }
      }
    }
  }
  installedApiLevels.sort((a, b) => a - b);

  // Check if engine assets have their installed marker present
  let engineMarkerPresent = false;
  if (platform) {
    const platformKey = `${platform.host}-${platform.abi}`;
    const engineAssets = opts?.assets?.[platformKey] ?? ANDROID_ENGINE_ASSETS[platformKey] ?? [];
    if (engineAssets.length > 0) {
      const allMarkersPresent = engineAssets.every((a) => fs.existsSync(path.join(engineDir, a.marker)));
      const emulatorInstalled = fs.existsSync(path.join(engineDir, 'emulator', '.installed'));
      const scrcpyInstalled = fs.existsSync(path.join(engineDir, SCRCPY_SERVER_JAR_NAME));
      engineMarkerPresent = allMarkersPresent || (emulatorInstalled && scrcpyInstalled);
    }
  }

  const installed = Boolean(engineMarkerPresent && emulatorExecutableExists);

  // Collect unpinned assets (no pinned digest at any strength) as file names
  const unpinnedAssets: string[] = [];
  if (platform) {
    const platformKey = `${platform.host}-${platform.abi}`;
    const engineAssets = ANDROID_ENGINE_ASSETS[platformKey] ?? [];
    for (const a of engineAssets) {
      if (a.sha256 === null && a.sha1 === null && !unpinnedAssets.includes(a.file)) {
        unpinnedAssets.push(a.file);
      }
    }
    for (const imagesByPlatform of Object.values(ANDROID_SYSTEM_IMAGES)) {
      const sysAssets = imagesByPlatform[platformKey] ?? [];
      for (const a of sysAssets) {
        if (a.sha256 === null && a.sha1 === null && !unpinnedAssets.includes(a.file)) {
          unpinnedAssets.push(a.file);
        }
      }
    }
  } else {
    for (const assets of Object.values(ANDROID_ENGINE_ASSETS)) {
      for (const a of assets) {
        if (a.sha256 === null && a.sha1 === null && !unpinnedAssets.includes(a.file)) {
          unpinnedAssets.push(a.file);
        }
      }
    }
    for (const imagesByPlatform of Object.values(ANDROID_SYSTEM_IMAGES)) {
      for (const assets of Object.values(imagesByPlatform)) {
        for (const a of assets) {
          if (a.sha256 === null && a.sha1 === null && !unpinnedAssets.includes(a.file)) {
            unpinnedAssets.push(a.file);
          }
        }
      }
    }
  }

  const status: AndroidEngineStatus = {
    installed,
    engineDir,
    emulatorPath,
    installedApiLevels,
    unpinnedAssets,
    platform,
  };

  if (error) {
    status.error = error;
  }

  return status;
}

/**
 * Downloads, verifies, and extracts the Android emulator and required system image.
 *
 * Follows the kernelAcquire pipeline:
 * 1. Checks for unpinned assets FIRST before touching network or disk; fails immediately if any are unpinned.
 * 2. Purges stale partial downloads older than 1 hour.
 * 3. Streams downloads to a temporary file while hashing the incoming bytes with
 *    crypto.createHash() using the algorithm actually pinned for that asset (SHA-256 when set,
 *    otherwise the published SHA-1) so the full archive (~350MB - 1.5GB) is NEVER buffered in RAM.
 * 4. Verifies byte size when provided; fails closed if truncated.
 * 5. Verifies the calculated digest against the pinned digest; on mismatch, deletes the temporary file immediately.
 * 6. Installs the verified payload: `zip` and `tar.gz` are unpacked, `plain` is moved into place
 *    under its final name; on any failure the temporary file is deleted and no marker is written.
 * 7. Writes the marker file LAST so a half-installed engine is never reported installed. A `plain`
 *    asset is its own marker — its presence is the proof that it verified.
 */
export async function ensureAndroidEngine(opts?: {
  apiLevel?: number;
  onProgress?: (p: { asset: string; received: number; total: number | null }) => void;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  engineDir?: string;
  platform?: AndroidPlatform;
  assets?: Record<string, AndroidAssetInfo[]>;
  systemImages?: Record<number, Record<string, AndroidAssetInfo[]>>;
}): Promise<{ engineDir: string; emulatorPath: string; systemImageDir: string }> {
  const platform = opts?.platform ?? resolveAndroidPlatform();
  const platformKey = `${platform.host}-${platform.abi}`;
  const apiLevel = opts?.apiLevel ?? 34;

  const engineAssetsRecord = opts?.assets ?? ANDROID_ENGINE_ASSETS;
  const systemImagesRecord = opts?.systemImages ?? ANDROID_SYSTEM_IMAGES;

  const engineAssets = engineAssetsRecord[platformKey] ?? [];
  const sysAssets = systemImagesRecord[apiLevel]?.[platformKey] ?? [];

  if (engineAssets.length === 0) {
    throw new AndroidAcquireError(
      `No emulator engine assets configured for platform ${platformKey}`,
      'ERR_ANDROID_DOWNLOAD_FAILED'
    );
  }
  if (sysAssets.length === 0) {
    throw new AndroidAcquireError(
      `No system image assets configured for API level ${apiLevel} on platform ${platformKey}`,
      'ERR_ANDROID_DOWNLOAD_FAILED'
    );
  }

  const allAssets = [...engineAssets, ...sysAssets];

  // Hard fail-closed requirement: Unpinned assets MUST be rejected loudly BEFORE any network request.
  // "Pinned" means either a SHA-256 or the SHA-1 Google actually publishes — an asset with neither
  // has nothing to verify against, so installing it would be trusting whatever the network returned.
  const unpinned = allAssets.filter((a) => a.sha256 === null && a.sha1 === null);
  if (unpinned.length > 0) {
    const first = unpinned[0];
    throw new AndroidAcquireError(
      `no pinned digest for ${first.file}.\n` +
      `Verify the official digest of ${first.url} against Google's published repository metadata\n` +
      `(repository2-3.xml / sys-img2-3.xml) and pin it in ANDROID_ENGINE_ASSETS in\n` +
      `src/main/android/packageManager.ts before installing.`,
      'ERR_ANDROID_DIGEST_UNPINNED'
    );
  }

  const engineDir = opts?.engineDir ?? path.join(DATA_DIR, 'android');
  const emulatorPath = path.join(engineDir, platform.emulatorSubpath);
  const systemImageDir = path.join(
    engineDir,
    'system-images',
    `android-${apiLevel}`,
    ANDROID_SYSTEM_IMAGE_TAG,
    platform.abi
  );

  // If all assets are already installed and the emulator executable is present, return early.
  const allInstalled = allAssets.every((a) => fs.existsSync(path.join(engineDir, a.marker))) &&
    fs.existsSync(emulatorPath);
  if (allInstalled) {
    return { engineDir, emulatorPath, systemImageDir };
  }

  if (opts?.signal?.aborted) {
    throw new AndroidAcquireError('Android engine acquisition aborted', 'ERR_ANDROID_ABORTED');
  }

  fs.mkdirSync(engineDir, { recursive: true });
  removeStaleDownloads(engineDir);

  const fetchImpl = opts?.fetchFn ?? fetch;

  for (const asset of allAssets) {
    const markerFullPath = path.join(engineDir, asset.marker);
    if (fs.existsSync(markerFullPath)) {
      continue;
    }

    if (opts?.signal?.aborted) {
      throw new AndroidAcquireError('Android engine acquisition aborted', 'ERR_ANDROID_ABORTED');
    }

    logger.info(`Acquiring Android asset ${asset.file} from ${asset.url}`);

    const tmpDownloadPath = path.join(engineDir, `.download-${Date.now()}-${asset.file}.tmp`);

    try {
      let res: FetchResponseLike;
      try {
        const rawRes = await fetchImpl(asset.url, {
          signal: opts?.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'antidetect-browser/androidPackageManager' },
        });
        // SAFETY: `fetch` returns the runtime `Response` type, which structural typing cannot
        // match against `FetchResponseLike` because the declarations come from different
        // TypeScript lib sets. Only `ok`, `status`, `statusText`, `headers.get` and `body` are
        // read, and each is re-validated at its use site (`headers.get` is feature-tested,
        // `body` is narrowed by isNodeStreamLike/isWebStreamLike) before any byte is consumed.
        res = rawRes as unknown as FetchResponseLike;
      } catch (netErr: unknown) {
        if (opts?.signal?.aborted) {
          throw new AndroidAcquireError('Android engine acquisition aborted', 'ERR_ANDROID_ABORTED');
        }
        const msg = netErr instanceof Error ? netErr.message : String(netErr);
        throw new AndroidAcquireError(
          `Cannot download Android asset ${asset.file}: ${msg}`,
          'ERR_ANDROID_DOWNLOAD_FAILED'
        );
      }

      if (!res.ok || !res.body) {
        throw new AndroidAcquireError(
          `Asset download failed with HTTP ${res.status}: ${res.statusText}`,
          'ERR_ANDROID_DOWNLOAD_FAILED'
        );
      }

      let contentLengthHeader: string | null = null;
      if (res.headers && typeof res.headers.get === 'function') {
        contentLengthHeader = res.headers.get('content-length');
      } else if (res.headers && typeof res.headers['content-length'] === 'string') {
        contentLengthHeader = res.headers['content-length'];
      }
      const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : asset.size;

      const hash = crypto.createHash(asset.sha256 !== null ? 'sha256' : 'sha1');
      const writeStream = fs.createWriteStream(tmpDownloadPath);
      let receivedBytes = 0;

      // Stream the response body directly to disk and hash incrementally to avoid high memory pressure.
      if (isNodeStreamLike(res.body)) {
        const nodeStream = res.body;
        await new Promise<void>((resolve, reject) => {
          nodeStream.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            hash.update(chunk);
            opts?.onProgress?.({ asset: asset.file, received: receivedBytes, total: totalBytes });
          });
          nodeStream.on('error', (err: Error) => {
            reject(new AndroidAcquireError(`Asset download stream interrupted: ${err.message}`, 'ERR_ANDROID_DOWNLOAD_FAILED'));
          });
          writeStream.on('error', (err: Error) => {
            reject(new AndroidAcquireError(`Failed to write download file: ${err.message}`, 'ERR_ANDROID_DOWNLOAD_FAILED'));
          });
          writeStream.on('finish', () => resolve());
          nodeStream.pipe(writeStream);
        });
      } else if (isWebStreamLike(res.body)) {
        const reader = res.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            receivedBytes += chunk.length;
            hash.update(chunk);
            writeStream.write(chunk);
            opts?.onProgress?.({ asset: asset.file, received: receivedBytes, total: totalBytes });
          }
          await new Promise<void>((resolve, reject) => {
            writeStream.end(() => resolve());
            writeStream.on('error', reject);
          });
        } catch (err: unknown) {
          writeStream.destroy();
          throw new AndroidAcquireError(
            `Asset download stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
            'ERR_ANDROID_DOWNLOAD_FAILED'
          );
        }
      } else {
        throw new AndroidAcquireError('Unsupported response body stream type', 'ERR_ANDROID_DOWNLOAD_FAILED');
      }

      // Truncation check: When size is explicitly known, incomplete byte transfers fail closed.
      if (asset.size !== null && receivedBytes < asset.size) {
        throw new AndroidAcquireError(
          `Download truncated for ${asset.file}: expected ${asset.size} bytes, received ${receivedBytes}`,
          'ERR_ANDROID_DOWNLOAD_FAILED'
        );
      }

      // Prefer SHA-256 when a build is pinned at that strength; Google publishes only SHA-1 for
      // the emulator and system images, so SHA-1 is the digest actually in force today. The
      // algorithm is named in the mismatch message so a failure is diagnosable without guessing.
      const algorithm = asset.sha256 !== null ? 'sha256' : 'sha1';
      const expectedDigest = (asset.sha256 ?? asset.sha1)!.toLowerCase();
      const gotDigest = hash.digest('hex').toLowerCase();

      if (gotDigest !== expectedDigest) {
        throw new AndroidAcquireError(
          `Digest mismatch for ${asset.file}: expected ${algorithm}:${expectedDigest}, got ${algorithm}:${gotDigest}`,
          'ERR_ANDROID_DIGEST_MISMATCH'
        );
      }

      // Extraction: unpack to target engine directory
      logger.info(`Extracting verified archive ${asset.file}`);
      if (asset.archiveType === 'zip') {
        try {
          const entryNames = await listZipEntries(tmpDownloadPath);
          let extractDir = engineDir;
          if (asset.marker.includes('system-images')) {
            const hasSubdir = entryNames.some(
              (name) =>
                name.startsWith(`${platform.abi}/`) ||
                name.startsWith('x86_64/') ||
                name.startsWith('arm64-v8a/'),
            );
            if (hasSubdir) {
              extractDir = path.join(engineDir, 'system-images', `android-${apiLevel}`, ANDROID_SYSTEM_IMAGE_TAG);
            } else {
              extractDir = systemImageDir;
            }
          } else if (
            asset.marker.includes('platform-tools') ||
            entryNames.some((name) => name.startsWith('platform-tools/'))
          ) {
            extractDir = entryNames.some((name) => name.startsWith('platform-tools/'))
              ? engineDir
              : path.join(engineDir, 'platform-tools');
          } else if (!entryNames.some((name) => name.startsWith('emulator/'))) {
            extractDir = path.join(engineDir, 'emulator');
          }
          fs.mkdirSync(extractDir, { recursive: true });
          await extractZipStreaming(tmpDownloadPath, extractDir);
        } catch (extractErr: unknown) {
          const msg = extractErr instanceof Error ? extractErr.message : String(extractErr);
          throw new AndroidAcquireError(
            `Failed to extract zip archive for ${asset.file}: ${msg}`,
            'ERR_ANDROID_EXTRACTION_FAILED'
          );
        }
      } else if (asset.archiveType === 'tar.gz') {
        let extractDir = engineDir;
        if (asset.marker.includes('system-images')) {
          extractDir = systemImageDir;
        }
        fs.mkdirSync(extractDir, { recursive: true });
        const tarRes = spawnSync('tar', ['-xzf', tmpDownloadPath, '-C', extractDir]);
        if (tarRes.status !== 0) {
          const msg = tarRes.stderr ? tarRes.stderr.toString() : `exit code ${tarRes.status}`;
          throw new AndroidAcquireError(
            `Failed to extract tar.gz archive for ${asset.file}: ${msg}`,
            'ERR_ANDROID_EXTRACTION_FAILED'
          );
        }
      } else if (asset.archiveType === 'plain') {
        // The verified bytes ARE the artifact: move the download into place under its final
        // name. Nothing is unpacked, so the digest checked above is the digest of the file the
        // guest will actually receive.
        fs.mkdirSync(path.dirname(markerFullPath), { recursive: true });
        fs.renameSync(tmpDownloadPath, markerFullPath);
      } else {
        throw new AndroidAcquireError(
          `Unsupported archive type for ${asset.file}: ${asset.archiveType}`,
          'ERR_ANDROID_EXTRACTION_FAILED'
        );
      }

      // Write marker LAST so a partial or aborted extraction is never reported installed.
      // For a `plain` asset the artifact itself is the marker (its existence is the proof) and
      // renaming already put it in place — writing here would overwrite the verified bytes with
      // a timestamp, so the marker write is skipped for that one case.
      fs.mkdirSync(path.dirname(markerFullPath), { recursive: true });
      if (asset.archiveType !== 'plain') {
        fs.writeFileSync(markerFullPath, String(Date.now()), 'utf8');
      }

      // Unlink temporary file on successful extraction
      try {
        fs.unlinkSync(tmpDownloadPath);
      } catch {
        // ignore
      }
    } catch (err) {
      // Fail closed: Purge the temporary payload on any failure
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

  return { engineDir, emulatorPath, systemImageDir };
}
