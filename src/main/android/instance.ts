import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import * as child_process from 'child_process';
import { AdbClient, allocateEmulatorPorts } from './adb';
import { AndroidStreamHost, type AndroidStreamTicket, type AndroidInstanceLike } from './streamHost';
import { generateAndroidFingerprint } from './fingerprint';
import { injectGuestIdentity, detectSpoofModule, type InjectResult } from './injector';
import {
  planGuestNetwork,
  setupGuestNetwork,
  teardownGuestNetwork,
  pushGeolocation,
  connectController,
  resolveTun2socksOnHost,
} from './network';
import { logger } from '../util/logger';
import { getAndroidEngineStatus, ensureAndroidEngine } from './packageManager';
import { resolveAdbPath } from './adb';
import { resolveAndroidConfig } from './config';

export interface AndroidStartOptions {
  profileId: string;
  systemImageDir: string;
  emulatorPath: string;
  adbPath: string;
  /** The writable overlay lives inside the profile's own AVD
   * (`~/.android/avd/antidetect_<id>.avd/userdata-qemu.img`), materialised by `ensureAvd()`;
   * the emulator boots from the AVD, so a second copy under the profile directory was 2 GB
   * of dead weight nothing ever read. */
  /** Guest boot deadline. A cold Android 14 boot with the software GLES renderer (swiftshader)
   * the headless emulator selects does not finish in 120 s on a slow or virtualised host —
   * measured: a 120 032 ms timeout on a guest that was still booting. */
  bootTimeoutMs?: number;
  screen: { width: number; height: number };
  proxy: { type: string; host: string; port: number; username?: string | null; password?: string | null } | null;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  seed: number;
  headless?: boolean; // always true today; kept explicit for R01
  coldBoot?: boolean; // skip the quickboot snapshot
}

export interface AndroidInstanceStatus {
  profileId: string;
  state: 'starting' | 'booting' | 'running' | 'stopped' | 'error';
  serial: string;
  consolePort: number;
  adbPort: number;
  screen: { width: number; height: number };
  stream: 'idle' | 'starting' | 'streaming' | 'error';
  /** Milliseconds the guest has been booting; absent once it is no longer booting. */
  bootingForMs?: number;
  startedAt: number;
  error?: { code: string; message: string };
  inject?: InjectResult;
  /** Outcome of forcing guest traffic through the profile's proxy (`proxied:false` = degraded direct NAT). */
  network?: { ok: boolean; detail: string; proxied?: boolean };
}

/** Message of an unknown thrown value, for wrapping an engine failure into a coded error. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AndroidRuntimeError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AndroidRuntimeError';
  }
}

/** Allocates a free loopback port for the WebSocket stream relay */
function getFreePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.unref();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close(() => reject(new AndroidRuntimeError('Failed to obtain free port for stream host', 'ERR_PORT')));
      return;
    }
    const port = addr.port;
    server.close((err) => {
      if (err) reject(err);
      else resolve(port);
    });
  });
  return promise;
}

export class AndroidInstance implements AndroidInstanceLike {
  readonly profileId: string;
  serial: string;
  adb: AdbClient;
  readonly screen: { width: number; height: number };
  consolePort = 0;
  adbPort = 0;

  private process: child_process.ChildProcess | null = null;
  private streamHost: AndroidStreamHost | null = null;
  /** Loopback SOCKS bridge serving this guest; closed on stop so nothing keeps listening. */
  private stopNetworkBridge: (() => Promise<void>) | null = null;
  private _status: AndroidInstanceStatus;

  constructor(private readonly options: AndroidStartOptions) {
    this.profileId = options.profileId;
    this.screen = options.screen;
    this.serial = '';
    // Provisional AdbClient; updated when ports are allocated
    this.adb = new AdbClient(options.adbPath, 'emulator-provisional');

    this._status = {
      profileId: options.profileId,
      state: 'starting',
      serial: '',
      consolePort: 0,
      adbPort: 0,
      screen: options.screen,
      stream: 'idle',
      startedAt: Date.now(),
    };
  }

  get status(): AndroidInstanceStatus {
    return { ...this._status };
  }


