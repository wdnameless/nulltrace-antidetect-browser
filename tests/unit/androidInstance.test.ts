import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs';
import type { Request, Response } from 'express';
import { initDb, getDb, closeDb } from '../../src/main/db';
import { createProfile, resolveLaunchConfig } from '../../src/main/profiles/profileManager';
import { resolveAndroidConfig, AndroidConfigError } from '../../src/main/android/config';
import {
  AndroidInstance,
  startAndroidProfile,
  isAndroidRunning,
  listAndroidStatuses,
  shutdownAllAndroid,
} from '../../src/main/android/instance';
import androidRouter from '../../src/main/api/routes/android';

describe('Android instance and wiring', () => {
  beforeEach(async () => {
    await initDb();
  });

  afterEach(async () => {
    await shutdownAllAndroid();
    closeDb();
  });

  describe('resolveAndroidConfig', () => {
    it('throws ERR_ANDROID_PROFILE_NOT_FOUND for an unknown id', () => {
      expect(() => resolveAndroidConfig('non-existent-profile')).toThrowError();
      try {
        resolveAndroidConfig('non-existent-profile');
      } catch (err) {
        expect((err as AndroidConfigError).code).toBe('ERR_ANDROID_PROFILE_NOT_FOUND');
      }
    });

    it('throws ERR_ANDROID_PROFILE_TYPE for a seeded browser_type="chromium" profile', () => {
      const id = createProfile({ name: 'desktop-profile', browser_type: 'chromium' });
      expect(() => resolveAndroidConfig(id)).toThrowError();
      try {
        resolveAndroidConfig(id);
      } catch (err) {
        expect((err as AndroidConfigError).code).toBe('ERR_ANDROID_PROFILE_TYPE');
      }
    });

    it('creates an android profile directly via createProfile (no raw SQL)', () => {
      const id = createProfile({ name: 'android-direct', browser_type: 'android' });
      const resolved = resolveAndroidConfig(id);
      expect(resolved.profileId).toBe(id);
    });

    it('resolveLaunchConfig refuses android profiles so desktop stays untouched', () => {
      const id = createProfile({ name: 'android-guard', browser_type: 'android' });
      expect(() => resolveLaunchConfig(id)).toThrowError();
    });
  });

  describe('resolveAndroidConfig android_config overrides', () => {
    it('applies valid JSON hw overrides', () => {
      const id = createProfile({ name: 'android-hw', browser_type: 'android' });
      getDb()
        .prepare('UPDATE profiles SET android_config = ? WHERE id = ?')
        .run(JSON.stringify({ cores: 8, ramMb: 8192, heapMb: 1024, densityDpi: 480 }), id);
      const resolved = resolveAndroidConfig(id);
      expect(resolved.cores).toBe(8);
      expect(resolved.ramMb).toBe(8192);
      expect(resolved.heapMb).toBe(1024);
      expect(resolved.densityDpi).toBe(480);
    });

    it('falls back to fingerprint defaults on invalid JSON', () => {
      const id = createProfile({ name: 'android-badjson', browser_type: 'android' });
      getDb().prepare('UPDATE profiles SET android_config = ? WHERE id = ?').run('{nope', id);
      const resolved = resolveAndroidConfig(id);
      expect(resolved.cores).toBe(4);
      expect(resolved.ramMb).toBe(4096);
      expect(resolved.heapMb).toBe(576);
      expect(resolved.screen.width).toBeGreaterThan(320);
    });

    it('clamps out-of-range values instead of throwing', () => {
      const id = createProfile({ name: 'android-clamp', browser_type: 'android' });
      getDb()
        .prepare('UPDATE profiles SET android_config = ? WHERE id = ?')
        .run(JSON.stringify({ cores: 99, ramMb: 1, screenW: 10, densityDpi: 9999 }), id);
      const resolved = resolveAndroidConfig(id);
      expect(resolved.cores).toBe(16);
      expect(resolved.ramMb).toBe(1024);
      expect(resolved.screen.width).toBe(320);
      expect(resolved.densityDpi).toBe(640);
    });

    it('honors explicit presetId over seed-picked preset', () => {
      const id = createProfile({ name: 'android-preset', browser_type: 'android' });
      getDb()
        .prepare('UPDATE profiles SET android_config = ? WHERE id = ?')
        .run(JSON.stringify({ presetId: 'pixel_8' }), id);
      expect(resolveAndroidConfig(id).fingerprint.presetId).toBe('pixel_8');
    });
  });

  describe('registry baseline', () => {
    it('listAndroidStatuses is initially empty and isAndroidRunning returns false', () => {
      expect(listAndroidStatuses()).toEqual([]);
      expect(isAndroidRunning('random_id')).toBe(false);
    });

    it('startAndroidProfile rejects with engine error when engine is absent', async () => {
      await expect(
        startAndroidProfile({
          profileId: 'test_prof',
          systemImageDir: 'D:/non_existent_sysimg',
          emulatorPath: 'D:/non_existent_emulator',
          adbPath: 'D:/non_existent_adb',
          screen: { width: 412, height: 915 },
          proxy: null,
          seed: 12345,
        })
      ).rejects.toThrow();
    });

    it('concurrent startAndroidProfile calls for one profile: second gets ERR_ANDROID_ALREADY_STARTING', async () => {
      // The winner must YIELD while holding the claim, or JS runs both validations to
      // completion with no interleaving. Valid paths (this repo) let the winner past
      // validation into async boot (which then fails on spawn/adb); the loser must see
      // the claim. The winner's own failure code is irrelevant — only the loser's.
      const mk = () =>
        startAndroidProfile({
          profileId: 'test_guard_race',
          systemImageDir: process.cwd(),
          emulatorPath: 'package.json',
          adbPath: 'package.json',
          screen: { width: 412, height: 915 },
          proxy: null,
          seed: 7,
        });
      const settled = await Promise.allSettled([mk(), mk()]);
      const codes = settled.map((s) =>
        s.status === 'rejected' ? ((s.reason as { code?: string })?.code ?? 'UNKNOWN') : 'STARTED',
      );
      expect(codes).toContain('ERR_ANDROID_ALREADY_STARTING');
    });
  });

  describe('route handlers via router invocation', () => {
    function invokeRoute(opts: { method: string; url: string; body?: unknown }): Promise<{
      statusCode: number;
      body: { code: unknown; msg?: string; data?: unknown };
    }> {
      const { promise, resolve } = Promise.withResolvers<{
        statusCode: number;
        body: { code: unknown; msg?: string; data?: unknown };
      }>();

      let statusCode = 200;

      const req = {
        method: opts.method,
        url: opts.url,
        body: opts.body || {},
        query: {},
        params: {},
        headers: {},
      } as unknown as Request;

      const res = {
        status(code: number) {
          statusCode = code;
          return res;
        },
        json(payload: unknown) {
          resolve({
            statusCode,
            body: payload as { code: unknown; msg?: string; data?: unknown },
          });
          return res;
        },
      } as unknown as Response;

      androidRouter(req, res, () => {
        resolve({ statusCode: 404, body: { code: -1, msg: 'route not handled', data: {} } });
      });

      return promise;
    }

    it('GET /api/v1/android/profiles/:id/status returns 404 for unknown profile', async () => {
      const response = await invokeRoute({
        method: 'GET',
        url: '/api/v1/android/profiles/missing-profile-id/status',
      });

      expect(response.statusCode).toBe(404);
      expect((response.body.data as { code?: string })?.code).toBe('ERR_ANDROID_PROFILE_NOT_FOUND');
    });

    it('POST /api/v1/android/profiles/:id/stream-ticket returns 409 when not running', async () => {
      const id = createProfile({ name: 'test-idle' });
      const response = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/stream-ticket`,
      });

      expect(response.statusCode).toBe(409);
      expect((response.body.data as { code?: string })?.code).toBe('NOT_RUNNING');
    });

    it('POST /api/v1/android/profiles/:id/start returns 409 NOT_READY when engine is missing', async () => {
      const id = createProfile({ name: 'android-launch' });
      getDb().prepare("UPDATE profiles SET browser_type = 'android' WHERE id = ?").run(id);

      const response = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/start`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.body.code).toBe('NOT_READY');
    });

    it('GET /api/v1/android/instances returns initial empty list', async () => {
      const response = await invokeRoute({
        method: 'GET',
        url: '/api/v1/android/instances',
      });

      expect(response.statusCode).toBe(200);
      expect(response.body.code).toBe(0);
      expect(response.body.data).toEqual([]);
    });

    it('POST .../tap returns 409 NOT_RUNNING for an idle profile', async () => {
      const id = createProfile({ name: 'android-idle-tap' });
      const response = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/tap`,
        body: { x: 100, y: 200 },
      });
      expect(response.statusCode).toBe(409);
      expect((response.body.data as { code?: string })?.code).toBe('NOT_RUNNING');
    });

    it('POST .../tap returns 400 on non-numeric args (validation before instance check)', async () => {
      const id = createProfile({ name: 'android-bad-tap' });
      const response = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/tap`,
        body: { x: 'left', y: 200 },
      });
      expect(response.statusCode).toBe(400);
      expect((response.body.data as { code?: string })?.code).toBe('ERR_ANDROID_BAD_ARG');
    });

    it('POST .../swipe returns 400 when durationMs is out of range', async () => {
      const id = createProfile({ name: 'android-bad-swipe' });
      const response = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/swipe`,
        body: { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 99_999 },
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST .../type returns 400 on empty text', async () => {
      const id = createProfile({ name: 'android-bad-type' });
      const response = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/type`,
        body: { text: '' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST .../key returns 409 NOT_RUNNING for idle, 400 for non-numeric keycode', async () => {
      const id = createProfile({ name: 'android-key' });
      const idle = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/key`,
        body: { keycode: 4 },
      });
      expect(idle.statusCode).toBe(409);
      const bad = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/key`,
        body: { keycode: 'BACK' },
      });
      expect(bad.statusCode).toBe(400);
    });

    it('GET .../screencap returns 409 NOT_RUNNING for an idle profile', async () => {
      const id = createProfile({ name: 'android-idle-cap' });
      const response = await invokeRoute({
        method: 'GET',
        url: `/api/v1/android/profiles/${id}/screencap`,
      });
      expect(response.statusCode).toBe(409);
      expect((response.body.data as { code?: string })?.code).toBe('NOT_RUNNING');
    });

    it('POST .../install returns 400 on missing apkPath', async () => {
      const id = createProfile({ name: 'android-bad-install' });
      const response = await invokeRoute({
        method: 'POST',
        url: `/api/v1/android/profiles/${id}/install`,
        body: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('AVD config content (custom hw)', () => {
    it('ensureAvd writes per-profile hw into config.ini and hashes it into the signature', async () => {
      // ensureAvd is private and HOME-scoped: point USERPROFILE at a temp dir, construct
      // the instance directly (no boot), and read back config.ini + signature.
      const tmp = fsp.mkdtempSync(path.join(os.tmpdir(), 'avd-hw-'));
      const prevProfile = process.env.USERPROFILE;
      const prevHome = process.env.HOME;
      process.env.USERPROFILE = tmp;
      process.env.HOME = tmp;
      try {
        const inst = new AndroidInstance({
          profileId: 'hw_unit_test',
          systemImageDir: tmp,
          emulatorPath: tmp,
          adbPath: tmp,
          screen: { width: 1080, height: 2400 },
          densityDpi: 480,
          cores: 8,
          ramMb: 8192,
          heapMb: 1024,
          proxy: null,
          seed: 1,
        });
        const avdName = (inst as unknown as { ensureAvd: () => string }).ensureAvd();
        const ini = fsp.readFileSync(path.join(tmp, '.android', 'avd', `${avdName}.avd`, 'config.ini'), 'utf8');
        expect(ini).toContain('hw.cpu.ncore=8');
        expect(ini).toContain('hw.ramSize=8192');
        expect(ini).toContain('vm.heapSize=1024');
        expect(ini).toContain('hw.lcd.density=480');
        expect(ini).toContain('hw.lcd.width=1080');
        expect(ini).toContain('hw.lcd.height=2400');
        const sig = fsp.readFileSync(
          path.join(tmp, '.android', 'avd', `${avdName}.avd`, '.nulltrace-launch-signature'), 'utf8',
        );
        expect(sig).toMatch(/metrics=v2;hw=[0-9a-f]{8}/);
        // A different hw spec must produce a different hash (rebuild on change).
        const inst2 = new AndroidInstance({
          profileId: 'hw_unit_test2',
          systemImageDir: tmp,
          emulatorPath: tmp,
          adbPath: tmp,
          screen: { width: 1080, height: 2400 },
          densityDpi: 480,
          cores: 2,
          ramMb: 8192,
          heapMb: 1024,
          proxy: null,
          seed: 1,
        });
        const avdName2 = (inst2 as unknown as { ensureAvd: () => string }).ensureAvd();
        const sig2 = fsp.readFileSync(
          path.join(tmp, '.android', 'avd', `${avdName2}.avd`, '.nulltrace-launch-signature'), 'utf8',
        );
        expect(sig2).not.toBe(sig);
      } finally {
        if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
        if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
        fsp.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('tap/swipe/key/type/screencap/install throw NOT_RUNNING before boot', async () => {
      const inst = new AndroidInstance({
        profileId: 'idle_unit',
        systemImageDir: 'x',
        emulatorPath: 'x',
        adbPath: 'x',
        screen: { width: 1080, height: 2400 },
        proxy: null,
        seed: 1,
      });
      expect(() => inst.tap(10, 10)).toThrowError();
      expect(() => inst.key(4)).toThrowError();
      await expect(inst.swipe(1, 1, 2, 2)).rejects.toThrowError();
      await expect(inst.type('hi')).rejects.toThrowError();
      await expect(inst.screencap()).rejects.toThrowError();
      await expect(inst.installApk('c:\\x.apk')).rejects.toThrowError();
      try { inst.tap(10, 10); } catch (err) {
        expect((err as { code?: string }).code).toBe('NOT_RUNNING');
      }
    });

    it('tap/swipe use the codec-meta viewport (encoder-rounded), not the requested screen', () => {
      // Regression: the encoder rounds the LCD (1082x2402 → 1080x2400) and the scrcpy
      // server drops touches whose screenW/H mismatch the video size. The instance must
      // build control messages with the meta size and scale coords into it.
      const inst = new AndroidInstance({
        profileId: 'vp_unit',
        systemImageDir: 'x',
        emulatorPath: 'x',
        adbPath: 'x',
        screen: { width: 1082, height: 2402 },
        proxy: null,
        seed: 1,
      });
      const sent: Buffer[] = [];
      const fakeHost = {
        codecMeta: { width: 1080, height: 2400 },
        sendControl: (b: Buffer): void => { sent.push(b); },
      };
      (inst as unknown as { streamHost: unknown }).streamHost = fakeHost;
      (inst as unknown as { _status: { state: string } })._status = { state: 'running' };
      inst.tap(541, 1201);
      expect(sent.length).toBe(2);
      // screenW/H at bytes 18/20; x/y at bytes 10/14 (big-endian).
      expect(sent[0].readUInt16BE(18)).toBe(1080);
      expect(sent[0].readUInt16BE(20)).toBe(2400);
      expect(sent[0].readInt32BE(10)).toBe(Math.round((541 * 1080) / 1082));
      expect(sent[0].readInt32BE(14)).toBe(Math.round((1201 * 2400) / 2402));
    });

    it('tap falls back to the requested screen before codec meta arrives', () => {
      const inst = new AndroidInstance({
        profileId: 'vp_fallback',
        systemImageDir: 'x',
        emulatorPath: 'x',
        adbPath: 'x',
        screen: { width: 1082, height: 2402 },
        proxy: null,
        seed: 1,
      });
      const sent: Buffer[] = [];
      const fakeHost = {
        codecMeta: null,
        sendControl: (b: Buffer): void => { sent.push(b); },
      };
      (inst as unknown as { streamHost: unknown }).streamHost = fakeHost;
      (inst as unknown as { _status: { state: string } })._status = { state: 'running' };
      inst.tap(100, 200);
      expect(sent[0].readUInt16BE(18)).toBe(1082);
      expect(sent[0].readUInt16BE(20)).toBe(2402);
      expect(sent[0].readInt32BE(10)).toBe(100);
      expect(sent[0].readInt32BE(14)).toBe(200);
  });
 });
});
