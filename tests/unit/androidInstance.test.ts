import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { initDb, getDb, closeDb } from '../../src/main/db';
import { createProfile, resolveLaunchConfig } from '../../src/main/profiles/profileManager';
import { resolveAndroidConfig, AndroidConfigError } from '../../src/main/android/config';
import {
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
          dataImagePath: 'D:/non_existent_data.img',
          screen: { width: 412, height: 915 },
          proxy: null,
          seed: 12345,
        })
      ).rejects.toThrow();
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
  });
});
