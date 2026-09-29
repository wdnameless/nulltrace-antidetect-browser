import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import {
  generateAndroidFingerprint,
  luhnCheckDigit,
  MOBILE_PRESETS,
} from '../../src/main/android/fingerprint';
import { injectGuestIdentity, detectSpoofModule } from '../../src/main/android/injector';
import {
  planGuestNetwork,
  setupGuestNetwork,
  pushGeolocation,
  connectController,
  AndroidControllerClient,
} from '../../src/main/android/network';
import type { AdbClient } from '../../src/main/android/adb';

/**
 * Independent Luhn check algorithm implemented in test suite
 * to validate that generated IMEIs are mathematically sound.
 */
function isValidLuhn(fullNumber: string): boolean {
  const clean = fullNumber.replace(/\D/g, '');
  if (clean.length < 2) return false;
  let sum = 0;
  for (let i = clean.length - 1; i >= 0; i--) {
    let d = clean.charCodeAt(i) - 48;
    const distFromRight = clean.length - 1 - i;
    // In full number, distance 0 is check digit (multiplier 1), distance 1 is doubled (multiplier 2), etc.
    if (distFromRight % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

describe('Android Fingerprint and Identity (A3 zone)', () => {
  describe('generateAndroidFingerprint', () => {
    it('is deterministic: same profileId + seed produces deep equality', () => {
      const fp1 = generateAndroidFingerprint('profile-alpha-123', 987654);
      const fp2 = generateAndroidFingerprint('profile-alpha-123', 987654);
      expect(fp1).toEqual(fp2);
    });

    it('generates distinct identities across 50 profiles (unique IMEIs, androidIds, serials, and MACs)', () => {
      const imeis = new Set<string>();
      const androidIds = new Set<string>();
      const serials = new Set<string>();
      const macs = new Set<string>();

      for (let i = 0; i < 50; i++) {
        const fp = generateAndroidFingerprint(`profile-${i}`, i * 31337 + 7);

        expect(imeis.has(fp.imei)).toBe(false);
        imeis.add(fp.imei);

        expect(androidIds.has(fp.androidId)).toBe(false);
        androidIds.add(fp.androidId);

        expect(serials.has(fp.serial)).toBe(false);
        serials.add(fp.serial);

        expect(macs.has(fp.wifiMac)).toBe(false);
        macs.add(fp.wifiMac);
      }

      expect(imeis.size).toBe(50);
      expect(androidIds.size).toBe(50);
      expect(serials.size).toBe(50);
      expect(macs.size).toBe(50);
    });

    it('every generated IMEI passes independent Luhn validation and has 15 digits', () => {
      for (let i = 0; i < 50; i++) {
        const fp = generateAndroidFingerprint(`profile-luhn-${i}`, i * 1009);
        expect(fp.imei).toHaveLength(15);
        expect(isValidLuhn(fp.imei)).toBe(true);
      }
    });

    it('luhnCheckDigit correctly computes check digit for known-valid IMEIs', () => {
      // 490154203237518 is a classic known-valid IMEI: 14 payload digits + check digit 8
      const partial1 = '49015420323751';
      expect(luhnCheckDigit(partial1)).toBe(8);
      expect(isValidLuhn(partial1 + '8')).toBe(true);

      // Another verified IMEI payload test
      const partial2 = '35824005123456';
      const check2 = luhnCheckDigit(partial2);
      expect(isValidLuhn(partial2 + check2)).toBe(true);
    });

    it('wifiMac matches uppercase colon-separated regex and preserves locally-administered bit', () => {
      const macRegex = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

      for (let i = 0; i < 20; i++) {
        const fp = generateAndroidFingerprint(`profile-mac-${i}`, i * 401);
        expect(fp.wifiMac).toMatch(macRegex);

        const firstOctet = parseInt(fp.wifiMac.split(':')[0], 16);
        // Bit 1 (0x02) MUST be set (locally administered)
        expect(firstOctet & 0x02).toBe(0x02);
        // Bit 0 (0x01) MUST be 0 (unicast)
        expect(firstOctet & 0x01).toBe(0x00);
      }
    });

    it('uses real presets from mobilePresets pool and builds realistic fingerprint metadata', () => {
      const fp = generateAndroidFingerprint('profile-real-preset', 42);
      const matchedPreset = MOBILE_PRESETS.find((p) => p.id === fp.presetId);
      expect(matchedPreset).toBeDefined();
      expect(fp.model).toBe(matchedPreset?.model);
      expect(fp.buildId).toBe(matchedPreset?.build);
      expect(fp.buildFingerprint).toContain(fp.androidVersion);
      expect(fp.buildFingerprint).toContain(fp.buildId);
      expect(fp.screen.width).toBe(matchedPreset?.screen.width);
      expect(fp.screen.height).toBe(matchedPreset?.screen.height);
      expect(fp.screen.densityDpi).toBeGreaterThan(160);
    });
  });

  describe('planGuestNetwork & setupGuestNetwork', () => {
    it('planGuestNetwork(null).blocked === true and the guest network is actively cut', async () => {
      const plan = planGuestNetwork(null);
      expect(plan.blocked).toBe(true);
      expect(plan.socksHost).toBe('10.0.2.2');

      const shellCalls: string[][] = [];
      const fakeAdb = {
        shell: async (args: string[]) => {
          shellCalls.push(args);
          return '';
        },
      } as unknown as AdbClient;

      const res = await setupGuestNetwork(fakeAdb, plan, {});
      expect(res.ok).toBe(true);
      // Blocking is applied, not merely reported: a profile with no proxy must not keep the
      // emulator's own NAT route, which is what lets traffic out unproxied.
      expect(shellCalls.some((c) => c[0] === 'iptables' && c.includes('DROP'))).toBe(true);
      expect(res.detail).toContain('DROP');
      // And tun2socks is never started, because there is nowhere for it to forward to.
      expect(shellCalls.some((c) => c.includes('tun0'))).toBe(false);
      expect(shellCalls.some((c) => c.some((a) => a.includes('tun2socks')))).toBe(false);
    });

    it('a blocked profile reports failure when neither drop rules nor route removal took effect', async () => {
      // An image that rejects every enforcement must not be reported as blocked.
      const fakeAdb = {
        shell: async () => {
          throw new Error('Operation not permitted');
        },
      } as unknown as AdbClient;

      const res = await setupGuestNetwork(fakeAdb, planGuestNetwork(null), {});
      expect(res.ok).toBe(false);
      expect(res.detail).toContain('cannot be confirmed blocked');
    });

    it('planGuestNetwork({...proxy}) gives socksHost === "10.0.2.2" and blocked === false', () => {
      const plan = planGuestNetwork({ type: 'socks5', host: '192.168.1.50', port: 10808 });
      expect(plan.blocked).toBe(false);
      expect(plan.socksHost).toBe('10.0.2.2');
      expect(plan.tunInterface).toBe('tun0');
      // The upstream proxy is carried on the plan; the port the guest dials is the host-side
      // SOCKS bridge's own loopback port, assigned when that bridge is raised.
      expect(plan.proxy).toEqual({ type: 'socks5', host: '192.168.1.50', port: 10808 });
    });

    it('setupGuestNetwork degrades (ok:true/proxied:false) when tun2socks is missing on both sides', async () => {
      const plan = planGuestNetwork({ type: 'socks5', host: '127.0.0.1', port: 9050 });
      const fakeAdb = {
        shell: async (_args: string[]) => {
          throw new Error('which: no tun2socks in PATH');
        },
      } as unknown as AdbClient;

      const res = await setupGuestNetwork(fakeAdb, plan, {});
      expect(res.ok).toBe(true);
      expect(res.proxied).toBe(false);
      expect(res.detail).toContain('host-bridge without guest tun2socks');
    });

    it('setupGuestNetwork pushes the operator host binary when the guest lacks it', async () => {
      const plan = planGuestNetwork({ type: 'socks5', host: '127.0.0.1', port: 9050 });
      plan.tun2socksBinaryOnHost = '/tmp/fake-tun2socks';
      const calls: string[][] = [];
      const pushes: Array<[string, string]> = [];
      let pushed = false;
      const fakeAdb = {
        shell: async (args: string[]) => {
          calls.push(args);
          if (args[0] === 'which') throw new Error('which: no tun2socks in PATH');
          // Pre-push the binary is absent; post-push `test -x` succeeds.
          if (args[0] === 'test' && args[1] === '-x') {
            if (!pushed) throw new Error('not found');
            return '';
          }
          return '';
        },
        push: async (localPath: string, remotePath: string) => {
          pushes.push([localPath, remotePath]);
          pushed = true;
        },
      } as unknown as AdbClient;

      const res = await setupGuestNetwork(fakeAdb, plan, {});
      expect(pushes).toEqual([['/tmp/fake-tun2socks', '/data/local/tmp/tun2socks']]);
      expect(res.ok).toBe(true);
      expect(res.proxied).toBe(true);
      expect(res.detail).toContain('tun2socks active');
    });

    it('setupGuestNetwork succeeds when tun2socks binary is found on guest', async () => {
      const plan = planGuestNetwork({ type: 'socks5', host: '127.0.0.1', port: 9050 });
      const recordedCalls: string[][] = [];
      const fakeAdb = {
        shell: async (args: string[]) => {
          recordedCalls.push(args);
          if (args[0] === 'which') return '/system/bin/tun2socks';
          return '';
        },
      } as unknown as AdbClient;

      const res = await setupGuestNetwork(fakeAdb, plan, {});
      expect(res.ok).toBe(true);
      expect(res.detail).toContain('tun2socks active');
      expect(recordedCalls.some((c) => c.includes('tun0'))).toBe(true);
    });
  });

  describe('pushGeolocation', () => {
    it('pushes nothing and returns when geo is null', async () => {
      const mockGrpc: AndroidControllerClient = {
        setLocation: vi.fn(),
        rotate: vi.fn(),
        sendKey: vi.fn(),
        close: vi.fn(),
      };

      await pushGeolocation(mockGrpc, null);
      expect(mockGrpc.setLocation).not.toHaveBeenCalled();
    });

    it('pushes exact coordinates when geo is non-null', async () => {
      const mockGrpc: AndroidControllerClient = {
        setLocation: vi.fn().mockResolvedValue(undefined),
        rotate: vi.fn().mockResolvedValue(undefined),
        sendKey: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };

      await pushGeolocation(mockGrpc, { latitude: 55.7558, longitude: 37.6173 });
      expect(mockGrpc.setLocation).toHaveBeenCalledWith(55.7558, 37.6173);
    });
  });

  describe('connectController', () => {
    it('throws error naming missing file when auth token file does not exist', () => {
      const nonExistentPath = path.join(os.tmpdir(), `non-existent-token-${Date.now()}.txt`);
      expect(() => connectController(5554, nonExistentPath)).toThrow(
        /Emulator console auth token file not found/
      );
    });

    it('returns AndroidControllerClient when auth token file is present', () => {
      const tmpTokenPath = path.join(os.tmpdir(), `test-token-${Date.now()}.txt`);
      fs.writeFileSync(tmpTokenPath, 'test-secret-token-1234\n', 'utf8');

      try {
        const client = connectController(5554, tmpTokenPath);
        expect(typeof client.setLocation).toBe('function');
        expect(typeof client.rotate).toBe('function');
        expect(typeof client.sendKey).toBe('function');
        expect(typeof client.close).toBe('function');
        client.close();
      } finally {
        fs.unlinkSync(tmpTokenPath);
      }
    });
  });

  describe('injectGuestIdentity', () => {
    it('against a FAKE adb that throws for a nominated prop: returns failure in errors while other steps appear in applied and actually ran', async () => {
      const recordedCalls: string[][] = [];
      const failingProp = 'ro.product.device';

      const fakeAdb = {
        shell: async (args: string[]) => {
          recordedCalls.push(args);
          // If the shell call is trying to set the nominated failing property:
          if (args.includes(failingProp)) {
            throw new Error(`Permission denied: unable to set ${failingProp}`);
          }
          if (args[0] === 'which' && args[1] === 'resetprop') {
            return ''; // no resetprop
          }
          return '';
        },
      } as unknown as AdbClient;

      const fp = generateAndroidFingerprint('profile-fake-adb', 777);
      const result = await injectGuestIdentity(fakeAdb, fp, {
        timezone: 'Europe/Berlin',
        locale: 'en-US',
        hasZygisk: false,
      });

      // 1. Assert that the failing step is recorded in errors
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      const hasFailingPropError = result.errors.some((err) => err.includes(failingProp));
      expect(hasFailingPropError).toBe(true);

      // 2. Assert that other steps appear in applied
      expect(result.applied).toContain('setprop:ro.product.model');
      expect(result.applied).toContain('setprop:ro.product.brand');
      expect(result.applied).toContain('settings:android_id');
      expect(result.applied).toContain('locale:en-US');
      expect(result.applied).toContain('timezone:Europe/Berlin');
      expect(result.applied).toContain(`density:${fp.screen.densityDpi}`);

      // 3. Assert that the other shell calls actually happened
      expect(recordedCalls.length).toBeGreaterThan(8);
      expect(recordedCalls.some((c) => c.includes('ro.product.model'))).toBe(true);
      expect(recordedCalls.some((c) => c.includes('android_id'))).toBe(true);
      expect(recordedCalls.some((c) => c.includes('wm') && c.includes('density'))).toBe(true);
      expect(recordedCalls.some((c) => c.includes('persist.sys.locale'))).toBe(true);
    });

    it('detectSpoofModule returns true when resetprop exists', async () => {
      const fakeAdb = {
        shell: async (args: string[]) => {
          if (args[0] === 'which' && args[1] === 'resetprop') {
            return '/system/bin/resetprop';
          }
          return '';
        },
      } as unknown as AdbClient;

      const detected = await detectSpoofModule(fakeAdb);
      expect(detected).toBe(true);
    });

    it('detectSpoofModule returns false on shell error', async () => {
      const fakeAdb = {
        shell: async () => {
          throw new Error('Command not found');
        },
      } as unknown as AdbClient;

      const detected = await detectSpoofModule(fakeAdb);
      expect(detected).toBe(false);
    });
  });
});
