import { spawn, ChildProcess, execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import puppeteer from 'puppeteer-core';
import type { Target } from 'puppeteer-core';
import { getChromiumPath, getChromedriverPath } from '../config';
import type { LaunchConfig } from '../profiles/profileManager';
import { setStatus } from '../profiles/profileManager';
import {
  isTemporaryProfile,
  cleanTemporaryDirectory,
  unregisterTemporaryProfile,
} from '../profiles/temporaryRegistry';
import { createSshTunnel, SshTunnel } from '../proxy/sshTunnel';
import { installProxyAuth } from '../proxy/proxyAuth';
import { applyDeviceEmulation } from '../proxy/deviceEmulation';
import { applyStealth, writeStealthExtension } from '../proxy/stealthInjection';
import { applyGeolocation } from '../proxy/geoEmulation';
import { injectCookies } from '../proxy/cookieInjector';
import { detectMachineTimezone } from '../util/ipInfo';
import { resolveGpuFlags } from '../util/gpuBackend';
import {
  probeTransportTarget,
  composeTransportFlags,
  registerActiveProfile,
  TransportProbeTarget,
  TransportProbeResult,
  StrictQuicRelayError,
} from '../proxy/transportPolicy';
import {
  startUdpRelay,
  registerUdpRelayState,
  unregisterUdpRelayState,
  UdpRelayState,
} from '../proxy/udpRelay';
import { TransportDropMonitor } from '../proxy/transportDropMonitor';
import { appendProfileArgs, formatBadgeTitlePrefix } from '../profiles/profileManager';
import { planWindowTitle, startWindowTitleKeeper } from './windowTitle';
import {
  verifyStealthExtensionDirectory,
  StealthExtensionVerificationError,
} from '../security/extensionVerifier';
import { getStealthSigningKey } from '../security/stealthKey';
import { DATA_DIR } from '../config';
import { mergeManagedBookmarks, getProfileGroupBookmarks } from '../folders/bookmarks';

interface RunningProfile {
  pid: number;
  port: string;
  wsPuppeteer: string;
  wsSelenium: string;
  process: ChildProcess;
  tunnel?: SshTunnel;
  cleanupAuth?: () => void;
  cleanupEmulation?: () => void;
  cleanupGeo?: () => void;
  cleanupStealth?: () => void;
  cleanupTransport?: () => void;
  cleanupDropMonitor?: () => void;
  cleanupRelay?: () => void;
  cleanupWindowTitle?: () => void;
  cleanupScreen?: () => void;
  relayState?: UdpRelayState;
}

function isStrictQuicRelay(cfg: LaunchConfig): boolean {
  // SAFETY: `strictQuicRelay` is set by the API layer on the launch config object and is not
  // declared on `LaunchConfig` (it belongs to the transport-policy slice). The cast reads a
  // property TypeScript cannot know about; the `typeof` guard is what makes the read sound,
  // so an absent or non-boolean value resolves to `false` instead of propagating `unknown`.
  const value = (cfg as unknown as Record<string, unknown>).strictQuicRelay;
  return typeof value === 'boolean' ? value : false;
}

export interface StartResult {
  ws: { puppeteer: string; selenium: string };
  debug_port: string;
  webdriver: string;
  pid: number;
  relayState?: UdpRelayState;
}

/**
 * Keep `screen.*` matching the profile's declared resolution for the life of the launch.
 *
 * `Emulation.setDeviceMetricsOverride` is bound to the CDP session that issued it: detaching
 * reverts it, and a page created later never had it. Both were measured against the shipped
 * kernel under `--headless=new --window-size=1920,1080`:
 *
 *   (nothing)                          -> screen 800x600,    outer 1920x1080
 *   override sent, then session closed -> screen 800x600     (reverted)
 *   override sent, session kept open   -> screen 1920x1080   (correct)
 *
 * Headless Chromium invents an 800x600 screen; a real desktop never pairs that with a
 * 1920x1080 window, so leaving it is a fingerprint tell in every headless profile. The
 * override therefore has to be re-applied to each page as it appears and its session kept
 * alive — hence a listener rather than a call.
 *
 * Returns a disposer that detaches every session it opened.
 */
async function installScreenOverride(
  wsPuppeteer: string,
  screen: { width: number; height: number }
): Promise<() => void> {
  const sessions: Array<{ detach: () => Promise<void> }> = [];
  const browser = await puppeteer.connect({ browserWSEndpoint: wsPuppeteer, defaultViewport: null });

  const applyTo = async (target: Target): Promise<void> => {
    if (target.type() !== 'page') return;
    try {
      const session = await target.createCDPSession();
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: screen.width,
        height: screen.height,
        screenWidth: screen.width,
        screenHeight: screen.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      sessions.push(session);
    } catch {
      // A target can vanish between listing and attaching; the next one is unaffected.
    }
  };

  for (const target of await browser.targets()) {
    await applyTo(target);
  }
  browser.on('targetcreated', (target) => {
    void applyTo(target);
  });

  return () => {
    browser.removeAllListeners('targetcreated');
    for (const session of sessions) {
      void session.detach().catch(() => undefined);
    }
    try {
      browser.disconnect();
    } catch {
      // ignore
    }
  };
}
const running = new Map<string, RunningProfile>();

export function isRunning(profileId: string): boolean {
  return running.has(profileId);
}

export function getRunningWs(profileId: string): string | undefined {
  return running.get(profileId)?.wsPuppeteer;
}

/** Loopback CDP endpoint of a running profile (port + ws path), for the tunnel. */
export function getCdpEndpoint(profileId: string): { port: string; wsPath: string } | undefined {
  const rec = running.get(profileId);
  if (!rec) return undefined;
  const wsPath = rec.wsPuppeteer.slice(rec.wsPuppeteer.indexOf('/devtools/'));
  return { port: rec.port, wsPath };
}

/** Loopback CDP debug port of a running profile (diagnostics/CDP helpers). */
export function getRunningPort(profileId: string): string | undefined {
  return running.get(profileId)?.port;
}

function toResult(r: RunningProfile): StartResult {
  return {
    ws: { puppeteer: r.wsPuppeteer, selenium: r.wsSelenium },
    debug_port: r.port,
    // Selenium via debuggerAddress: path to chromedriver matching the kernel (Chromium 148).
    webdriver: getChromedriverPath() ?? '',
    pid: r.pid,
    relayState: r.relayState,
  };
}

/**
 * Kill the browser process tree. Chromium spawns multiple child processes;
 * on Windows `kill()` alone may leave orphans, so prefer `taskkill /T /F`.
 */
function killTree(rec: RunningProfile): void {
  if (process.platform === 'win32' && rec.pid) {
    try {
      execFile('taskkill', ['/pid', String(rec.pid), '/T', '/F'], () => {
        // fallback if taskkill failed for any reason
        try {
          rec.process.kill();
        } catch {
          // ignore
        }
      });
      return;
    } catch {
      // fall through to plain kill
    }
  }
  try {
    rec.process.kill();
  } catch {
    // ignore
  }
}

/**
 * Run one teardown callback, swallowing whatever it throws.
 *
 * Every cleanup hook attached to a launch — auth, emulation, geo, stealth, screen, transport —
 * is torn down on the same path, and none of them may stop the others: a failure in the
 * screen-override teardown must not leave the SSH tunnel open. The list is ordered and each
 * entry is independent, which is why this is a helper rather than a try/finally chain.
 */
function runCleanup(hook: (() => void) | undefined): void {
  if (!hook) return;
  try {
    hook();
  } catch {
    // ignore
  }
}

function cleanup(rec: RunningProfile): void {
  killTree(rec);
  runCleanup(rec.cleanupTransport);
  runCleanup(rec.cleanupDropMonitor);
  runCleanup(rec.cleanupRelay);
  runCleanup(rec.cleanupWindowTitle);
  if (rec.tunnel) void rec.tunnel.close();
  runCleanup(rec.cleanupAuth);
  runCleanup(rec.cleanupEmulation);
  runCleanup(rec.cleanupGeo);
  runCleanup(rec.cleanupStealth);
  runCleanup(rec.cleanupScreen);
}

export async function buildChromiumArgs(
  cfg: LaunchConfig,
  proxyServer?: string,
  transportFlags: string[] = []
): Promise<string[]> {
  // Tell the JavaScript stealth layer which surfaces the KERNEL is already spoofing, so it stands
  // down on those rather than overwriting them on the main thread only.
  //
  // Measured basis: with the kernel alone, canvas is already unique per profile AND identical on
  // the page and inside a worker (four seeds -> four distinct hashes, each stable across
  // contexts), and deviceMemory is consistent in both too. The JavaScript layer's own canvas
  // noise, memory value and Client Hints object applied to the page but never to the worker — a
  // surface disagreement, including two different canvas hashes and an empty userAgentData in the
  // worker, for one claimed device. An antifraud script does not need to know the correct value;
  // the disagreement itself is the signal.
  //
  // The kernel spoofs whenever a seed is passed, so that is the signal. Computed once here because
  // four separate sites in this function write the stealth extension and they must all agree.
  //
  // A local rather than reassigning the `cfg` parameter: shadowing an argument makes every later
  // read of `cfg` in this long function ambiguous about which shape it sees.
  const stealthCfg =
    cfg.stealth && cfg.fingerprint && cfg.fingerprint.seed > 0
      ? { ...cfg.stealth, engineCovers: { canvas: true, deviceMemory: true, clientHints: true, webgl: true } }
      : cfg.stealth;
  const args: string[] = [
    `--user-data-dir=${cfg.userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // Keep session cookies on disk too — logins must survive restarts.
    '--persist-session-cookies',
  ];
  if (cfg.headless) {
    args.push('--headless=new');
  }
  // GPU backend. Without this the shipped kernel exposes a NULL WebGL context on hosts whose
  // only GL path is a software rasteriser (RDP sessions, VMs) — see `util/gpuBackend.ts` for
  // the measurements. This must come before the profile's own extras so an operator can still
  // override it with `--use-angle=...`/`--use-gl=...` in `launch_args` (Chromium is last-wins).
  args.push(...(await resolveGpuFlags()));
  if (transportFlags.length > 0) {
    args.push(...transportFlags);
  } else if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`);
  }

  // Desktop screen resolution override (AdsPower-style, from fingerprint config).
  if (cfg.screenOverride) {
    args.push(`--window-size=${cfg.screenOverride.width},${cfg.screenOverride.height}`);
    args.push(`--window-position=0,0`);
  }

  // Kernel fingerprint flags (fingerprint-chromium). Stock Chromium ignores unknown flags,
  // so this is safe even when a stock binary is resolved.
  if (cfg.fingerprint && cfg.fingerprint.seed > 0) {
    args.push(`--fingerprint=${cfg.fingerprint.seed}`);
    if (cfg.fingerprint.platform) args.push(`--fingerprint-platform=${cfg.fingerprint.platform}`);
    if (cfg.fingerprint.platformVersion) {
      args.push(`--fingerprint-platform-version=${cfg.fingerprint.platformVersion}`);
    }
    if (cfg.fingerprint.brand) args.push(`--fingerprint-brand=${cfg.fingerprint.brand}`);
    if (cfg.fingerprint.brandVersion) {
      args.push(`--fingerprint-brand-version=${cfg.fingerprint.brandVersion}`);
    }
    if (cfg.fingerprint.hardwareConcurrency) {
      args.push(`--fingerprint-hardware-concurrency=${cfg.fingerprint.hardwareConcurrency}`);
    }
    if (cfg.fingerprint.disableSpoofing) {
      args.push(`--disable-spoofing=${cfg.fingerprint.disableSpoofing}`);
    }
    // Explicit profile timezone wins; otherwise auto-detect from the proxy IP;
    // otherwise detect from the machine's egress IP (keeps timezone coherent with IP).
    const timezone =
      cfg.fingerprint.timezone ?? cfg.proxyTimezone ?? (await detectMachineTimezone());
    if (timezone) args.push(`--timezone=${timezone}`);
    if (cfg.fingerprint.lang) {
      args.push(`--lang=${cfg.fingerprint.lang}`);
      args.push(`--accept-lang=${cfg.fingerprint.lang}`);
    }
  }

  /*
   * An explicit User-Agent from the profile row, if the operator set one.
   *
   * `LaunchConfig.userAgent` has been populated from `profiles.user_agent` all along and was never
   * read by either launcher — Chromium ignored it and the Firefox path hardcoded `userAgent:
   * undefined`. So the field appeared in the profile editor and did nothing.
   *
   * Measured against the kernel rather than assumed: with `--fingerprint=1234` alone the UA comes
   * from the seed, and adding `--user-agent=<custom>` DID replace it (`OPR/` present), so the flag
   * is the working override for this build.
   *
   * Deliberately applied AFTER the fingerprint flags and only when set: a UA that contradicts the
   * fingerprint's platform is itself a detection signal (a Windows-platform fingerprint announcing
   * Opera on Linux), so this is the operator's explicit choice rather than something inferred.
   */
  if (cfg.userAgent) args.push(`--user-agent=${cfg.userAgent}`);

  // Reopen where the operator left off. This has to be a SWITCH, not a Preference.
  //
  // Writing `session.restore_on_startup` into Preferences looked right and did nothing: Chromium
  // owns that file and rewrites it while it runs, so the value written before a launch was gone
  // by the time the browser read it — measured, the file came back with `session: {}` and
  // `exit_type: "Crashed"` during the same run. The switch is checked against the kernel binary
  // rather than assumed: `--restore-last-session` and `--hide-crash-restore-bubble` are both
  // present in the shipped `chrome.dll`, and a switch Chromium does not know is accepted and
  // silently ignored, so probing the binary is the only way to tell the difference.
  //
  // `--hide-crash-restore-bubble` matters because a profile exited by force-kill is recorded as
  // having crashed; without it the restore arrives as a "restore pages?" bubble instead of the
  // session, which reads as the feature not working.
  args.push('--restore-last-session');
  args.push('--hide-crash-restore-bubble');

  // Private-engine switch (parity program, add-engine-level-hardening task 4.1):
  // when a stealth-engine build is selected, pass its profile id and dump the
  // full fingerprint payload next to the user-data-dir so the patched C++ core
  // can read it. A stock Chromium binary ignores the unknown switch — zero
  // behavior change without the engine.
  const engineProfileId = (cfg as { stealthEngineProfileId?: string }).stealthEngineProfileId;
  if (engineProfileId) {
    args.push(`--stealth-engine-profile=${engineProfileId}`);
    try {
      const engineCfgPath = path.join(cfg.userDataDir, 'stealth-engine-profile.json');
      fs.writeFileSync(
        engineCfgPath,
        JSON.stringify({ id: engineProfileId, fingerprint: cfg.fingerprint, color: cfg.color }, null, 2),
        'utf8'
      );
    } catch {
      // profile dump is best-effort; the switch itself is already passed
    }
  }

  // Extensions & Stealth layer: load bound unpacked extensions and stealth MV3 extension.
  // CDP script injection is broken in this kernel, so the stealth script ships as an
  // extension loaded via --load-extension (kernel supports it, verified in Sprint B).
  const extensionsToLoad: string[] = [];
  if (cfg.extensionPaths && cfg.extensionPaths.length) {
    extensionsToLoad.push(...cfg.extensionPaths);
  }
  if (stealthCfg) {
    const stealthExtDir = path.join(cfg.userDataDir, 'stealth-ext');
    const sigFile = path.join(stealthExtDir, 'stealth-manifest.sig.json');
    const signingKey = getStealthSigningKey(DATA_DIR);
    if (!fs.existsSync(stealthExtDir) || !fs.existsSync(sigFile)) {
      writeStealthExtension(stealthExtDir, stealthCfg, { signingKey });
    } else if (stealthLocaleChanged(stealthExtDir, stealthCfg)) {
      // The extension was written once and never revisited, so a language chosen afterwards left
      // the OLD locale in place — measured on a real profile: `navigator.language` reported
      // en-US while the generated voice pool still said `ja-JP`, from the seed's locale at the
      // time the extension was first built. The two must describe one machine, so a changed
      // locale rebuilds the extension.
      console.info(`[stealth] Rebuilding stealth extension for profile '${cfg.profileId}': its locale no longer matches the profile's language`);
      writeStealthExtension(stealthExtDir, stealthCfg, { signingKey });
    }
    try {
      verifyStealthExtensionDirectory(stealthExtDir, { profileId: cfg.profileId });
    } catch (err: unknown) {
      // Only `key-not-found` is recoverable. It means this directory was signed by a process
      // whose key is gone — what the ephemeral-key era left behind, including every artifact the
      // operator already has — and no process can ever verify it again. Regenerating replaces it
      // with an artifact this installation signed itself, which is strictly more trustworthy
      // than one nobody can check.
      //
      // `digest-mismatch` is NOT recoverable and must never be rebuilt: it means the bytes
      // changed after signing, which is the tamper signal itself. Regenerating there would
      // discard the evidence and run our own code in place of something an attacker altered,
      // turning the check into decoration. See the `secure-runtime-supply-chain` requirement.
      if (err instanceof StealthExtensionVerificationError && err.verificationResult?.reason === 'key-not-found') {
        console.info(`[stealth] Regenerating stealth extension for profile '${cfg.profileId}': its signature names a key this installation no longer has`);
        writeStealthExtension(stealthExtDir, stealthCfg, { signingKey });
        verifyStealthExtensionDirectory(stealthExtDir, { profileId: cfg.profileId });
      } else {
        throw err;
      }
    }
    extensionsToLoad.push(stealthExtDir);
  }
  if (extensionsToLoad.length > 0) {
    args.push(`--load-extension=${extensionsToLoad.join(',')}`);
  }

  // Per-profile privacy knobs from the create form, applied before the user's own extra
  // switches so the documented last-wins rule still lets an operator override them.
  //
  // Every switch here was checked against the kernel binary itself (`chrome.dll` in the
  // pinned fingerprint-chromium build). That check is not ceremony: Chromium accepts an
  // unknown switch and silently ignores it, so a control wired to a non-existent flag looks
  // implemented while doing nothing. `--fingerprint-screen-refresh-rate` was exactly that.

  // Blocked ports: `--host-resolver-rules` refuses resolution outright, which needs no
  // firewall rule and is the portable way to do this from inside the browser.
  if (cfg.blocked_ports && cfg.blocked_ports.length > 0) {
    const rules = cfg.blocked_ports.map((p) => `MAP *:${p} ~NOTFOUND`).join(',');
    args.push(`--host-resolver-rules=${rules}`);
  }

  // WebRTC IP handling. The kernel exposes `webrtc-ip-handling-policy`; the
  // `force-webrtc-ip-handling-policy` spelling used elsewhere in this codebase does NOT
  // exist in the binary, so it was silently doing nothing (corrected alongside this change).
  if (cfg.webrtc_policy && cfg.webrtc_policy !== 'default') {
    args.push(`--webrtc-ip-handling-policy=${cfg.webrtc_policy}`);
  }


  // The taskbar title, before the per-profile extras so an operator-supplied
  // `--window-name` still wins (Chromium's last-wins rule).
  const titlePlan = planWindowTitle(cfg.profileName, formatBadgeTitlePrefix(cfg.color, cfg.profileName));
  if (titlePlan.flagValue) {
    args.push(`--window-name=${titlePlan.flagValue}`);
  }

  // Per-profile extra switches go LAST so Chromium's last-wins rule lets the
  // user override launcher defaults (parity program: extra-launch-args).
  return appendProfileArgs(args, cfg.launch_args);
}
/**
 * Writes the `enable_do_not_track` preference into the profile's `Default/Preferences`.
 *
 * A malformed or absent Preferences file must not stop a launch: this is a privacy nicety,
 * and a browser that refuses to start is strictly worse than one sending the wrong DNT
 * header. A corrupt file is therefore replaced rather than propagated.
 */