  /**
   * Starts the emulator according to the documented lifecycle:
   * 1. allocate console/ADB ports
   * 2. spawn emulator (-no-window -no-audio -no-boot-anim -read-only)
   * 3. adb.waitForBoot()
   * 4. inject guest identity
   * 5. setup guest network
   * 6. start stream host
   *
   * Note: status.state transitions from 'starting' -> 'booting' -> 'running'
   * and becomes 'running' ONLY AFTER waitForBoot() completes.
   */
  async start(): Promise<void> {
    this._status.state = 'starting';
    this._status.startedAt = Date.now();

    if (!this.options.emulatorPath || !fs.existsSync(this.options.emulatorPath)) {
      const err = new AndroidRuntimeError(
        `Emulator binary not found at ${this.options.emulatorPath}`,
        'ERR_ANDROID_NOT_READY'
      );
      this._status.state = 'error';
      this._status.error = { code: 'ERR_ANDROID_NOT_READY', message: err.message };
      throw err;
    }

    if (!this.options.systemImageDir || !fs.existsSync(this.options.systemImageDir)) {
      const err = new AndroidRuntimeError(
        `System image directory not found at ${this.options.systemImageDir}`,
        'ERR_ANDROID_NOT_READY'
      );
      this._status.state = 'error';
      this._status.error = { code: 'ERR_ANDROID_NOT_READY', message: err.message };
      throw err;
    }

    // 1. Allocate emulator console and ADB ports
    const ports = await allocateEmulatorPorts();
    this.consolePort = ports.console;
    this.adbPort = ports.adb;
    this.serial = `emulator-${this.consolePort}`;
    this.adb = new AdbClient(this.options.adbPath, this.serial);

    this._status.serial = this.serial;
    this._status.consolePort = this.consolePort;
    this._status.adbPort = this.adbPort;

    // 2. Spawn the emulator
    this._status.state = 'booting';
    await this.spawnEmulator();

    try {
      // 3. Wait for guest to finish booting. A cold boot is minutes; the status carries the
      // elapsed time so the UI shows progress instead of a dead "Starting…".
      await this.adb.waitForBoot({
        timeoutMs: this.options.bootTimeoutMs ?? 300_000,
        onWait: (elapsedMs) => {
          this._status.bootingForMs = elapsedMs;
        },
      });

      // Guest is confirmed booted; transition to 'running'
      this._status.state = 'running';
      this._status.bootingForMs = undefined;

      // 4. Inject mobile identity over ADB
      const fp = generateAndroidFingerprint(this.profileId, this.options.seed);
      const hasZygisk = await detectSpoofModule(this.adb).catch(() => false);
      const injectResult = await injectGuestIdentity(this.adb, fp, {
        timezone: this.options.timezone,
        hasZygisk,
      });
      this._status.inject = injectResult;
      if (injectResult.privilege !== 'full') {
        // The guest is running with an identity that a careful check can still recognise as an
        // emulator. That is a degraded anti-detect posture, not a launch failure — but it must
        // be visible in the status rather than passed off as a complete spoof.
        logger.warn(
          `Android profile ${this.profileId} launched with a partial identity spoof ` +
            `(privilege=${injectResult.privilege}); read-only properties and emulator artefacts ` +
            `were not rewritten`,
        );
      }

      // 5. Setup guest network & geolocation
      const netPlan = planGuestNetwork(this.options.proxy);
      netPlan.tun2socksBinaryOnHost = resolveTun2socksOnHost();
      const netResult = await setupGuestNetwork(this.adb, netPlan, {});
      this._status.network = { ok: netResult.ok, detail: netResult.detail, proxied: netResult.proxied };
      this.stopNetworkBridge = netResult.stopBridge ?? null;
      if (!netResult.ok) {
        // Only hard failures (bridge/tunnel/interface errors, proxy-less block failure) abort here.
        // A missing tun2socks binary on BOTH sides returns ok:true/proxied:false above — the guest
        // keeps direct NAT access, which is surfaced in status, not hidden behind a throw.
        throw new AndroidRuntimeError(
          `Guest traffic could not be forced through the profile's proxy: ${netResult.detail}. ` +
            `Refusing to start rather than leak.`,
          'ERR_ANDROID_NETWORK_NOT_ENFORCED'
        );
      }
      if (netResult.proxied === false) {
        logger.warn(`Android profile ${this.profileId} runs WITHOUT proxy enforcement (degraded direct NAT): ${netResult.detail}`);
      }

      if (typeof this.options.latitude === 'number' && typeof this.options.longitude === 'number') {
        try {
          const homeDir = process.env.USERPROFILE || process.env.HOME || '';
          const authTokenPath = path.join(homeDir, '.emulator_console_auth_token');
          if (fs.existsSync(authTokenPath)) {
            const controller = connectController(this.consolePort, authTokenPath);
            await pushGeolocation(controller, {
              latitude: this.options.latitude,
              longitude: this.options.longitude,
            });
            controller.close();
          }
        } catch (geoErr) {
          logger.warn(`Failed to push geolocation for Android profile ${this.profileId}:`, geoErr);
        }
      }

      // 6. Start stream host
      this.streamHost = new AndroidStreamHost(this);
      this._status.stream = 'starting';
      const streamPort = await getFreePort();
      await this.streamHost.start({ port: streamPort });
      this._status.stream = this.streamHost.status;
    } catch (bootErr: unknown) {
      const code =
        bootErr && typeof bootErr === 'object' && 'code' in bootErr && typeof bootErr.code === 'string'
          ? bootErr.code
          : 'ERR_ANDROID_BOOT_FAILED';
      const message = bootErr instanceof Error ? bootErr.message : String(bootErr);
      this._status.state = 'error';
      this._status.error = { code, message };
      await this.stop().catch(() => {});
      throw bootErr;
    }
  }


