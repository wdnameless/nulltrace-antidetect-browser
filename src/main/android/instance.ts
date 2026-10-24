import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as os from 'os';
import * as child_process from 'child_process';
import * as crypto from 'crypto';
import { AdbClient, allocateEmulatorPorts, releaseEmulatorPorts } from './adb';
import { AndroidStreamHost, type AndroidStreamTicket, type AndroidInstanceLike } from './streamHost';
import {
  buildTouchMessage,
  buildKeyMessage,
  TOUCH_ACTION_DOWN,
  TOUCH_ACTION_UP,
  TOUCH_ACTION_MOVE,
  KEY_ACTION_DOWN,
  KEY_ACTION_UP,
} from './scrcpyProtocol';
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
import { readUiHierarchy, type AndroidUiSnapshot } from './uiHierarchy';
import { resolveAndroidPlatform, assertHypervisorReady } from './platform';
import {
  applyDeviceIdentity,
  readDeviceIdentity,
  PRODUCT_BUILD_PROP,
  FIXED_IDENTITY_KEYS,
  type DeviceIdentityResult,
} from './deviceIdentity';

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
  /** LCD density for the AVD (from the fingerprint preset; defaults to 420). */
  densityDpi?: number;
  /** Pinned preset id; without it the injector re-derives from the seed and silently
   * discards the one chosen in the profile card (measured defect). */
  presetId?: string;
  /** Locale + MCC/MNC resolved from the proxy country (interfaces §C). Settable props,
   * so they apply on a live guest without a reboot. */
  locale?: string | null;
  mccMnc?: string | null;
  /** Opt into the fail-closed no-egress sandbox (proxy-less profiles). */
  blockNetwork?: boolean;
  /** Emulator hw from profile config (defaults 4/4096/576). */
  cores?: number;
  ramMb?: number;
  heapMb?: number;
  proxy: { type: string; host: string; port: number; username?: string | null; password?: string | null } | null;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  seed: number;
  headless?: boolean; // always true today; kept explicit for R01
  coldBoot?: boolean; // skip the quickboot snapshot
  /** Runs the device-identity preparation pass as part of this launch (slow: restarts the emulator once or twice). */
  prepareOnStart?: boolean;
}

export interface AndroidInstanceStatus {
  profileId: string;
  state: 'starting' | 'booting' | 'running' | 'stopped' | 'error';
  serial: string;
  consolePort: number;
  adbPort: number;
  screen: { width: number; height: number };
  /** LCD density for the AVD (from the fingerprint preset; defaults to 420). */
  densityDpi?: number;
  /** Pinned preset id; without it the injector re-derives from the seed and silently
   * discards the one chosen in the profile card (measured defect). */
  presetId?: string;
  /** Locale + MCC/MNC resolved from the proxy country (interfaces §C). Settable props,
   * so they apply on a live guest without a reboot. */
  locale?: string | null;
  mccMnc?: string | null;
  stream: 'idle' | 'starting' | 'streaming' | 'error';
  /** Live encoder output: total video bytes + wall time of the last byte (0 = none yet). */
  streamStats?: { bytes: number; lastVideoAt: number };
  /** Milliseconds the guest has been booting; absent once it is no longer booting. */
  bootingForMs?: number;
  startedAt: number;
  error?: { code: string; message: string };
  inject?: InjectResult;
  /** What the guest actually reports, plus anything the emulator pins regardless of identity. */
  device?: DeviceIdentityResult & { effective: Record<string, string> };
  /** Outcome of forcing guest traffic through the profile's proxy (`proxied:false` = degraded direct NAT). */
  network?: { ok: boolean; detail: string; proxied?: boolean; directNat?: boolean };
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
  private streamWatchdog: ReturnType<typeof setInterval> | null = null;
  private streamRestarts = 0;
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
    const snapshot = { ...this._status };
    if (this.streamHost) {
      try {
        snapshot.streamStats = this.streamHost.videoStats;
        // The host's own state is authoritative and changes AFTER start() returned: it flips
        // to `streaming` on the first video bytes. Copying it once at start left the instance
        // reporting `starting` forever, so every client kept showing a dead canvas while frames
        // were actually arriving — the "screen never appears" symptom.
        snapshot.stream = this.streamHost.status;
      } catch {
        /* host mid-teardown */
      }
    }
    return snapshot;
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

