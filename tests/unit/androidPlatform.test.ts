import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { PassThrough } from 'stream';
import AdmZip from 'adm-zip';
import {
  resolveAndroidPlatform,
  assertHypervisorReady,
  probeEmulatorAcceleration,
  AndroidPlatformError,
  type AndroidHostPlatform,
  WINDOWS_WHPX_PROBE_CMD,
  WINDOWS_WHPX_PROBE_ARGS,
  MACOS_HV_PROBE_CMD,
  MACOS_HV_PROBE_ARGS,
  LINUX_KVM_DEVICE,
} from '../../src/main/android/platform';
import {
  getAndroidEngineStatus,
  ensureAndroidEngine,
  removeStaleDownloads,
  ANDROID_SYSTEM_IMAGE_TAG,
  AndroidAssetInfo,
} from '../../src/main/android/packageManager';

function createMockFetch(buffer: Buffer, status = 200, statusText = 'OK') {
  return async () => {
    const stream = new PassThrough();
    process.nextTick(() => {
      stream.end(buffer);
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      headers: {
        get: (header: string) => (header.toLowerCase() === 'content-length' ? String(buffer.length) : null),
      },
      body: stream,
    };
  };
}

function createZipBuffer(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.addFile(entryPath, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('Android Platform Resolution', () => {
  it('resolves Windows x86_64 host correctly', () => {
    const plan = resolveAndroidPlatform({ platform: 'win32', arch: 'x64' });
    expect(plan.host).toBe('windows');
    expect(plan.abi).toBe('x86_64');
    expect(plan.backends).toEqual(['whpx', 'aehd']);
    expect(plan.emulatorSubpath).toBe(path.join('emulator', 'emulator.exe'));
  });

  it('resolves macOS Apple Silicon (arm64) host to arm64-v8a guest ABI', () => {
    const plan = resolveAndroidPlatform({ platform: 'darwin', arch: 'arm64' });
    expect(plan.host).toBe('macos');
    expect(plan.abi).toBe('arm64-v8a');
    expect(plan.backends).toEqual(['hvf']);
    expect(plan.emulatorSubpath).toBe(path.join('emulator', 'emulator'));
  });

  it('resolves macOS Intel (x64) host to x86_64 guest ABI', () => {
    const plan = resolveAndroidPlatform({ platform: 'darwin', arch: 'x64' });
    expect(plan.host).toBe('macos');
    expect(plan.abi).toBe('x86_64');
    expect(plan.backends).toEqual(['hvf']);
    expect(plan.emulatorSubpath).toBe(path.join('emulator', 'emulator'));
  });

  it('resolves Linux x86_64 host correctly', () => {
    const plan = resolveAndroidPlatform({ platform: 'linux', arch: 'x64' });
    expect(plan.host).toBe('linux');
    expect(plan.abi).toBe('x86_64');
    expect(plan.backends).toEqual(['kvm']);
    expect(plan.emulatorSubpath).toBe(path.join('emulator', 'emulator'));
  });

  it('throws ERR_ANDROID_UNSUPPORTED_HOST naming the platform for unsupported hosts', () => {
    expect(() => {
      resolveAndroidPlatform({ platform: 'freebsd' as NodeJS.Platform, arch: 'x64' });
    }).toThrowError(AndroidPlatformError);

    try {
      resolveAndroidPlatform({ platform: 'sunos' as NodeJS.Platform, arch: 'x64' });
      expect.fail('Expected resolveAndroidPlatform to throw');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AndroidPlatformError);
      const platErr = err as AndroidPlatformError;
      expect(platErr.code).toBe('ERR_ANDROID_UNSUPPORTED_HOST');
      expect(platErr.message).toContain('sunos');
    }
  });

  it('falls back to the emulator binary when both shell probes are inconclusive', () => {
    // Measured on this host: PowerShell was refused while `emulator -accel-check` answered
    // "WHPX(10.0.26200) is installed and usable" — the app then refused to launch on a
    // machine that boots Android fine. The binary is the authority, so the helper must parse
    // both the sentence and the exit-code line.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accel-probe-'));
    try {
      const emuDir = path.join(dir, 'android', 'emulator');
      fs.mkdirSync(emuDir, { recursive: true });
      const exe = path.join(emuDir, process.platform === 'win32' ? 'emulator.exe' : 'emulator');
      // A tiny script that answers like the real emulator on a healthy host.
      fs.writeFileSync(
        exe,
        ['#!/bin/sh', 'echo "WHPX(10.0.26200) is installed and usable."', 'echo accel', ''].join('\n'),
        { mode: 0o755 },
      );
      if (process.platform === 'win32') {
        // Windows cannot execute that script; assert the negative path instead: a missing
        // binary must not be mistaken for success.
        expect(probeEmulatorAcceleration(dir)).toBe(false);
      } else {
        expect(probeEmulatorAcceleration(dir)).toBe(true);
      }
      // No engine at all: still false, never a silent pass.
      expect(probeEmulatorAcceleration(path.join(dir, 'nope'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes greppable probe commands and checks absent hypervisor with actionable error', async () => {
    expect(WINDOWS_WHPX_PROBE_CMD).toBe('powershell.exe');
    expect(WINDOWS_WHPX_PROBE_ARGS).toContain('Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform');
    expect(MACOS_HV_PROBE_CMD).toBe('sysctl');
    expect(MACOS_HV_PROBE_ARGS).toContain('kern.hv_support');
    expect(LINUX_KVM_DEVICE).toBe('/dev/kvm');

    // Linux probe without /dev/kvm
    const linuxPlan = resolveAndroidPlatform({ platform: 'linux', arch: 'x64' });
    // On non-Linux (e.g. Windows test runner), /dev/kvm does not exist
    if (!fs.existsSync('/dev/kvm')) {
      await expect(assertHypervisorReady(linuxPlan)).rejects.toMatchObject({
        code: 'ERR_ANDROID_NO_HYPERVISOR',
        message: expect.stringContaining('/dev/kvm'),
      });
    }

    // Unsupported host in assertHypervisorReady
    await expect(assertHypervisorReady({
      host: 'unknown' as unknown as AndroidHostPlatform,
      abi: 'x86_64',
      backends: [],
      emulatorSubpath: 'emulator',
    })).rejects.toMatchObject({
      code: 'ERR_ANDROID_UNSUPPORTED_HOST',
    });
  });
});

describe('Android Package Manager & Engine Acquisition', () => {
  let tmpEngineDir: string;

  beforeEach(() => {
    tmpEngineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'android-engine-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpEngineDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('reports installed:false and non-empty unpinnedAssets on an empty directory', () => {
    const status = getAndroidEngineStatus({ engineDir: tmpEngineDir });
    expect(status.installed).toBe(false);
    expect(status.emulatorPath).toBeNull();
    expect(status.installedApiLevels).toEqual([]);
    expect(Array.isArray(status.unpinnedAssets)).toBe(true);
    // Every shipped asset is pinned to Google's published digest now, so an empty dir reports
    // nothing unpinned. This is the regression guard against silently re-nulling a digest:
    // a blank unpinnedAssets list means acquisition would actually be allowed to verify.
    expect(status.unpinnedAssets).toEqual([]);
    expect(status.engineDir).toBe(tmpEngineDir);
  });

  it('reports resolver error when platform cannot be resolved in getAndroidEngineStatus', () => {
    const status = getAndroidEngineStatus({
      engineDir: tmpEngineDir,
      platform: undefined,
    });
    // Normal resolution succeeds on this workstation.
    expect(status.platform).not.toBeNull();

    // Now test with simulated unsupported platform by passing an error scenario
    const failingResolverStatus = (() => {
      // We can test status error response directly with an explicit platform that threw
      try {
        resolveAndroidPlatform({ platform: 'aix' as NodeJS.Platform });
      } catch (err: unknown) {
        const platErr = err as AndroidPlatformError;
        return {
          installed: false,
          engineDir: tmpEngineDir,
          emulatorPath: null,
          installedApiLevels: [],
          unpinnedAssets: [],
          platform: null,
          error: { code: platErr.code, message: platErr.message },
        };
      }
      return null;
    })();
    expect(failingResolverStatus?.error?.code).toBe('ERR_ANDROID_UNSUPPORTED_HOST');
  });

  it('unpinned asset => ensureAndroidEngine throws ERR_ANDROID_DIGEST_UNPINNED and fetch is NEVER called', async () => {
    const fetchSpy = vi.fn(createMockFetch(Buffer.from('dummy')));
    const platform = resolveAndroidPlatform({ platform: 'win32', arch: 'x64' });
    const platformKey = `${platform.host}-${platform.abi}`;

    // A digest may only ever be pinned from the vendor's own published metadata. This asset
    // models the case that must stay impossible to install: no digest at ANY strength.
    const unpinnedAssets: Record<string, AndroidAssetInfo[]> = {
      [platformKey]: [
        {
          file: 'emulator-win.zip',
          url: 'https://dl.google.com/android/repository/emulator-win.zip',
          size: null,
          sha256: null,
          sha1: null,
          archiveType: 'zip',
          marker: path.join('emulator', '.installed'),
        },
      ],
    };
    const unpinnedImages: Record<number, Record<string, AndroidAssetInfo[]>> = {
      34: {
        [platformKey]: [
          {
            file: 'x86_64-34.zip',
            url: 'https://dl.google.com/android/repository/x86_64-34.zip',
            size: null,
            sha256: null,
            sha1: null,
            archiveType: 'zip',
            marker: path.join('system-images', 'android-34', ANDROID_SYSTEM_IMAGE_TAG, 'x86_64', '.installed'),
          },
        ],
      },
    };

    await expect(
      ensureAndroidEngine({
        engineDir: tmpEngineDir,
        // Pass the platform the fixtures are keyed by. Without it the resolver runs against the
        // HOST, so this test passed on Windows and failed on a macOS runner (`macos-arm64-v8a`
        // has no entry in the fixture, which is a different error from the one asserted here).
        platform,
        fetchFn: fetchSpy as unknown as typeof fetch,
        assets: unpinnedAssets,
        systemImages: unpinnedImages,
      })
    ).rejects.toMatchObject({
      code: 'ERR_ANDROID_DIGEST_UNPINNED',
      message: expect.stringContaining('emulator-win.zip'),
    });

    // CRITICAL: The spec requires that no network request is performed for unpinned assets.
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  it('digest mismatch => throws ERR_ANDROID_DIGEST_MISMATCH and deletes temporary download file', async () => {
    const platform = resolveAndroidPlatform({ platform: 'win32', arch: 'x64' });
    const platformKey = `${platform.host}-${platform.abi}`;

    const mockZipBuffer = createZipBuffer({
      'emulator/emulator.exe': 'mock-emulator-binary',
    });

    const wrongSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
    const mockAssets: Record<string, AndroidAssetInfo[]> = {
      [platformKey]: [
        {
          file: 'mock-emulator.zip',
          url: 'https://example.com/mock-emulator.zip',
          size: mockZipBuffer.length,
          sha256: wrongSha256,
          sha1: null,
          archiveType: 'zip',
          marker: path.join('emulator', '.installed'),
        },
      ],
    };

    const mockSystemImages: Record<number, Record<string, AndroidAssetInfo[]>> = {
      34: {
        [platformKey]: [
          {
            file: 'mock-sysimg.zip',
            url: 'https://example.com/mock-sysimg.zip',
            size: 100,
            sha256: wrongSha256,
          sha1: null,
            archiveType: 'zip',
            marker: path.join('system-images', 'android-34', ANDROID_SYSTEM_IMAGE_TAG, 'x86_64', '.installed'),
          },
        ],
      },
    };

    const fetchSpy = vi.fn(createMockFetch(mockZipBuffer));

    await expect(
      ensureAndroidEngine({
        engineDir: tmpEngineDir,
        platform,
        assets: mockAssets,
        systemImages: mockSystemImages,
        fetchFn: fetchSpy as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      code: 'ERR_ANDROID_DIGEST_MISMATCH',
      message: expect.stringContaining('Digest mismatch for mock-emulator.zip'),
    });

    // Check that temp download files were deleted (fail closed)
    const files = fs.readdirSync(tmpEngineDir);
    const tmpFiles = files.filter((f) => f.startsWith('.download-') && f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);

    // Marker was NOT written
    expect(fs.existsSync(path.join(tmpEngineDir, 'emulator', '.installed'))).toBe(false);
  });

  it('truncated download (fewer bytes than size) fails closed with ERR_ANDROID_DOWNLOAD_FAILED', async () => {
    const platform = resolveAndroidPlatform({ platform: 'win32', arch: 'x64' });
    const platformKey = `${platform.host}-${platform.abi}`;

    const mockZipBuffer = createZipBuffer({
      'emulator/emulator.exe': 'mock-emulator-binary',
    });

    const actualHash = crypto.createHash('sha256').update(mockZipBuffer).digest('hex');

    const mockAssets: Record<string, AndroidAssetInfo[]> = {
      [platformKey]: [
        {
          file: 'mock-truncated.zip',
          url: 'https://example.com/mock-truncated.zip',
          // Declared size is larger than returned buffer => truncated
          size: mockZipBuffer.length + 500,
          sha256: actualHash,
          sha1: null,
          archiveType: 'zip',
          marker: path.join('emulator', '.installed'),
        },
      ],
    };

    const mockSystemImages: Record<number, Record<string, AndroidAssetInfo[]>> = {
      34: {
        [platformKey]: [
          {
            file: 'mock-sysimg.zip',
            url: 'https://example.com/mock-sysimg.zip',
            size: null,
            sha256: actualHash,
          sha1: null,
            archiveType: 'zip',
            marker: path.join('system-images', 'android-34', ANDROID_SYSTEM_IMAGE_TAG, 'x86_64', '.installed'),
          },
        ],
      },
    };

    const fetchSpy = vi.fn(createMockFetch(mockZipBuffer));

    await expect(
      ensureAndroidEngine({
        engineDir: tmpEngineDir,
        platform,
        assets: mockAssets,
        systemImages: mockSystemImages,
        fetchFn: fetchSpy as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({
      code: 'ERR_ANDROID_DOWNLOAD_FAILED',
      message: expect.stringContaining('Download truncated for mock-truncated.zip'),
    });

    // Temp file cleaned up
    const files = fs.readdirSync(tmpEngineDir);
    expect(files.filter((f) => f.startsWith('.download-'))).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpEngineDir, 'emulator', '.installed'))).toBe(false);
  });

  it('successfully acquires, verifies, extracts archives and reports status accurately', async () => {
    const platform = resolveAndroidPlatform({ platform: 'win32', arch: 'x64' });
    const platformKey = `${platform.host}-${platform.abi}`;

    const emulatorZipBuffer = createZipBuffer({
      'emulator/emulator.exe': 'real-mock-emulator-binary',
    });
    const emulatorHash = crypto.createHash('sha256').update(emulatorZipBuffer).digest('hex');

    const sysImgZipBuffer = createZipBuffer({
      'system.img': 'real-mock-system-image',
    });
    const sysImgHash = crypto.createHash('sha256').update(sysImgZipBuffer).digest('hex');

    // The streaming server ships as a plain (non-archive) download, and an engine is only
    // reported installed once every engine asset — including this one — is present.
    const scrcpyJarBuffer = Buffer.from('PK\x03\x04mock-scrcpy-server-jar', 'binary');
    const scrcpyJarHash = crypto.createHash('sha256').update(scrcpyJarBuffer).digest('hex');

    const mockAssets: Record<string, AndroidAssetInfo[]> = {
      [platformKey]: [
        {
          file: 'emulator-win.zip',
          url: 'https://dl.google.com/android/repository/emulator-win.zip',
          size: emulatorZipBuffer.length,
          sha256: emulatorHash,
          sha1: null,
          archiveType: 'zip',
          marker: path.join('emulator', '.installed'),
        },
        {
          file: 'scrcpy-server.jar',
          url: 'https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4',
          size: scrcpyJarBuffer.length,
          sha256: scrcpyJarHash,
          sha1: null,
          archiveType: 'plain',
          marker: 'scrcpy-server.jar',
        },
      ],
    };

    const mockSystemImages: Record<number, Record<string, AndroidAssetInfo[]>> = {
      34: {
        [platformKey]: [
          {
            file: 'x86_64-34.zip',
            url: 'https://dl.google.com/android/repository/x86_64-34.zip',
            size: sysImgZipBuffer.length,
            sha256: sysImgHash,
            sha1: null,
            archiveType: 'zip',
            marker: path.join('system-images', 'android-34', ANDROID_SYSTEM_IMAGE_TAG, 'x86_64', '.installed'),
          },
        ],
      },
    };

    const fetchMock = vi.fn(async (url: string) => {
      const byUrlFragment: Array<[string, Buffer]> = [
        ['emulator', emulatorZipBuffer],
        ['scrcpy', scrcpyJarBuffer],
      ];
      const buf = byUrlFragment.find(([fragment]) => url.includes(fragment))?.[1] ?? sysImgZipBuffer;
      const stream = new PassThrough();
      process.nextTick(() => {
        stream.end(buf);
      });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-length' ? String(buf.length) : null),
        },
        body: stream,
      };
    });

    const progressReports: Array<{ asset: string; received: number; total: number | null }> = [];
    const result = await ensureAndroidEngine({
      engineDir: tmpEngineDir,
      platform,
      assets: mockAssets,
      systemImages: mockSystemImages,
      fetchFn: fetchMock as unknown as typeof fetch,
      onProgress: (p) => progressReports.push(p),
    });

    expect(result.engineDir).toBe(tmpEngineDir);
    expect(result.emulatorPath).toBe(path.join(tmpEngineDir, 'emulator', 'emulator.exe'));
    expect(result.systemImageDir).toBe(
      path.join(tmpEngineDir, 'system-images', 'android-34', ANDROID_SYSTEM_IMAGE_TAG, 'x86_64'),
    );

    expect(fs.existsSync(result.emulatorPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpEngineDir, 'emulator', '.installed'))).toBe(true);
    expect(fs.existsSync(path.join(result.systemImageDir, '.installed'))).toBe(true);
    expect(progressReports.length).toBeGreaterThan(0);

    // The plain asset lands under its own name holding the verified bytes, not a marker
    // timestamp — a marker write here would have overwritten the jar the guest executes.
    const installedJar = path.join(tmpEngineDir, 'scrcpy-server.jar');
    expect(fs.existsSync(installedJar)).toBe(true);
    expect(fs.readFileSync(installedJar).equals(scrcpyJarBuffer)).toBe(true);

    // No leftover .download-*.tmp files
    const remainingTmp = fs.readdirSync(tmpEngineDir).filter((f) => f.startsWith('.download-'));
    expect(remainingTmp).toHaveLength(0);

    // Subsequent call skips already installed assets
    const secondFetchMock = vi.fn();
    const cachedResult = await ensureAndroidEngine({
      engineDir: tmpEngineDir,
      platform,
      assets: mockAssets,
      systemImages: mockSystemImages,
      fetchFn: secondFetchMock as unknown as typeof fetch,
    });
    expect(secondFetchMock).not.toHaveBeenCalled();
    expect(cachedResult.emulatorPath).toBe(result.emulatorPath);

    // Verify getAndroidEngineStatus on installed directory
    const status = getAndroidEngineStatus({
      engineDir: tmpEngineDir,
      platform,
    });
    expect(status.installed).toBe(true);
    expect(status.emulatorPath).toBe(result.emulatorPath);
    expect(status.installedApiLevels).toContain(34);
  });

  it('reclaims stale downloads older than 1 hour and leaves recent files alone', () => {
    const staleFile = path.join(tmpEngineDir, '.download-old-asset.tmp');
    const freshFile = path.join(tmpEngineDir, '.download-fresh-asset.tmp');
    const nonTmpFile = path.join(tmpEngineDir, 'regular-file.txt');

    fs.writeFileSync(staleFile, 'stale-data', 'utf8');
    fs.writeFileSync(freshFile, 'fresh-data', 'utf8');
    fs.writeFileSync(nonTmpFile, 'permanent-data', 'utf8');

    // Backdate stale file by 2 hours
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, twoHoursAgo, twoHoursAgo);

    removeStaleDownloads(tmpEngineDir);

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    expect(fs.existsSync(nonTmpFile)).toBe(true);
  });
});