export function applyDoNotTrackPref(userDataDir: string, enabled: boolean): boolean {
  const profileDir = path.join(userDataDir, 'Default');
  const prefsPath = path.join(profileDir, 'Preferences');
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    let prefs: Record<string, unknown> = {};
    if (fs.existsSync(prefsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          prefs = parsed as Record<string, unknown>;
        }
      } catch {
        // Corrupt file: start clean rather than refusing to launch.
        prefs = {};
      }
    }
    if (enabled) {
      prefs.enable_do_not_track = true;
    } else {
      delete prefs.enable_do_not_track;
    }
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the stealth extension on disk was built for a different locale than the profile now has.
 *
 * The extension embeds a `CFG` object whose `locale` selects the speech-synthesis voice pool. It
 * is written once and, before this check existed, never rewritten — so changing a profile's
 * browser language left the old locale in the extension forever, and a profile reporting
 * `navigator.language = "en-US"` still advertised voices for its seed's original language.
 *
 * A missing or unreadable script is reported as "changed" so the caller rebuilds it. That is the
 * safe direction: a rebuild is cheap and verifiable, while leaving an unreadable artifact in place
 * would keep a wrong locale alive.
 */
export function stealthLocaleChanged(stealthExtDir: string, opts: { locale?: string }): boolean {
  const scriptPath = path.join(stealthExtDir, 'stealth.js');
  if (!fs.existsSync(scriptPath)) return true;

  let embedded: string | undefined;
  try {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const match = /const CFG = (\{[\s\S]*?\});/.exec(source);
    if (match) {
      const parsed: unknown = JSON.parse(match[1]);
      // Narrow rather than assert: the file is on disk and could have been written by any
      // earlier version, so its shape is not guaranteed by anything the compiler can see.
      if (parsed && typeof parsed === 'object' && 'locale' in parsed) {
        const value = parsed.locale;
        if (typeof value === 'string') embedded = value;
      }
    }
  } catch {
    return true;
  }

  // An absent locale in either place is a mismatch: the script should always carry one.
  if (!embedded || !opts.locale) return embedded !== opts.locale;
  return embedded !== opts.locale;
}