    try {
      // 2-3. Spawn the emulator and wait for the guest to finish booting. A cold boot is
      // minutes; the status carries the elapsed time so the UI shows progress instead of a
      // dead "Starting…".
      await this.spawnAndWaitForBoot();

      // Guest is confirmed booted; transition to 'running'
      this._status.state = 'running';
      this._status.bootingForMs = undefined;

      // 3b. Device identity is NOT applied during a normal start: preparation restarts the
      // emulator once or twice, which would turn every launch into a multi-minute operation.
      // It is an explicit step (`prepareProfile`), run before the first use of a new profile.
      // A profile that has not been prepared reports the image's own device.
      if (this.options.prepareOnStart) {
        // Preparation restarts the emulator when it writes a new identity and starts the
        // per-boot services itself, so the instance is left exactly as a normal start leaves
        // it — including when the identity was already present and nothing was restarted.
        await this.prepareProfile();
      } else {
        this._status.device = {
          applied: [],
          fixed: [],
          rebootRequired: false,
          errors: [],
          effective: await readDeviceIdentity(this.adb),
        };
        await this.startGuestServices();
      }
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
   * Spawns the emulator process and waits for the guest to finish booting.
   *
   * Shared by `start()` (freshly allocated ports) and `restartGuestProcess()` (same ports):
   * both need the spawn-versus-boot-death race, and only one copy of it should exist.
   */
  private async spawnAndWaitForBoot(): Promise<void> {
    this._status.state = 'booting';
    const exitDuringStart = this.spawnEmulator();

    const bootAbort = new AbortController();
    try {
      await Promise.race([
        this.adb.waitForBoot({
          timeoutMs: this.options.bootTimeoutMs ?? 300_000,
          signal: bootAbort.signal,
          onWait: (elapsedMs) => {
            this._status.bootingForMs = elapsedMs;
          },
        }),
        // A guest that died (fatal config error, missing engine file, …) never reaches adb, so
        // waiting out the full deadline would report a 300 s "timeout" for a process that was
        // already gone 2 s in. Fail with what the emulator actually said.
        exitDuringStart,
      ]);
    } finally {
      // The race leaves the losing arm running; without this the poll loop keeps issuing adb
      // calls after the instance has been stopped.
      bootAbort.abort();
    }
  }

  /**
   * Starts everything a freshly booted guest needs to be useful: the runtime identity, the
   * proxied network, the geolocation, and the scrcpy stream.
   *
   * Runs at the end of `start()` and again after every emulator restart inside
   * `prepareProfile()`, so a prepared instance is left exactly as a started one — automation
   * can use it without relaunching.
   */
  private async startGuestServices(): Promise<void> {
    // 4. Inject mobile identity over ADB
    const fp = generateAndroidFingerprint(this.profileId, this.options.seed, this.options.presetId);
    const hasZygisk = await detectSpoofModule(this.adb).catch(() => false);
    const injectResult = await injectGuestIdentity(this.adb, fp, {
      timezone: this.options.timezone,
      locale: this.options.locale,
      mccMnc: this.options.mccMnc,
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
    const netPlan = planGuestNetwork(this.options.proxy, { blockNetwork: this.options.blockNetwork });
    netPlan.tun2socksBinaryOnHost = resolveTun2socksOnHost();
    const netResult = await setupGuestNetwork(this.adb, netPlan, {});
    this._status.network = {
      ok: netResult.ok,
      detail: netResult.detail,
      proxied: netResult.proxied,
      directNat: netResult.directNat,
    };
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
    this.watchStream();
  }


  /**
   * Tears down everything that belongs to the current boot — guest-side network first while adb
   * still reaches it, then the host-side listeners. Best-effort: every step is guarded so one
   * dead component cannot block the rest. Shared by `stop()` and `restartGuestProcess()`.
   */
  /**
   * Restarts the stream host when scrcpy dies mid-session.
   *
   * Measured: the scrcpy server exits (SIGTERM / exit 1) and nothing else notices, so the
   * instance keeps reporting `running` while the host sits in `error` — the operator sees a
   * frozen canvas and reports that the emulator 'does not start'. Bounded retries: a guest that
   * keeps killing scrcpy must not spawn servers forever.
   */
  private watchStream(): void {
    if (this.streamWatchdog) clearInterval(this.streamWatchdog);
    this.streamWatchdog = setInterval(() => {
      if (this._status.state !== 'running') return;
      const host = this.streamHost;
      if (!host || host.status !== 'error') return;
      if (this.streamRestarts >= 3) {
        this._status.stream = 'error';
        return;
      }
      this.streamRestarts += 1;
      logger.warn(`Android stream died for ${this.profileId}; restarting (attempt ${this.streamRestarts}/3)`);
      void this.restartStream();
    }, 5000);
    this.streamWatchdog.unref?.();
  }

  /**
   * Blocking readiness probe used after a prepare restart.
   *
   * `sys.boot_completed=1` fires long before the guest is usable: measured on this image the
   * package manager answers in ~5 s but the GMS/Settings UI needs ~20 s more, and an automator
   * that starts in that window finds "Add account" missing while the profile already reports
   * running. Three independent answers must agree before the guest is declared ready.
   */
  private async waitForGuestReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let pmReady = false;
    let bootDone = false;
    let launcherUp = false;
    while (Date.now() < deadline) {
      if (!bootDone) {
        const boot = await this.adb.shellCode(['getprop', 'sys.boot_completed']).catch(() => undefined);
        bootDone = boot?.stdout.trim() === '1';
      }
      if (bootDone && !pmReady) {
        const pm = await this.adb.shellCode(['pm', 'list', 'packages']).catch(() => undefined);
        pmReady = !!pm && pm.exitCode === 0 && pm.stdout.split('\n').length > 100;
      }
      if (pmReady && !launcherUp) {
        const focus = await this.adb.shellCode(['dumpsys', 'window']).catch(() => undefined);
        launcherUp = !!focus && /mCurrentFocus=.*(launcher|Launcher)/i.test(focus.stdout);
      }
      if (bootDone && pmReady && launcherUp) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    logger.warn(
      'Guest readiness probe timed out for ' + this.profileId +
        ' (boot=' + bootDone + ' pm=' + pmReady + ' launcher=' + launcherUp + ')',
    );
  }

  private async restartStream(): Promise<void> {
    try {
      await this.streamHost?.stop().catch(() => undefined);
    } catch {
      /* host already gone */
    }
    if (this._status.state !== 'running') return;
    try {
      this.streamHost = new AndroidStreamHost(this);
      this._status.stream = 'starting';
      const port = await getFreePort();
      await this.streamHost.start({ port });
      this._status.stream = this.streamHost.status;
    } catch (err) {
      logger.warn(`Stream restart failed for ${this.profileId}: ${(err as Error).message}`);
      this._status.stream = 'error';
    }
  }

  private async stopGuestServices(): Promise<void> {
    try {
      await teardownGuestNetwork(this.adb);
    } catch (err) {
      logger.warn(`Failed to teardown guest network for ${this.profileId}: ${err}`);
    }
    // The SOCKS bridge is a loopback listener this process owns, so it would survive the guest
    // and keep a port open for a profile that no longer runs.
    if (this.stopNetworkBridge) {
      try {
        await this.stopNetworkBridge();
      } catch (err) {
        logger.warn(`Failed to close guest SOCKS bridge for ${this.profileId}: ${err}`);
      }
      this.stopNetworkBridge = null;
    }
    if (this.streamHost) {
      try {
        await this.streamHost.stop();
      } catch (err) {
        logger.warn(`Failed to stop stream host for ${this.profileId}: ${err}`);
      }
      this.streamHost = null;
    }
  }


  /**
   * Materializes a per-profile AVD (`~/.android/avd/antidetect_<id>.{ini,avd/config.ini}`) pointing
   * at the shared read-only system image. Measured: this emulator build (37.2.11) exits 1 with
   * "No AVD specified" when launched with `-sysdir` alone, so `-avd` is mandatory; a machine-global
   * AVD would share writable state across profiles, hence one AVD per profile id.
   *
   * The data partition is NOT pre-seeded. `system-images/.../userdata.img` is a 1 MiB blank
   * placeholder; copying it in makes the emulator's qcow2 overlay declare a 1 MiB virtual disk
   * (`qemu-img` virtual size 1 048 576) while `config.ini` asks for `disk.dataPartition.size=6G`.
   * The guest then cannot mount `/data` — vold logs `init_user0 Failed … /data/misc/vold/user_keys`
   * and boot never reaches `sys.boot_completed`, which is the 300 s hang. Left absent, the
   * emulator formats a full 6 GiB partition on first boot (verified: `/data` 5.8 G mounted).
   */
  private ensureAvd(): string {
    const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const avdRoot = path.join(homeDir, '.android', 'avd');
    const safeName = this.profileId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const avdName = `antidetect_${safeName}`;
    const avdDir = path.join(avdRoot, `${avdName}.avd`);
    // A snapshot is only resumable by the emulator configuration that produced it: a profile
    // snapshotted before a launch flag changed fails to boot with "Error -1 from the snapshot
    // callback" and then times out. Recording the flags that define compatibility and dropping
    // the snapshot when they differ keeps that from ever being a 300 s hang.
    // metrics=v2: screen metrics are physical px now (width*dsf), not preset dp. A dp-sized
    // AVD (412x915 LCD) would keep rendering squeezed UI even with fixed code, so the
    // signature bump forces a config + userdata rebuild on next start.
    const hwSpec = [
      this.options.cores ?? 6,
      this.options.ramMb ?? 6144,
      this.options.heapMb ?? 768,
      this.screen.width,
      this.screen.height,
      this.options.densityDpi ?? 420,
    ].join(",");
    const hwHash = crypto.createHash("sha256").update(hwSpec).digest("hex").slice(0, 8);
    const launchSignature = `gpu=host;system=writable;snapshot=v1;metrics=v2;hw=${hwHash}`;
    const signatureFile = path.join(avdDir, ".nulltrace-launch-signature");
    let previousSignature = "";
    try {
      previousSignature = fs.readFileSync(signatureFile, "utf8").trim();
    } catch {
      // No signature yet: the profile has never been launched by this code.
    }
    if (previousSignature !== launchSignature) {
      fs.rmSync(path.join(avdDir, "snapshots"), { recursive: true, force: true });
      // A metrics change invalidates the whole AVD (LCD size lives in config.ini AND the
      // userdata overlay); snapshots alone are not enough.
      if (!previousSignature.includes("metrics=v2")) {
        fs.rmSync(avdDir, { recursive: true, force: true });
      }
      fs.mkdirSync(avdDir, { recursive: true });
      fs.writeFileSync(signatureFile, launchSignature, "utf8");
    }
    fs.mkdirSync(avdDir, { recursive: true });
    fs.writeFileSync(
      path.join(avdRoot, `${avdName}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${avdName}.avd\ntarget=android-34\n`,
      'utf8',
    );
    // The data partition is deliberately NOT seeded: the system image's `userdata.img` is a
    // 1 MiB blank placeholder, and copying it makes the qcow2 overlay declare a 1 MiB virtual
    // disk that the guest cannot mount as `/data` (vold `init_user0` fails, boot never
    // completes). A 1 MiB overlay left by an earlier version is discarded here so an existing
    // profile heals itself instead of needing a manual wipe.
    const avdUserData = path.join(avdDir, 'userdata-qemu.img');
    const avdUserDataQcow2 = `${avdUserData}.qcow2`;
    if (fs.existsSync(avdUserDataQcow2)) {
      // A qcow2 header is 192 KB whether the disk is 1 MiB or 6 GiB, so the file size says
      // nothing — the declared virtual size at offset 24 does.
      const header = Buffer.alloc(32);
      const fd = fs.openSync(avdUserDataQcow2, 'r');
      try {
        fs.readSync(fd, header, 0, 32, 0);
      } finally {
        fs.closeSync(fd);
      }
      const isQcow2 = header.toString('latin1', 0, 4) === 'QFI\xfb';
      const virtualSize = isQcow2 ? header.readBigUInt64BE(24) : 0n;
      if (isQcow2 && virtualSize <= 1024n * 1024n) {
        fs.rmSync(avdUserData, { force: true });
        fs.rmSync(avdUserDataQcow2, { force: true });
      }
    } else if (fs.existsSync(avdUserData) && fs.statSync(avdUserData).size <= 1024 * 1024) {
      fs.rmSync(avdUserData, { force: true });
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
        `hw.cpu.ncore=${this.options.cores ?? 6}\nhw.dPad=no\nhw.device.manufacturer=Google\nhw.device.name=pixel_7\n` +
        // `-gpu host` is passed explicitly at spawn; the AVD records the same choice so a
        // manual launch from Android Studio behaves like one started by this app.
        `hw.gps=yes\nhw.gpu.enabled=yes\nhw.gpu.mode=host\nhw.initialOrientation=Portrait\n` +
        `hw.keyboard=yes\nhw.lcd.density=${this.options.densityDpi ?? 420}\nhw.lcd.height=${this.screen.height}\n` +
        `hw.lcd.width=${this.screen.width}\nhw.mainKeys=no\nhw.ramSize=${this.options.ramMb ?? 6144}\nhw.sdCard=yes\n` +
        `hw.sensors.orientation=yes\nhw.sensors.proximity=yes\nhw.trackBall=no\n` +
        `image.sysdir.1=${imageSysdir}\n` +
        `runtime.network.latency=none\nruntime.network.speed=full\nsdcard.size=512M\n` +
        `showDeviceFrame=no\nskin.dynamic=no\ntag.display=Google APIs\ntag.id=google_apis\nvm.heapSize=${this.options.heapMb ?? 768}\n`,
      'utf8',
    );
    return avdName;
  }

  /**
   * Spawns the guest and returns a promise that settles only if it dies while booting.
   *
   * Deliberately NOT `async`: an async function *adopts* a returned promise, so
   * `await spawnEmulator()` would wait for that death promise — which only ever rejects — and the
   * launch would hang forever after a successful spawn.
   */
  private spawnEmulator(): Promise<never> {
    const avdName = this.ensureAvd();
    // A leftover emulator from a crashed session holds this AVD exclusively (no `-read-only`),
    // and the new process answers with a fatal instead of booting. Clear it first.
    this.killStaleEmulatorForAvd(avdName);
    const args: string[] = [
      '-avd',
      avdName,
      '-port',
      String(this.consolePort),
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      // `-read-only` would let several instances share one AVD, but it also disables snapshots —
      // measured: every start was a 50-65 s cold boot because `snapshot save` is refused in that
      // mode. Each profile has its own AVD, so shared access is not needed and the quickboot
      // snapshot is worth far more (measured restore: 5 s).
      // Headless defaults to the software GLES renderer (SwiftShader), which measured 15.7
      // packets/s while scrolling. `-gpu host` uses the real GPU (verified: RTX 3060 via
      // `gles_mode_selected:host`) and measured 35.6 packets/s for the same motion.
      '-gpu',
      'host',
      // Per-profile device identity lives in an overlayfs upper on the profile’s own userdata,
      // which is only mounted when this flag is present. Measured: without it the guest serves the
      // stock image’s sdk_gphone64_x86_64 again. A snapshot IS resumable under this flag as long as
      // it was saved by a guest running with it (measured: 6 s restore).
      '-writable-system',
      '-skin',
      `${this.options.screen.width}x${this.options.screen.height}`,
    ];

    // Identity (`ro.product.*`, `ro.build.*`) is NOT applied here. Measured on this exact image:
    // `-prop ro.product.model=…` leaves `getprop ro.product.model` at `sdk_gphone64_x86_64`, and
    // `setprop` on the same key fails even from a uid-0 adbd ("Failed to set property … See
    // dmesg") because those values come from the read-only system image's build.prop. Overriding
    // them needs a writable system image plus a Magisk/`resetprop` layer, which this engine does
    // not ship; `injectGuestIdentity` reports that honestly as `privilege: 'setprop-only'`
    // instead of claiming a spoof the guest will not serve.
    // Always a full boot. Measured: with `-writable-system` present a saved snapshot is not
    // resumable ("Error -1 from the snapshot callback") and the boot then hangs until the
    // deadline. The writable overlay carries each profile's own device identity, so it wins
    // over the faster warm start.
    args.push('-no-snapshot-load', '-no-snapshot-save');

    logger.info(`Spawning emulator for ${this.profileId}: ${this.options.emulatorPath} ${args.join(' ')}`);

    const child = child_process.spawn(this.options.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    });

    this.process = child;

    /** Last fatal line the emulator printed, so a dead guest is reported with its own words. */
    let fatalLine = '';

    const noteFatal = (text: string, isStderr: boolean) => {
      // The emulator's own diagnostic (`FATAL | …`, `ERROR | …`) is far more actionable than a
      // generic "process exited", and it is already in the child's output.
      const line = text
        .split(/\r?\n/)
        .find((l) => /^\s*(FATAL|ERROR)\s*\|/i.test(l));
      if (line) {
        fatalLine = line.trim();
      }
      if (isStderr) {
        logger.warn(`[emulator ${this.profileId} stderr] ${text.trim()}`);
      } else {
        logger.info(`[emulator ${this.profileId}] ${text.trim()}`);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => noteFatal(chunk.toString(), false));
    child.stderr?.on('data', (chunk: Buffer) => noteFatal(chunk.toString(), true));

    // Settles only if the process dies while this instance is still starting/booting.
    const { promise: died, reject: rejectDied } = Promise.withResolvers<never>();
    // The rejection is consumed by `start()`; mark it handled so a stop before then is silent.
    died.catch(() => undefined);

    child.on('error', (err: Error) => {
      logger.error(`Emulator process error for ${this.profileId}:`, err);
      const failure = new AndroidRuntimeError(
        `Emulator process failed to start: ${err.message}`,
        'ERR_ANDROID_EMULATOR_PROCESS',
      );
      this._status.state = 'error';
      this._status.error = { code: failure.code, message: failure.message };
      rejectDied(failure);
    });

    child.on('exit', (code: number | null, signal: string | null) => {
      logger.info(`Emulator process exited for ${this.profileId} (code: ${code}, signal: ${signal})`);
      // An exit during any phase before `running` is a launch failure, not a stop: the common
      // cause is a configuration fatal — most often another emulator already holding this AVD
      // (`FATAL | Running multiple emulators with the same AVD … use -read-only`) or a port
      // collision — which would otherwise wait out the whole boot deadline and read as a
      // timeout. Rejecting here fails the spawn-versus-boot-death race with the emulator's
      // own words instead.
      const launchFailed = this._status.state === 'starting' || this._status.state === 'booting';
      if (launchFailed) {
        rejectDied(
          new AndroidRuntimeError(
            fatalLine ||
              `Android emulator exited while booting (code ${code}${signal ? `, signal ${signal}` : ''})`,
            'ERR_ANDROID_EMULATOR_EXIT',
          ),
        );
      }
      this.process = null;
      if (launchFailed) {
        this._status.state = 'stopped';
      }
    });

    return died;
  }

  /** Kills the emulator process tree this instance owns, if it is still alive. */
  private killEmulatorProcess(): void {
    if (!this.process?.pid) {
      return;
    }
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
        // Already gone.
      }
    }
    this.process = null;
  }


  /**
   * Prepares the profile so it boots as the device its fingerprint describes.
   *
   * Measured sequence (each step verified on this AVD):
   * 1. If the guest already reports the expected model, there is nothing to do.
   * 2. Otherwise the writable overlay is armed (`root` + `remount`); on the first boot after
   *    `-writable-system` was enabled `/product` stays read-only until the emulator process
   *    has been restarted once, so a failed probe triggers exactly one restart.
   * 3. The identity is written into `/product/etc/build.prop`.
   * 4. The emulator process is restarted so `init` publishes the new `ro.product.*` values.
   *    An `adb reboot` cannot do this step: measured, a `-writable-system` guest comes back
   *    half-started (`sys.boot_completed` unset, the package manager not running) and the boot
   *    wait exhausts its whole deadline on it — while a fresh process boots cleanly.
   * 5. The per-boot services are started again, so the instance is left exactly as a normal
   *    start leaves it: automation can use it without relaunching.
   *
   * Idempotent: a prepared profile returns after step 1 without touching the running guest.
   */
  async prepareProfile(): Promise<DeviceIdentityResult & { effective: Record<string, string> }> {
    const fp = generateAndroidFingerprint(this.profileId, this.options.seed, this.options.presetId);
    const expected = fp.model;

    const before = await readDeviceIdentity(this.adb);
    // Every emulator restart below tears the per-boot services down; they are started again
    // before returning, so callers always get a usable instance back. When the identity was
    // already present nothing is restarted — but a launch with `prepareOnStart` has no services
    // yet, so that case starts them too. Failures return a result instead of throwing: the
    // profile still boots, it just did not become its own device.
    let restarted = false;
    const finishFailure = async (
      failure: DeviceIdentityResult & { effective: Record<string, string> },
    ): Promise<DeviceIdentityResult & { effective: Record<string, string> }> => {
      if (restarted || !this.streamHost) {
        try {
          await this.startGuestServices();
        } catch (err) {
          failure.errors.push(`per-boot services failed to restart: ${messageOf(err)}`);
        }
      }
      this._status.device = failure;
      return failure;
    };

    // Early exit ONLY when the model AND the GMS client identity are already published.
    // The model alone is not enough: a profile prepared before the clientidbase family was
    // written reports the right phone while GMS still has no sign-in endpoint (measured).
    const clientReady = !!before['ro.com.google.clientidbase'];
    if (before['ro.product.model'] === expected && clientReady) {
      const result = await finishFailure({
        applied: [],
        fixed: [...FIXED_IDENTITY_KEYS],
        rebootRequired: false,
        errors: [],
        effective: before,
      });
      return result;
    }

    // Arm the overlay, restarting the emulator process at most once. Measured as the sequence
    // that works; repeating it does not help, so a failure here is reported instead of looped.
    let writable = false;
    await this.adb.root().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await this.adb.shellCode(['remount', '--all']).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const earlyProbe = await this.adb.shellCode(['cp', PRODUCT_BUILD_PROP, '/product/etc/.nulltrace-probe']);
    writable = earlyProbe.exitCode === 0;
    if (writable) {
      await this.adb.shellCode(['rm', '-f', '/product/etc/.nulltrace-probe']);
    } else {
      await this.restartGuestProcess();
      restarted = true;
      await this.adb.root().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    await this.adb.shellCode(['remount', '--all']).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const probe = await this.adb.shellCode(['cp', PRODUCT_BUILD_PROP, '/product/etc/.nulltrace-probe']);
      writable = probe.exitCode === 0;
      if (writable) {
        await this.adb.shellCode(['rm', '-f', '/product/etc/.nulltrace-probe']);
      }
    }

    if (!writable) {
      return finishFailure({
        applied: [],
        fixed: [],
        rebootRequired: false,
        errors: [`${PRODUCT_BUILD_PROP} is still read-only; the writable overlay did not activate`],
        effective: before,
      });
    }

    // Step 3: write the identity against the now-writable partition.
    const written = await applyDeviceIdentity(this.adb, fp);
    if (!written.rebootRequired) {
      return finishFailure({ ...written, effective: await readDeviceIdentity(this.adb) });
    }

    // Step 4: publish it with a fresh emulator process booting the prepared userdata.
    await this.restartGuestProcess();
    // A booted kernel is NOT a usable guest: GMS and the Settings UI come up tens of seconds
    // after sys.boot_completed, and handing the profile to an automator in that window makes
    // 'Add account' unavailable while the profile already answers running. Wait for the
    // package manager and the launcher to answer before declaring the profile prepared.
    await this.waitForGuestReady();
    const effective = await readDeviceIdentity(this.adb);
    const result: DeviceIdentityResult & { effective: Record<string, string> } = {
      ...written,
      rebootRequired: false,
      effective,
    };
    await this.startGuestServices();
    this._status.device = result;
    if (effective['ro.product.model'] !== expected) {
      result.errors.push(
        `guest reports ${effective['ro.product.model'] || '<unset>'} after preparation, expected ${expected}`,
      );
    }
    return result;
  }

  /**
   * Restarts the emulator process itself so the guest boots again from its data partition.
   *
   * `adb reboot` is not usable here: measured on a guest booted with `-writable-system`, the
   * device comes back with `sys.boot_completed` unset and a half-started system (`pm list
   * packages` answers a single line), so the boot wait exhausts its whole deadline on a guest
   * that will never finish. Killing the process and spawning a fresh one on the same ports is
   * what a reboot means for an AVD, and the writable system overlay survives it because it
   * lives in the profile's own userdata.
   *
   * The per-boot services (stream host, guest network, SOCKS bridge) are torn down first: they
   * belong to the old boot and would otherwise keep pointing at a dead guest. The caller is
   * responsible for starting them again afterwards (`startGuestServices`).
   */
  private async restartGuestProcess(): Promise<void> {
    // 1. Tear down everything that belongs to the old boot: it would otherwise keep pointing
    // at a dead guest. The caller starts the services again afterwards (`startGuestServices`).
    await this.stopGuestServices();

    // 2. Kill the emulator: `emu kill` first (graceful), then the process tree (certain). The
    // old child's `exit` handler is detached first — it would otherwise fire after the new
    // spawn below and null out the new process while flipping the state to `stopped`.
    const oldProcess = this.process;
    try {
      await this.adb.kill();
    } catch {
      // The guest may already be gone; the process kill below is what actually ends it.
    }
    this.killEmulatorProcess();
    oldProcess?.removeAllListeners('exit');
    oldProcess?.removeAllListeners('error');

    // 3. Observe the gap — a surviving transport would keep answering `getprop` from the old
    // boot — then spawn a fresh emulator on the same ports and wait for the new boot.
    await this.adb.waitForDisconnect(60_000);
    await this.spawnAndWaitForBoot();
    this._status.state = 'running';
    this._status.bootingForMs = undefined;
  }

  /**
   * Terminates an emulator process that is still holding this profile's AVD.
   *
   * Without `-read-only` two emulators cannot share an AVD (fatal at startup), and a leftover
   * process from a crashed session would otherwise make every later start hang until the boot
   * deadline. Only a process whose command line names this AVD is touched.
   */
  private killStaleEmulatorForAvd(avdName: string): void {
    if (process.platform !== 'win32') {
      return;
    }
    const query = child_process.spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64-headless.exe' OR Name='emulator.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*${avdName}*' } | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );

    const pids = (query.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);

    for (const pid of pids) {
      logger.warn(`Killing a stale emulator process holding ${avdName} (pid ${pid})`);
      child_process.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    }
  }

  /**
   * Tears down the running guest:
   * snapshots best-effort -> tears down network -> stops stream host -> adb emu kill -> kills process tree.
   */
  async stop(): Promise<void> {
    logger.info(`Stopping Android instance for ${this.profileId} (${this.serial})`);

    // NOTE: no shutdown broadcast here. `ACTION_SHUTDOWN` tells the guest to power off; the
    // snapshot taken moments later then captures a half-dead VM, and the next start reports
    // `device offline` forever.
    await this.stopGuestServices();

    // 5. ADB emu kill
    if (this.adb) {
      try {
        await this.adb.kill();
      } catch {
        // ignore adb kill failure if emulator already stopping
      }
    }

    // 5. Kill process tree
    this.killEmulatorProcess();

    // Free the console port for the next start. Without this the in-process claim registry
    // would leak one pair per stop and eventually report "no free ports" on a idle machine.
    if (this.consolePort > 0) {
      releaseEmulatorPorts(this.consolePort);
    }

    this._status.state = 'stopped';
    this._status.stream = 'idle';
  }

  /**
   * Re-applies per-install identifiers on a RUNNING guest (rotation, interfaces §B).
   * Only the settable surface is touched — android_id via settings, serial via setprop —
   * so no reboot is needed. Returns true when the guest read back the new android_id.
   */
  async applyIdentity(fp: { androidId: string; serial: string }): Promise<boolean> {
    this.requireControl();
    let ok = false;
    try {
      await this.adb.shell(['settings', 'put', 'secure', 'android_id', fp.androidId]);
      const actual = await this.adb.shell(['settings', 'get', 'secure', 'android_id']);
      ok = actual.trim() === fp.androidId;
    } catch {
      ok = false;
    }
    try {
      await this.adb.shell(['setprop', 'ro.serialno', fp.serial]);
    } catch {
      // ro.serialno is immutable without the overlay; rotation still holds for android_id
    }
    this._status.inject = {
      applied: [...(this._status.inject?.applied ?? [])],
      skipped: [...(this._status.inject?.skipped ?? [])],
      errors: [...(this._status.inject?.errors ?? [])],
      privilege: this._status.inject?.privilege ?? 'setprop-only',
    };
    return ok;
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

  /**
   * MCP/automation control surface. All methods require a running instance with a
   * connected scrcpy control channel; otherwise they throw AndroidRuntimeError NOT_RUNNING.
   * Coordinates are physical guest px (same space as the stream canvas).
   */
  private requireControl(): AndroidStreamHost {
    if (this._status.state !== 'running' || !this.streamHost) {
      throw new AndroidRuntimeError(
        `Android instance for ${this.profileId} is not running (state: ${this._status.state})`,
        'NOT_RUNNING',
      );
    }
    return this.streamHost;
  }

  private assertPoint(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
        x > this.screen.width || y > this.screen.height) {
      throw new AndroidRuntimeError(
        `Point (${x},${y}) is outside the ${this.screen.width}x${this.screen.height} screen`,
        'ERR_ANDROID_BAD_POINT',
      );
    }
  }

  /**
   * Viewport the guest validates touches against. The scrcpy server drops any touch
   * whose screenW/H differs from the VIDEO size ("Ignore touch event, it was generated
   * for a different device size"), and the encoder rounds the requested LCD (e.g.
   * 1082x2402 → 1080x2400 for H264 evenness). Same rule as AndroidCanvas: the size
   * comes from the codec meta once it arrives, else the requested screen.
   */
  private controlViewport(host: AndroidStreamHost): { width: number; height: number } {
    const meta = host.codecMeta;
    if (meta && meta.width > 0 && meta.height > 0) {
      return { width: meta.width, height: meta.height };
    }
    return { width: this.screen.width, height: this.screen.height };
  }

  /** Tap = DOWN + UP on the scrcpy control channel (no round-trip, <5 ms). */
  tap(x: number, y: number): void {
    const host = this.requireControl();
    this.assertPoint(x, y);
    const vp = this.controlViewport(host);
    const sx = (x * vp.width) / this.screen.width;
    const sy = (y * vp.height) / this.screen.height;
    const base = { x: sx, y: sy, screenW: vp.width, screenH: vp.height };
    host.sendControl(buildTouchMessage({ ...base, action: TOUCH_ACTION_DOWN }));
    host.sendControl(buildTouchMessage({ ...base, action: TOUCH_ACTION_UP }));
  }

  /** Swipe = DOWN + interpolated MOVEs + UP. Steps scale with distance (1 per ~40 px). */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    const host = this.requireControl();
    this.assertPoint(x1, y1);
    this.assertPoint(x2, y2);
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.min(50, Math.round(dist / 40)));
    const vp = this.controlViewport(host);
    const base = { screenW: vp.width, screenH: vp.height };
    const sx = (x: number): number => (x * vp.width) / this.screen.width;
    const sy = (y: number): number => (y * vp.height) / this.screen.height;
    host.sendControl(buildTouchMessage({ ...base, x: sx(x1), y: sy(y1), action: TOUCH_ACTION_DOWN }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      host.sendControl(buildTouchMessage({
        ...base,
        x: sx(x1 + (x2 - x1) * t),
        y: sy(y1 + (y2 - y1) * t),
        action: TOUCH_ACTION_MOVE,
      }));
      if (i < steps && durationMs > 0) {
        await new Promise((r) => setTimeout(r, durationMs / steps));
      }
    }
    host.sendControl(buildTouchMessage({ ...base, x: sx(x2), y: sy(y2), action: TOUCH_ACTION_UP }));
  }

  /**
   * Types text via `adb shell input text`. The guest shell splits on spaces, so each
   * space becomes `%s`; single quotes are the only shell metachar the arg array cannot
   * carry, and are sent as `%s`-separated runs would break words — instead they are
   * dropped with a logged warning (measured: keeping them breaks the whole string).
   */
  async type(text: string): Promise<void> {
    this.requireControl();
    if (typeof text !== 'string' || text.length === 0 || text.length > 4000) {
      throw new AndroidRuntimeError('text must be a non-empty string of at most 4000 chars', 'ERR_ANDROID_BAD_ARG');
    }
    const escaped = text.replace(/'/g, '').replace(/ /g, '%s').replace(/\n/g, '%s');
    await this.adb.shell(['input', 'text', escaped]);
  }

  /** Injects a key press (DOWN + UP) by Android keycode (e.g. 4 = BACK, 66 = ENTER). */
  key(keycode: number): void {
    const host = this.requireControl();
    if (!Number.isInteger(keycode) || keycode < 0 || keycode > 300) {
      throw new AndroidRuntimeError(`keycode must be an integer 0..300, got ${keycode}`, 'ERR_ANDROID_BAD_ARG');
    }
    host.sendControl(buildKeyMessage({ keycode, action: KEY_ACTION_DOWN }));
    host.sendControl(buildKeyMessage({ keycode, action: KEY_ACTION_UP }));
  }

  /**
   * Captures a PNG screenshot via `adb exec-out screencap -p`. Binary-safe: the raw
   * stdout buffer is returned without any utf-8 decoding (decoding corrupts the PNG).
   */
  async screencap(timeoutMs = 20_000): Promise<Buffer> {
    this.requireControl();
    return this.adb.execOut(['screencap', '-p'], { timeoutMs });
  }

  /** Installs a host-side APK file onto the guest (long timeout: dexopt takes minutes). */
  /** Current UI hierarchy of the running guest (fresh dump, normalised bounds). */
  async uiHierarchy(): Promise<AndroidUiSnapshot> {
    this.requireControl();
    return readUiHierarchy(this.adb);
  }


  async installApk(apkPath: string): Promise<void> {
    this.requireControl();
    if (typeof apkPath !== 'string' || apkPath.length === 0) {
      throw new AndroidRuntimeError('apkPath must be a non-empty string', 'ERR_ANDROID_BAD_ARG');
    }
    if (!fs.existsSync(apkPath)) {
      throw new AndroidRuntimeError(`APK not found at ${apkPath}`, 'ERR_ANDROID_APK_NOT_FOUND');
    }
    await this.adb.install(apkPath);
  }
}

// Module-level registry
const instances = new Map<string, AndroidInstance>();

// Guards concurrent startAndroidProfile calls for the same profile: without it two
// simultaneous starts both pass the registry check and boot two emulators on different
// ports, and the loser overwrites the winner in the map (orphaned process + AVD lock fight).
const startingProfiles = new Set<string>();

/**
 * Launches an Android profile, resolving the engine first so a missing installation is reported
 * as a not-ready condition rather than as a launch failure. Shared by the `/api/v1/android/*`
 * routes and the general profile surface (`/api/v1/browser/start`), so both paths run the same
 * code and cannot drift apart (R14).
 *
 * Throws `AndroidRuntimeError` with code `NOT_READY` when the engine is absent.
 * Runs the same `assertHypervisorReady` gate as the install route before spawning, so a dead
 * hypervisor fails immediately with `ERR_ANDROID_NO_HYPERVISOR` instead of a 300 s boot timeout.
 */
export async function launchAndroidProfile(profileId: string): Promise<AndroidInstanceStatus> {
  const config = resolveAndroidConfig(profileId);

  const engineStatus = getAndroidEngineStatus();
  if (!engineStatus.installed || !engineStatus.emulatorPath) {
    throw new AndroidRuntimeError('Android engine is not installed', 'NOT_READY');
  }

  await assertHypervisorReady(resolveAndroidPlatform());

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
    densityDpi: config.densityDpi,
    presetId: config.fingerprint.presetId,
    locale: config.locale,
    mccMnc: config.mccMnc,
    blockNetwork: config.blockNetwork,
    cores: config.cores,
    ramMb: config.ramMb,
    heapMb: config.heapMb,
    proxy: config.proxy,
    timezone: config.timezone,
    latitude: config.geolocation?.latitude,
    longitude: config.geolocation?.longitude,
    seed: config.seed,
  });
}


export async function startAndroidProfile(o: AndroidStartOptions): Promise<AndroidInstanceStatus> {
  // Claimed BEFORE validation: two callers racing with bad paths must still serialize, and a
  // caller that throws on validation must not leave a sibling thinking the profile is free to
  // boot twice. Validation is sync and cheap; the claim is released in `finally`.
  if (startingProfiles.has(o.profileId)) {
    throw new AndroidRuntimeError(
      `Android profile ${o.profileId} is already starting`,
      'ERR_ANDROID_ALREADY_STARTING',
    );
  }
  startingProfiles.add(o.profileId);
  try {
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
  } finally {
    startingProfiles.delete(o.profileId);
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