  /**
   * Materializes a per-profile AVD (`~/.android/avd/antidetect_<id>.{ini,avd/config.ini}`) pointing
   * at the shared read-only system image. Measured: this emulator build (37.2.11) exits 1 with
   * "No AVD specified" when launched with `-sysdir` alone, so `-avd` is mandatory; a machine-global
   * AVD would share writable state across profiles, hence one AVD per profile id.
   */
  private ensureAvd(): string {
    const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const avdRoot = path.join(homeDir, '.android', 'avd');
    const safeName = this.profileId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const avdName = `antidetect_${safeName}`;
    const avdDir = path.join(avdRoot, `${avdName}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    fs.writeFileSync(
      path.join(avdRoot, `${avdName}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${avdName}.avd\ntarget=android-34\n`,
      'utf8',
    );
    // The profile's own userdata copy lives inside its AVD dir (Copy-on-Write over the base).
    const avdUserData = path.join(avdDir, 'userdata-qemu.img');
    if (!fs.existsSync(avdUserData)) {
      const baseUserData = path.join(this.options.systemImageDir, 'userdata.img');
      if (fs.existsSync(baseUserData)) {
        fs.copyFileSync(baseUserData, avdUserData);
      }
    }
    // ABI/arch derive from the installed system image (arm64-v8a on macOS-arm64,
    // x86_64 elsewhere) — never hardcoded; path separators are posix (emulator parses them).
    const sysDir = this.options.systemImageDir.replace(/\\/g, '/');
    const abi = sysDir.includes('arm64-v8a') ? 'arm64-v8a' : 'x86_64';
    const imageSysdir = `system-images/android-34/google_apis/${abi}/`;
    fs.writeFileSync(
      path.join(avdDir, 'config.ini'),
      `avd.ini.encoding=UTF-8\nAvdId=${avdName}\nPlayStore.enabled=false\nabi.type=${abi}\n` +
        `avd.ini.displayname=${avdName}\ndisk.dataPartition.size=6G\nfastboot.forceColdBoot=no\n` +
        `fastboot.forceFastBoot=yes\nhw.accelerometer=yes\nhw.audioInput=no\nhw.audioOutput=no\n` +
        `hw.battery=yes\nhw.camera.back=virtualscene\nhw.camera.front=emulated\nhw.cpu.arch=${abi === 'arm64-v8a' ? 'arm64' : 'x86_64'}\n` +
        `hw.cpu.ncore=4\nhw.dPad=no\nhw.device.manufacturer=Google\nhw.device.name=pixel_7\n` +
        `hw.gps=yes\nhw.gpu.enabled=yes\nhw.gpu.mode=auto\nhw.initialOrientation=Portrait\n` +
        `hw.keyboard=yes\nhw.lcd.density=420\nhw.lcd.height=${this.screen.height}\n` +
        `hw.lcd.width=${this.screen.width}\nhw.mainKeys=no\nhw.ramSize=4096\nhw.sdCard=yes\n` +
        `hw.sensors.orientation=yes\nhw.sensors.proximity=yes\nhw.trackBall=no\n` +
        `image.sysdir.1=${imageSysdir}\n` +
        `runtime.network.latency=none\nruntime.network.speed=full\nsdcard.size=512M\n` +
        `showDeviceFrame=no\nskin.dynamic=no\ntag.display=Google APIs\ntag.id=google_apis\nvm.heapSize=576\n`,
      'utf8',
    );
    return avdName;
  }

  private async spawnEmulator(): Promise<void> {
    const avdName = this.ensureAvd();
    const args: string[] = [
      '-avd',
      avdName,
      '-port',
      String(this.consolePort),
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-read-only',
      '-skin',
      `${this.options.screen.width}x${this.options.screen.height}`,
    ];

    if (this.options.coldBoot) {
      args.push('-no-snapshot-load', '-no-snapshot-save');
    }

    logger.info(`Spawning emulator for ${this.profileId}: ${this.options.emulatorPath} ${args.join(' ')}`);

    const child = child_process.spawn(this.options.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });

    this.process = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      logger.info(`[emulator ${this.profileId}] ${chunk.toString().trim()}`);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      logger.warn(`[emulator ${this.profileId} stderr] ${chunk.toString().trim()}`);
    });

    child.on('error', (err: Error) => {
      logger.error(`Emulator process error for ${this.profileId}:`, err);
      this._status.state = 'error';
      this._status.error = { code: 'ERR_ANDROID_EMULATOR_PROCESS', message: err.message };
    });

    child.on('exit', (code: number | null, signal: string | null) => {
      logger.info(`Emulator process exited for ${this.profileId} (code: ${code}, signal: ${signal})`);
      if (this._status.state === 'running' || this._status.state === 'booting') {
        this._status.state = 'stopped';
      }
      this.process = null;
    });
  }

  /**
   * Tears down the running guest:
   * snapshots best-effort -> tears down network -> stops stream host -> adb emu kill -> kills process tree.
   */
  async stop(): Promise<void> {
    logger.info(`Stopping Android instance for ${this.profileId} (${this.serial})`);

    // 1. Snapshot best-effort unless coldBoot was requested
    if (!this.options.coldBoot && this.adb) {
      try {
        await this.adb.shell(['am', 'broadcast', '-a', 'android.intent.action.ACTION_SHUTDOWN']).catch(() => {});
      } catch {
        // ignore best-effort snapshot error
      }
    }

    // 2. Teardown guest network
    if (this.adb) {
      try {
        await teardownGuestNetwork(this.adb);
      } catch (err) {
        logger.warn(`Failed to teardown guest network for ${this.profileId}: ${err}`);
      }
    }

    // 2b. Close the host-side SOCKS bridge. It is a loopback listener this process owns, so it
    // would survive the guest and keep a port open for a profile that no longer runs.
    if (this.stopNetworkBridge) {
      try {
        await this.stopNetworkBridge();
      } catch (err) {
        logger.warn(`Failed to close guest SOCKS bridge for ${this.profileId}: ${err}`);
      }
      this.stopNetworkBridge = null;
    }

    // 3. Stop stream host (removes forwards)
    if (this.streamHost) {
      try {
        await this.streamHost.stop();
      } catch (err) {
        logger.warn(`Failed to stop stream host for ${this.profileId}: ${err}`);
      }
      this.streamHost = null;
    }

    // 4. ADB emu kill
    if (this.adb) {
      try {
        await this.adb.kill();
      } catch {
        // ignore adb kill failure if emulator already stopping
      }
    }

    // 5. Kill process tree
    if (this.process && this.process.pid) {
      const pid = this.process.pid;
      try {
        if (process.platform === 'win32') {
          // Argument-vector form: no shell, so the pid cannot be interpreted as a command.
          child_process.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-pid, 'SIGKILL');
        }
      } catch {
        try {
          this.process.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      this.process = null;
    }

    this._status.state = 'stopped';
    this._status.stream = 'idle';
  }

  issueStreamTicket(): AndroidStreamTicket {
    if (this._status.state !== 'running' || !this.streamHost) {
      throw new AndroidRuntimeError(
        `Cannot issue stream ticket: Android instance for ${this.profileId} is not running (state: ${this._status.state})`,
        'NOT_RUNNING'
      );
    }
    return this.streamHost.issueTicket();
  }
}

// Module-level registry
const instances = new Map<string, AndroidInstance>();

/**
 * Launches an Android profile, resolving the engine first so a missing installation is reported
 * as a not-ready condition rather than as a launch failure. Shared by the `/api/v1/android/*`
 * routes and the general profile surface (`/api/v1/browser/start`), so both paths run the same
 * code and cannot drift apart (R14).
 *
 * Throws `AndroidRuntimeError` with code `NOT_READY` when the engine is absent.
 */
export async function launchAndroidProfile(profileId: string): Promise<AndroidInstanceStatus> {
  const config = resolveAndroidConfig(profileId);

  const engineStatus = getAndroidEngineStatus();
  if (!engineStatus.installed || !engineStatus.emulatorPath) {
    throw new AndroidRuntimeError('Android engine is not installed', 'NOT_READY');
  }

  let engine: { engineDir: string; emulatorPath: string; systemImageDir: string };
  try {
    engine = await ensureAndroidEngine();
  } catch (engineErr: unknown) {
    throw new AndroidRuntimeError(
      messageOf(engineErr) || 'Android engine is not ready',
      'NOT_READY',
    );
  }

  return startAndroidProfile({
    profileId,
    systemImageDir: engine.systemImageDir,
    emulatorPath: engine.emulatorPath,
    adbPath: resolveAdbPath(engine.engineDir),
    screen: config.screen,
    proxy: config.proxy,
    timezone: config.timezone,
    latitude: config.geolocation?.latitude,
    longitude: config.geolocation?.longitude,
    seed: config.seed,
  });
}


export async function startAndroidProfile(o: AndroidStartOptions): Promise<AndroidInstanceStatus> {
  if (!o.emulatorPath || !fs.existsSync(o.emulatorPath)) {
    throw new AndroidRuntimeError(`Emulator binary not found at ${o.emulatorPath}`, 'ERR_ANDROID_NOT_READY');
  }
  if (!o.systemImageDir || !fs.existsSync(o.systemImageDir)) {
    throw new AndroidRuntimeError(
      `Android system image directory not found at ${o.systemImageDir}`,
      'ERR_ANDROID_NOT_READY'
    );
  }

  const existing = instances.get(o.profileId);
  if (existing && existing.status.state === 'running') {
    return existing.status;
  }

  if (existing) {
    await existing.stop().catch(() => {});
    instances.delete(o.profileId);
  }

  const instance = new AndroidInstance(o);
  instances.set(o.profileId, instance);

  try {
    await instance.start();
    return instance.status;
  } catch (err) {
    instances.delete(o.profileId);
    throw err;
  }
}

export async function stopAndroidProfile(profileId: string): Promise<boolean> {
  const instance = instances.get(profileId);
  if (!instance) return false;

  try {
    await instance.stop();
    return true;
  } finally {
    instances.delete(profileId);
  }
}

export function isAndroidRunning(profileId: string): boolean {
  const instance = instances.get(profileId);
  return Boolean(instance && instance.status.state === 'running');
}

export function getAndroidInstance(profileId: string): AndroidInstance | undefined {
  return instances.get(profileId);
}

export function listAndroidStatuses(): AndroidInstanceStatus[] {
  return Array.from(instances.values()).map((inst) => inst.status);
}

export async function shutdownAllAndroid(): Promise<void> {
  const all = Array.from(instances.values());
  await Promise.allSettled(all.map((inst) => inst.stop()));
  instances.clear();
}