export async function startProfile(cfg: LaunchConfig): Promise<StartResult> {
  const existing = running.get(cfg.profileId);
  if (existing) return toResult(existing);

  const executable = getChromiumPath();
  fs.mkdirSync(cfg.userDataDir, { recursive: true });
  // Remove a stale DevToolsActivePort from a previous run: otherwise waitForDevToolsPort
  // may read the old (dead) port before the new process writes its own.
  try {
    fs.rmSync(path.join(cfg.userDataDir, 'DevToolsActivePort'), { force: true });
  } catch {
    // ignore
  }
  // Task 2.2: fail closed before launching if stealth extension artifact is tampered or unsigned
  if (cfg.stealth) {
    const stealthExtDir = path.join(cfg.userDataDir, 'stealth-ext');
    if (fs.existsSync(stealthExtDir)) {
      try {
        verifyStealthExtensionDirectory(stealthExtDir, { profileId: cfg.profileId });
      } catch (err: unknown) {
        // Same rule as `buildChromiumArgs`: only a signature naming a key this installation no
        // longer holds is recoverable. A digest mismatch is the tamper signal and is re-thrown.
        if (err instanceof StealthExtensionVerificationError && err.verificationResult?.reason === 'key-not-found') {
          const signingKey = getStealthSigningKey(DATA_DIR);
          console.info(`[stealth] Regenerating stealth extension for profile '${cfg.profileId}': its signature names a key this installation no longer has`);
          writeStealthExtension(stealthExtDir, cfg.stealth!, { signingKey });
          verifyStealthExtensionDirectory(stealthExtDir, { profileId: cfg.profileId });
        } else {
          throw err;
        }
      }
    }
  }
  // Sync folder bookmarks before launch (non-fatal on error)
  try {
    const groupBookmarks = getProfileGroupBookmarks(cfg.profileId);
    const mergedCount = mergeManagedBookmarks(cfg.userDataDir, groupBookmarks);
    console.log(`[bookmarks] synced ${mergedCount} folder bookmarks for profile ${cfg.profileId}`);
  } catch (err) {
    console.warn(`[bookmarks] failed to sync folder bookmarks for profile ${cfg.profileId}:`, err);
  }


  // SSH proxies are tunneled to a local SOCKS5 endpoint first.
  let tunnel: SshTunnel | undefined;
  let proxyServer = cfg.proxyServer;
  if (cfg.sshTunnel) {
    tunnel = await createSshTunnel(cfg.sshTunnel);
    proxyServer = `socks5://127.0.0.1:${tunnel.port}`;
  }

  // Network Transport Policy pre-launch probe & flag composition
  let transportFlags: string[] = [];
  let relayCleanup: (() => void) | undefined;
  let profileRelayState: UdpRelayState = proxyServer || cfg.sshTunnel ? 'quic-disabled' : 'unavailable';
  let proxyTargetHost: string | undefined;
  let proxyTargetPort: number | undefined;

  if (proxyServer || cfg.sshTunnel) {
    let target: TransportProbeTarget;
    if (cfg.sshTunnel) {
      target = { protocol: 'ssh', host: cfg.sshTunnel.host, port: cfg.sshTunnel.port };
    } else {
      try {
        const url = new URL(proxyServer!.startsWith('http') || proxyServer!.startsWith('socks') ? proxyServer! : `http://${proxyServer!}`);
        const protocol = url.protocol.replace(':', '') as TransportProbeTarget['protocol'];
        target = {
          protocol,
          host: url.hostname,
          port: parseInt(url.port, 10) || (protocol === 'socks5' ? 1080 : 80),
          username: cfg.proxyAuth?.username,
          password: cfg.proxyAuth?.password,
        };
      } catch {
        target = { protocol: 'socks5', host: '127.0.0.1', port: 1080 };
      }
    }
    proxyTargetHost = target.host;
    proxyTargetPort = target.port;

    let probeResult: TransportProbeResult;
    if (cfg.bypassProxyProbe) {
      // Operator requested launching with proxy despite synthetic probe failure.
      // Default to CONSTRAINED so QUIC and WebRTC direct paths are safely disabled.
      probeResult = {
        status: 'CONSTRAINED',
        stages: { tcpConnect: true, auth: true, proxyDns: true },
        timestamp: Date.now(),
      };
    } else {
      probeResult = await probeTransportTarget(target, { timeoutMs: 15000 });
      if (probeResult.status === 'REFUSE') {
        const err = new Error(`Proxy transport probe failed at stage ${probeResult.error?.stage}: ${probeResult.error?.message}`);
        // SAFETY: the transport-policy slice decorates the thrown error with stage/code so the API reports reasons.
        (err as unknown as { stage?: string; code?: string }).stage = probeResult.error?.stage;
        // SAFETY: code half of the same error decoration.
        (err as unknown as { stage?: string; code?: string }).code = probeResult.error?.code;
        throw err;
      }
    }

    if (probeResult.status === 'SOCKS5_FULL_PASS' && target.protocol === 'socks5') {
      try {
        const relaySession = await startUdpRelay(cfg.profileId, {
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
        });
        profileRelayState = 'relay';
        relayCleanup = relaySession.stop;
      } catch (err) {
        if (isStrictQuicRelay(cfg)) {
          if (tunnel) void tunnel.close();
          throw new StrictQuicRelayError(
            `Strict QUIC relay enforcement failed: UDP relay setup failed for profile '${cfg.profileId}'`,
            { profileId: cfg.profileId, cause: err }
          );
        }
        profileRelayState = 'quic-disabled';
      }
    } else {
      if (isStrictQuicRelay(cfg)) {
        if (tunnel) void tunnel.close();
        throw new StrictQuicRelayError(
          `Strict QUIC relay enforcement failed: SOCKS5 probe status '${probeResult.status}' does not permit UDP relay for profile '${cfg.profileId}'`,
          { profileId: cfg.profileId }
        );
      }
      profileRelayState = 'quic-disabled';
    }
    registerUdpRelayState(cfg.profileId, profileRelayState);

    transportFlags = composeTransportFlags(probeResult, proxyServer);
    if (profileRelayState === 'quic-disabled' && !transportFlags.includes('--disable-quic')) {
      transportFlags.push('--disable-quic');
    }
  } else {
    registerUdpRelayState(cfg.profileId, 'unavailable');
  }
  const args = await buildChromiumArgs(cfg, proxyServer, transportFlags);

  /**
   * Which title mechanism this launch uses. Computed once here, before the spawn, so the
   * argument builder and the keeper cannot both act: with `--window-name` set the kernel
   * re-asserts its own value and reverts a WinAPI write.
   */
  const titlePlan = planWindowTitle(cfg.profileName, formatBadgeTitlePrefix(cfg.color, cfg.profileName));

  // Do Not Track is a PREFERENCE, not a switch — see `applyDoNotTrackPref`. Written here,
  // immediately before the spawn, because `buildChromiumArgs` is a pure argument builder
  // (tests call it directly) and must not touch the filesystem.
  if (cfg.do_not_track === 'on' || cfg.do_not_track === 'off') {
    applyDoNotTrackPref(cfg.userDataDir, cfg.do_not_track === 'on');
  }

  let child: ChildProcess;
  try {
    // A resolved executable must EXIST before we spawn it, with one exception: a bare command name
    // is meant to be found on PATH, and `fs.existsSync('chrome')` is false for a perfectly good
    // Chrome. The old test was `executable !== 'chrome.exe'` — a literal Windows name — so on macOS
    // the guard silently passed a non-existent `'chrome.exe'` straight to spawn, and the operator
    // got a bare ENOENT instead of "the kernel is not installed".
    //
    // The distinction is now "is this a path or a command name": anything containing a separator is
    // a path and must exist; a bare name goes to PATH and is reported by spawn if it is missing too.
    const looksLikePath = executable.includes('/') || executable.includes('\\');
    if (looksLikePath && !fs.existsSync(executable)) {
      if (tunnel) void tunnel.close();
      throw new Error(
        `Browser binary not found at "${executable}". Install the browser kernel in Settings, or set CHROMIUM_PATH.`
      );
    }
    child = spawn(executable, args, { stdio: 'ignore' });
  } catch (err) {
    if (tunnel) void tunnel.close();
    throw new Error(`Failed to launch browser (${executable}): ${(err as Error).message}`);
  }

  child.on('error', (err) => {
    console.error('[chromium] child process error:', err.message);
  });

  if (!child.pid) {
    if (tunnel) void tunnel.close();
    // The user-data directory was created before the spawn, and the normal-exit cleanup only
    // runs for a child that started. Without this, every failed launch of a TEMPORARY profile
    // left an empty directory behind. Non-temporary profiles are deliberately left alone: their
    // directory is the profile and is reused on the next launch.
    if (cfg.temporary || isTemporaryProfile(cfg.profileId)) {
      void cleanTemporaryDirectory(cfg.userDataDir).catch(() => {});
      unregisterTemporaryProfile(cfg.profileId);
    }
    throw new Error(`failed to spawn chromium (${executable})`);
  }

  try {
    const { port, wsPath } = await waitForDevToolsPort(cfg.userDataDir);
    const wsPuppeteer = `ws://127.0.0.1:${port}${wsPath}`;

    // Install proxy auth handler (CDP Fetch) before handing the endpoint to the caller.
    let cleanupAuth: (() => void) | undefined;
    if (cfg.proxyAuth) {
      cleanupAuth = await installProxyAuth(wsPuppeteer, cfg.proxyAuth);
    }

    // Mobile device emulation (touch/screen/UA) via CDP.
    let cleanupEmulation: (() => void) | undefined;
    if (cfg.deviceEmulation) {
      cleanupEmulation = await applyDeviceEmulation(wsPuppeteer, cfg.deviceEmulation);
    }

    // Stealth layer: Client Hints + headless-trace fixes (always applied).
    let cleanupStealth: (() => void) | undefined;
    if (cfg.stealth) {
      cleanupStealth = await applyStealth(wsPuppeteer, cfg.stealth);
    }

    // Geolocation spoofing via CDP (Sprint A).
    let cleanupGeo: (() => void) | undefined;
    if (cfg.geolocation) {
      cleanupGeo = await applyGeolocation(wsPuppeteer, cfg.geolocation);
    }

    // Cookie injection via CDP (Sprint A).
    if (cfg.cookies && cfg.cookies.length) {
      await injectCookies(wsPuppeteer, cfg.cookies);
    }

    // Screen metrics override via CDP.
    //
    // Why this is not a one-shot call: `Emulation.setDeviceMetricsOverride` is scoped to the
    // CDP session that issued it, and `detach` reverts it. Measured against the shipped kernel
    // in `--headless=new --window-size=1920,1080`:
    //
    //   no override                          -> screen 800x600, outer 1920x1080
    //   override applied to a page, detached -> screen 800x600   (reverted)
    //   override applied and kept alive      -> screen 1920x1080 (correct)
    //   new page opened after the override   -> screen 800x600   (not inherited)
    //
    // A virtual 800x600 screen next to a 1920x1080 window is a pairing no real desktop
    // produces, and it is what headless Chromium reports on its own. The override therefore
    // has to follow every page for the life of the profile, which is what `installScreenOverride`
    // does — it is not best-effort cleanup, it is the fix.
    let cleanupScreen: (() => void) | undefined;
    if (cfg.screenOverride) {
      cleanupScreen = await installScreenOverride(wsPuppeteer, cfg.screenOverride);
    }

    // Start URLs (v0.2.6): open on start (first in current tab, rest in new tabs).
    if (cfg.startUrls && cfg.startUrls.length) {
      try {
        const sBrowser = await puppeteer.connect({ browserWSEndpoint: wsPuppeteer, defaultViewport: null });
        const pages = await sBrowser.pages();
        const first = pages[0] ?? (await sBrowser.newPage());
        await first.goto(cfg.startUrls[0], { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        for (const url of cfg.startUrls.slice(1)) {
          const p = await sBrowser.newPage();
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
        sBrowser.disconnect();
      } catch {
        // start_urls are convenience; not fatal if a navigation fails
      }
    }

    const rec: RunningProfile = {
      pid: child.pid,
      port,
      wsPuppeteer,
      wsSelenium: `127.0.0.1:${port}`,
      process: child,
      tunnel,
      cleanupAuth,
      cleanupEmulation,
      cleanupGeo,
      cleanupStealth,
      cleanupRelay: relayCleanup,
      cleanupScreen,
      relayState: profileRelayState,
    };
    // Register the running profile BEFORE wiring transport-loss hooks: the
    // hook itself reads this map (regression fix: a51adf2 dropped the set).
    running.set(cfg.profileId, rec);
    const unregisterTransport = registerActiveProfile(cfg.profileId, (_reason) => {
      // Immediate mid-session termination on transport loss (zero direct fallback)
      const current = running.get(cfg.profileId);
      if (current) {
        cleanup(current);
        running.delete(cfg.profileId);
      }
    });
    rec.cleanupTransport = unregisterTransport;

    /**
     * The taskbar title: what the operator sees when hovering the button.
     *
     * This replaces a `Page.setTitle` call over CDP on every open page. That command is not in
     * the DevTools Protocol — the shipped kernel reports zero title-related commands — and the
     * call sat inside a `try`/`catch` that swallowed everything, so it had never done anything
     * and never said so. The badge prefix it computed was lost with it.
     *
     * `--window-name` (appended in `buildChromiumArgs`) carries an ASCII title and survives
     * pages that rewrite theirs. A name with any non-ASCII character is dropped by that flag
     * entirely — so those are kept through the WinAPI instead. Exactly one of the two runs:
     * with the flag set the kernel re-asserts its own value and reverts a WinAPI write.
     */
    if (!cfg.headless && titlePlan.keeperTitle) {
      rec.cleanupWindowTitle = startWindowTitleKeeper(child.pid, titlePlan.keeperTitle);
    }

    if (proxyTargetHost && proxyTargetPort) {
      const dropMonitor = new TransportDropMonitor({
        profileId: cfg.profileId,
        host: proxyTargetHost,
        port: proxyTargetPort,
      });
      dropMonitor.start();
      rec.cleanupDropMonitor = () => dropMonitor.stop();
    }
    child.on('exit', () => {
      running.delete(cfg.profileId);
      unregisterTransport();
      if (rec.cleanupRelay) {
        try {
          rec.cleanupRelay();
        } catch {
          // ignore
        }
      }
      unregisterUdpRelayState(cfg.profileId);
      if (rec.tunnel) void rec.tunnel.close();
      if (rec.cleanupAuth) {
        try {
          rec.cleanupAuth();
        } catch {
          // ignore
        }
      }
      if (rec.cleanupEmulation) {
        try {
          rec.cleanupEmulation();
        } catch {
          // ignore
        }
      }
      if (rec.cleanupGeo) {
        try {
          rec.cleanupGeo();
        } catch {
          // ignore
        }
      }
      if (rec.cleanupStealth) {
        try {
          rec.cleanupStealth();
        } catch {
          // ignore
        }
      }
      /**
       * The title keeper is a separate process, so the browser exiting does not end it.
       * Without this the keeper stays resident after the profile closes, holding a poll
       * loop against a dead PID. It would exit on its own once the PID is gone — but only
       * after the OS reuses or reports it, which is not a guarantee to rely on for a
       * process this code started.
       */
      if (rec.cleanupWindowTitle) {
        try {
          rec.cleanupWindowTitle();
        } catch {
          // ignore
        }
      }
      // Watchdog: keep the DB status in sync when the kernel exits on its own
      // (crash, manual close of the browser window). Intentionally swallows
      // errors so the exit path never throws.
      if (!cfg.temporary && !isTemporaryProfile(cfg.profileId)) {
        try {
          setStatus(cfg.profileId, 'closed');
        } catch {
          // ignore
        }
      }

      // Temporary profile cleanup: purge ephemeral directory on exit and unregister
      if (cfg.temporary || isTemporaryProfile(cfg.profileId)) {
        void cleanTemporaryDirectory(cfg.userDataDir).catch(() => {});
        unregisterTemporaryProfile(cfg.profileId);
      }
    });
    return toResult(rec);
  } catch (err) {
    cleanup({ pid: child.pid, port: '', wsPuppeteer: '', wsSelenium: '', process: child, tunnel });
    throw err;
  }
}

/**
 * Stop a profile: graceful close first (Chromium flushes cookies/sessions to
 * disk on clean shutdown), wait for the process to exit, force-kill as fallback.
 */
export async function stopProfile(profileId: string): Promise<boolean> {
  const rec = running.get(profileId);
  if (!rec) return false;
  try {
    const b = await puppeteer.connect({ browserWSEndpoint: rec.wsPuppeteer, defaultViewport: null });
    await b.close().catch(() => undefined);
  } catch {
    // already dead — the exit handler cleaned up
  }
  // Wait for the exit handler to run (up to 5s).
  await new Promise<void>((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (!running.has(profileId) || Date.now() - t0 > 5000) {
        clearInterval(iv);
        resolve();
      }
    }, 150);
  });
  // Still alive? Force-kill the tree.
  if (running.has(profileId)) {
    try {
      cleanup(rec);
    } catch (e) {
      console.error(`[launcher] Force-kill failed for profile ${profileId}:`, e);
    }
    running.delete(profileId);
  }
  return true;
}

/**
 * Stop every running profile.
 *
 * Profiles are stopped CONCURRENTLY, and that is the point rather than an optimisation. Each
 * `stopProfile` waits up to five seconds for its browser to exit, and the shell bounds its whole
 * exit path at five seconds (`sidecar.rs` graceful wait). Sequentially, two open profiles could
 * spend ten seconds stopping — past the shell's bound — so the backend was killed mid-stop and
 * the remaining profiles were left running. That is the reported defect: quitting from the tray
 * left profiles open. Stopping them together keeps the total inside one wait.
 *
 * A profile that cannot be stopped is reported in `failed` instead of being thrown away, so the
 * caller can say which one it was. The tree is force-killed first so a `failed` entry means the
 * kill itself failed, not that the browser was slow.
 */
export async function stopAll(): Promise<{ stopped: string[]; failed: string[] }> {
  const ids = Array.from(running.keys());
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        await stopProfile(id);
        return { id, ok: !running.has(id) };
      } catch (err) {
        console.error(`[launcher] Failed to stop profile ${id}:`, err);
        const rec = running.get(id);
        if (rec) {
          try {
            cleanup(rec);
          } catch {
            // the original error is the one worth reporting
          }
          running.delete(id);
        }
        return { id, ok: false };
      }
    }),
  );
  return {
    stopped: results.filter((r) => r.ok).map((r) => r.id),
    failed: results.filter((r) => !r.ok).map((r) => r.id),
  };
}

async function waitForDevToolsPort(userDataDir: string): Promise<{ port: string; wsPath: string }> {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length >= 2) {
        return { port: lines[0].trim(), wsPath: lines[1].trim() };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timed out waiting for DevToolsActivePort (is a Chromium binary available?)');
}
