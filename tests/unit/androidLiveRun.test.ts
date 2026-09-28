import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import http from 'node:http';
import { PassThrough } from 'stream';
import AdmZip from 'adm-zip';
import express, { type Express } from 'express';
import {
  ANDROID_ENGINE_ASSETS,
  ANDROID_SYSTEM_IMAGES,
  ensureAndroidEngine,
  getAndroidEngineStatus,
  type AndroidAssetInfo,
} from '../../src/main/android/packageManager';
import {
  resolveAndroidPlatform,
  type AndroidPlatformErrorCode,
} from '../../src/main/android/platform';
import { resolveAdbPath } from '../../src/main/android/adb';

const HOST_ABI_KEYS = [
  'windows-x86_64',
  'macos-arm64-v8a',
  'macos-x86_64',
  'linux-x86_64',
] as const;

function createZipBuffer(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.addFile(entryPath, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

function postJson(port: number, pathname: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 500,
            json: JSON.parse(raw) as Record<string, unknown>,
          });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('android-live-run engine & asset invariants', () => {
  it('platform-tools is present, correctly pinned, and uses proper marker across all 4 host-abi keys', () => {
    for (const key of HOST_ABI_KEYS) {
      const assets = ANDROID_ENGINE_ASSETS[key];
      expect(assets, `Assets missing for platform key ${key}`).toBeDefined();

      const ptAsset = assets.find((a) => a.file.includes('platform-tools'));
      expect(ptAsset, `platform-tools asset missing for platform key ${key}`).toBeDefined();

      expect(ptAsset!.archiveType).toBe('zip');
      expect(ptAsset!.marker).toBe(path.join('platform-tools', '.installed'));
      expect(ptAsset!.sha1).toBeTruthy();
      expect(typeof ptAsset!.sha1).toBe('string');
      expect(ptAsset!.sha1!.length).toBe(40);
      expect(ptAsset!.size).toBeGreaterThan(0);
      expect(ptAsset!.url).toMatch(/^https:\/\/dl\.google\.com\/android\/repository\/platform-tools_r37\.0\.1-/);
    }
  });

  it('feed-current emulator revision 16416033 is pinned across all 4 keys, and stale 16349944 is retired', () => {
    for (const key of HOST_ABI_KEYS) {
      const assets = ANDROID_ENGINE_ASSETS[key];
      const emuAsset = assets.find((a) => a.file.includes('emulator'));
      expect(emuAsset, `emulator asset missing for platform key ${key}`).toBeDefined();

      expect(emuAsset!.file).toContain('16416033');
      expect(emuAsset!.url).toContain('16416033');
      expect(emuAsset!.file).not.toContain('16349944');
      expect(emuAsset!.url).not.toContain('16349944');

      expect(emuAsset!.marker).toBe(path.join('emulator', '.installed'));
      expect(emuAsset!.archiveType).toBe('zip');
      expect(emuAsset!.sha1).toBeTruthy();
      expect(emuAsset!.sha1!.length).toBe(40);
      expect(emuAsset!.size).toBeGreaterThan(0);
    }
  });

  it('all assets in ANDROID_ENGINE_ASSETS and ANDROID_SYSTEM_IMAGES have pinned digests and sizes', () => {
    for (const [key, assets] of Object.entries(ANDROID_ENGINE_ASSETS)) {
      for (const asset of assets) {
        const hasDigest = asset.sha256 !== null || asset.sha1 !== null;
        expect(hasDigest, `Asset ${asset.file} in key ${key} has no pinned digest`).toBe(true);
        expect(asset.size, `Asset ${asset.file} in key ${key} has invalid size`).toBeGreaterThan(0);
      }
    }

    for (const [apiLevel, perPlatform] of Object.entries(ANDROID_SYSTEM_IMAGES)) {
      for (const [key, assets] of Object.entries(perPlatform)) {
        for (const asset of assets) {
          const hasDigest = asset.sha256 !== null || asset.sha1 !== null;
          expect(hasDigest, `Sys-image ${asset.file} for API ${apiLevel} / ${key} has no digest`).toBe(true);
          expect(asset.size, `Sys-image ${asset.file} for API ${apiLevel} / ${key} has invalid size`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('adb resolution and acquisition unpacking', () => {
  let tmpEngineDir: string;

  beforeEach(() => {
    tmpEngineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-live-run-adb-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpEngineDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort.
    }
  });

  it('resolveAdbPath fails closed with ERR_ANDROID_ADB_NOT_FOUND when binary is missing', () => {
    expect(() => resolveAdbPath(tmpEngineDir)).toThrowError(
      expect.objectContaining({
        code: 'ERR_ANDROID_ADB_NOT_FOUND',
      })
    );
  });

  it('resolveAdbPath finds adb executable after simulated platform-tools extraction', () => {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'adb.exe' : 'adb';
    const ptDir = path.join(tmpEngineDir, 'platform-tools');
    fs.mkdirSync(ptDir, { recursive: true });
    const fakeAdb = path.join(ptDir, exeName);
    fs.writeFileSync(fakeAdb, '#!/bin/sh\necho adb', { mode: 0o755 });

    const resolved = resolveAdbPath(tmpEngineDir);
    expect(resolved).toBe(path.resolve(fakeAdb));
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it('ensureAndroidEngine unpacks platform-tools zip into engineDir without emulator nesting', async () => {
    const platform = resolveAndroidPlatform({ platform: 'win32', arch: 'x64' });
    const platformKey = `${platform.host}-${platform.abi}`;

    const isWin = process.platform === 'win32';
    const adbFileName = isWin ? 'adb.exe' : 'adb';

    // Real platform-tools zip has root folder 'platform-tools/'
    const ptZipBuffer = createZipBuffer({
      [`platform-tools/${adbFileName}`]: 'mock-adb-binary-content',
      'platform-tools/fastboot': 'mock-fastboot',
    });
    const ptHash = crypto.createHash('sha256').update(ptZipBuffer).digest('hex');

    const emuZipBuffer = createZipBuffer({
      'emulator/emulator.exe': 'mock-emulator-binary',
    });
    const emuHash = crypto.createHash('sha256').update(emuZipBuffer).digest('hex');

    const scrcpyJarBuffer = Buffer.from('mock-scrcpy-jar-content');
    const scrcpyHash = crypto.createHash('sha256').update(scrcpyJarBuffer).digest('hex');

    const sysImgZipBuffer = createZipBuffer({
      'x86_64/system.img': 'mock-system-image',
    });
    const sysImgHash = crypto.createHash('sha256').update(sysImgZipBuffer).digest('hex');

    const mockAssets: Record<string, AndroidAssetInfo[]> = {
      [platformKey]: [
        {
          file: 'emulator-win-mock.zip',
          url: 'https://dl.google.com/android/repository/emulator-win-mock.zip',
          size: emuZipBuffer.length,
          sha256: emuHash,
          sha1: null,
          archiveType: 'zip',
          marker: path.join('emulator', '.installed'),
        },
        {
          file: 'platform-tools-mock.zip',
          url: 'https://dl.google.com/android/repository/platform-tools-mock.zip',
          size: ptZipBuffer.length,
          sha256: ptHash,
          sha1: null,
          archiveType: 'zip',
          marker: path.join('platform-tools', '.installed'),
        },
        {
          file: 'scrcpy-server.jar',
          url: 'https://github.com/Genymobile/scrcpy/releases/download/v2.4/scrcpy-server-v2.4',
          size: scrcpyJarBuffer.length,
          sha256: scrcpyHash,
          sha1: null,
          archiveType: 'plain',
          marker: 'scrcpy-server.jar',
        },
      ],
    };

    const mockSysImages: Record<number, Record<string, AndroidAssetInfo[]>> = {
      34: {
        [platformKey]: [
          {
            file: 'sysimg-mock.zip',
            url: 'https://dl.google.com/android/repository/sysimg-mock.zip',
            size: sysImgZipBuffer.length,
            sha256: sysImgHash,
            sha1: null,
            archiveType: 'zip',
            marker: path.join('system-images', 'android-34', 'google_apis', 'x86_64', '.installed'),
          },
        ],
      },
    };

    const fetchMock = vi.fn(async (url: string) => {
      let buf = sysImgZipBuffer;
      if (url.includes('platform-tools')) buf = ptZipBuffer;
      else if (url.includes('emulator')) buf = emuZipBuffer;
      else if (url.includes('scrcpy')) buf = scrcpyJarBuffer;

      const stream = new PassThrough();
      process.nextTick(() => stream.end(buf));
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

    const result = await ensureAndroidEngine({
      engineDir: tmpEngineDir,
      platform,
      assets: mockAssets,
      systemImages: mockSysImages,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(result.engineDir).toBe(tmpEngineDir);

    // Verify platform-tools extraction destination
    const extractedAdbPath = path.join(tmpEngineDir, 'platform-tools', adbFileName);
    expect(fs.existsSync(extractedAdbPath)).toBe(true);

    // Marker file is created
    const ptMarker = path.join(tmpEngineDir, 'platform-tools', '.installed');
    expect(fs.existsSync(ptMarker)).toBe(true);

    // resolveAdbPath finds the extracted binary
    const resolvedAdb = resolveAdbPath(tmpEngineDir);
    expect(resolvedAdb).toBe(path.resolve(extractedAdbPath));

    // getAndroidEngineStatus reports installed: true
    const status = getAndroidEngineStatus({
      engineDir: tmpEngineDir,
      platform,
      assets: mockAssets,
    });
    expect(status.installed).toBe(true);
  });
});

describe('POST /api/v1/android/engine/install hypervisor preflight gate', () => {
  interface Harness {
    port: number;
    close: () => Promise<void>;
    ensureCalled: () => boolean;
  }

  async function mountAndroidRouter(opts: {
    hypervisorThrows?: boolean;
    errorCode?: AndroidPlatformErrorCode;
  }): Promise<Harness> {
    vi.resetModules();
    let calledEnsure = false;

    vi.doMock('../../src/main/db', () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => undefined,
        }),
      }),
    }));

    vi.doMock('../../src/main/android/platform', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../../src/main/android/platform')>();
      return {
        ...orig,
        assertHypervisorReady: async () => {
          if (opts.hypervisorThrows) {
            throw new orig.AndroidPlatformError(
              'Windows Hypervisor Platform is not enabled and AEHD driver is not installed.',
              opts.errorCode ?? 'ERR_ANDROID_NO_HYPERVISOR'
            );
          }
        },
      };
    });

    vi.doMock('../../src/main/android/packageManager', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../../src/main/android/packageManager')>();
      return {
        ...orig,
        ensureAndroidEngine: async () => {
          calledEnsure = true;
          return {
            engineDir: '/mock/engine',
            emulatorPath: '/mock/engine/emulator/emulator.exe',
            systemImageDir: '/mock/engine/system-images/34',
          };
        },
      };
    });

    // Dynamic import needed after vi.doMock isolation boundary
    const { default: router } = await import('../../src/main/api/routes/android');
    const app: Express = express();
    app.use(express.json());
    app.use(router);

    const server = http.createServer(app);
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', () => listening.resolve());
    await listening.promise;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    return {
      port,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        return closed.promise;
      },
      ensureCalled: () => calledEnsure,
    };
  }

  it('rejects with code: -1 and hypervisor error without calling ensureAndroidEngine when hypervisor missing', async () => {
    const harness = await mountAndroidRouter({ hypervisorThrows: true });
    try {
      const { status, json } = await postJson(harness.port, '/api/v1/android/engine/install', { apiLevel: 34 });

      expect(status).toBe(200);
      expect(json.code).toBe(-1);
      expect(String(json.msg)).toContain('Windows Hypervisor Platform');
      expect(json.data).toEqual({ code: 'ERR_ANDROID_NO_HYPERVISOR' });
      expect(harness.ensureCalled()).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('proceeds with ensureAndroidEngine when hypervisor is ready', async () => {
    const harness = await mountAndroidRouter({ hypervisorThrows: false });
    try {
      const { status, json } = await postJson(harness.port, '/api/v1/android/engine/install', { apiLevel: 34 });

      expect(status).toBe(200);
      expect(json.code).toBe(0);
      expect(json.msg).toBe('success');
      const data = json.data as { engineDir?: string };
      expect(data.engineDir).toBe('/mock/engine');
      expect(harness.ensureCalled()).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
