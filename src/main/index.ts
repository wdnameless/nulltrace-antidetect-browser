import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { initDb, closeDb, flushDb } from './db';
import { startApi } from './api/server';
import { getApiKey, API_HOST, API_PORT, DATA_DIR } from './config';
import { seedDevices } from './devices/deviceManager';
import { recoverStaleRunning, purgeExpiredTrash } from './profiles/profileManager';
import { startupPurgeSweep, shutdownCleanup } from './profiles/temporaryRegistry';
import { stopAll, startProfile, stopProfile, isRunning } from './launcher/chromium';
import { shutdownAllAndroid } from './android/instance';
import { stopAllSessions } from './syncer/actionSyncer';
import { startScheduler, stopScheduler, onProfileStatusChanged } from './scripts/triggerScheduler';
import { stopAllWorkers } from './scripts/scriptEngine';
import { getTaskQueueCoordinator } from './scripts/taskQueue';
import { getTaskGroup } from './scripts/taskGroups';
import { onProfileStatusChange, getProfile, listProfiles, resolveLaunchConfig } from './profiles/profileManager';
import {
  getTelegramBotInstance,
  resetTelegramBotInstance,
  notifyProfileStarted,
  notifyProfileStopped,
  notifyTaskGroupFinished,
  notifyAgentActivity,
} from './telegram/bot';
import { onAgentActivity } from './agentActivity';
import { logger, initLogger, flushLogs } from './util/logger';
import { McpService } from './mcpService';
import { startSyncEngine, stopSyncEngine, requestSync } from './cloud/gdriveSync';

// ---------------------------------------------------------------------------
// Single-instance lock: two service instances would race on the DB file.
// ---------------------------------------------------------------------------
export const LOCK_FILE = path.join(DATA_DIR, 'service.lock');

/**
 * Raised when the instance lock is held by a process we cannot displace.
 *
 * Distinct from other lock failures (an unreadable file, a missing directory): those must
 * never stop startup, while this one must. It exists because a plain string check once let
 * the refusal fall through and the service went on to die obscurely on a busy port.
 */
export class InstanceLockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceLockHeldError';
  }
}
export interface ProcessInspectorOptions {
  execFileSync?: (file: string, args: string[], options?: child_process.ExecFileSyncOptions) => string | Buffer;
}

let defaultExecFileSync = child_process.execFileSync;

/** The injectable probe signature; helpers take this rather than the overloaded original. */
type ExecRunner = NonNullable<ProcessInspectorOptions['execFileSync']>;

export function setProcessInspectorExec(fn: typeof child_process.execFileSync | undefined): void {
  defaultExecFileSync = fn || child_process.execFileSync;
}

/**
 * Inspects the process command line / image name.
 * Allows 'Antidetect Browser.exe' or 'node' running our service/entry script.
 * Returns true (our app), false (a different image), or undefined when the
 * probe failed entirely (no probe available, access denied, ...).
 * A definite false lets the caller treat the lock as stale; an undefined must
 * be handled conservatively by callers (never remove a lock they can't verify).
 *
 * Windows probe order, and why it is this order:
 *   1. `tasklist` — always present, ~40ms, and answers "does this pid still exist"
 *      with its image name. On Windows 11 / Server 2025 `wmic` has been REMOVED
 *      from the OS, and PowerShell's `Get-CimInstance` takes ~2.8s on a cold
 *      start. The previous code tried `wmic` first and fell back to a 2000ms
 *      PowerShell call, so on those systems the probe timed out and returned
 *      `undefined` for a LIVE pid. Callers fail closed on `undefined`, so the
 *      service refused to start and left the app with a dead backend.
 *   2. `powershell Get-CimInstance` — only for the command line, when tasklist
 *      confirmed the pid exists but reported an image we do not recognise.
 */
export function isProcessOurApp(
  pid: number,
  options?: ProcessInspectorOptions
): boolean | undefined {
  const runner = options?.execFileSync || defaultExecFileSync;
  try {
    if (process.platform === 'win32') {
      const imageName = winImageName(runner, pid);
      if (imageName !== undefined) {
        // The pid is gone: nothing holds the lock.
        if (imageName === null) return false;
        if (imageName.includes('antidetect')) return true;
        // A recognisable, non-ours image is a definite "not us" without needing the
        // command line at all — and `node.exe` is ambiguous because every Node tool
        // on the machine shares that image name, so it must fall through.
        if (imageName !== 'node.exe') return false;
      }

      const cmdLine = winCommandLine(runner, pid);
      if (cmdLine === undefined) return undefined; // probe failed entirely
      const normalized = cmdLine.toLowerCase();

      // KEEP: Instance-lock executable name match for single-instance enforcement.
      if (normalized.includes('antidetect browser.exe') || normalized.includes('antidetect browser')) {
        return true;
      }
      // Node running our service or entry point
      // KEEP: Instance-lock process check for antidetect node instances.
      if (
        normalized.includes('node') &&
        (normalized.includes('antidetect') ||
          normalized.includes('src\\main') ||
          normalized.includes('dist/src/main') ||
          normalized.includes('dist\\src\\main'))
      ) {
        return true;
      }
      // The command line WAS read and it is not ours: that is a definite "not our app",
      // which lets the caller reclaim a recycled pid. Only a failed read is unknown.
      return false;
    } else {
      // POSIX fallback: the command line via `ps`.
      //
      // This goes through `runner` like the Windows branch, and that is a fix rather than a
      // tidy-up: it used to call `child_process.execFileSync` DIRECTLY, so the injected probe was
      // bypassed on every non-Windows host. The consequence was not academic — the whole POSIX path
      // was untestable, so it was untested: the suite could only exercise `isProcessOurApp` on
      // Windows, and a bug here would have shipped invisibly on macOS and Linux. Routing through
      // the seam makes the branch reachable from a test on any platform.
      //
      // Note also that `runner` is honoured the same way in both branches, so a test that injects
      // one probe exercises the logic the running platform will actually execute.
      try {
        const raw = runner('ps', ['-p', String(pid), '-o', 'args='], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        const args = String(raw).toLowerCase();
        if (!args.trim()) return false;
        // KEEP: POSIX instance-lock process check for antidetect.
        if (args.includes('antidetect')) return true;
        if (args.includes('node') && (args.includes('main') || args.includes('service'))) return true;
      } catch {
        return undefined; // ps probe failed
      }
      return false;
    }
  } catch {
    return undefined;
  }
}

/**
 * Windows image name for `pid` via `tasklist`.
 * Returns the lowercased image (e.g. `node.exe`), `null` when no such pid exists,
 * or `undefined` when tasklist itself could not be run.
 */
function winImageName(runner: ExecRunner, pid: number): string | null | undefined {
  try {
    const raw = runner('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const out = typeof raw === 'string' ? raw : raw ? raw.toString('utf8') : '';
    // tasklist reports a miss as "INFO: No tasks are running which match the criteria."
    if (/no tasks are running/i.test(out)) return null;
    // CSV: "node.exe","1234","Console","1","50,388 K"
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return undefined;
  }
}

/**
 * Windows command line for `pid`, or `undefined` when it could not be read.
 * `wmic` is tried first because it is far faster where it still exists; the
 * PowerShell fallback needs a generous timeout, since a cold CIM start was
 * measured at ~2.8s and a 2000ms budget timed out on healthy systems.
 */
function winCommandLine(runner: ExecRunner, pid: number): string | undefined {
  try {
    const raw = runner('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const out = typeof raw === 'string' ? raw : raw ? raw.toString('utf8') : '';
    if (out.trim()) return out;
  } catch {
    // wmic is absent on Windows 11 / Server 2025; fall through to PowerShell.
  }
  try {
    const raw = runner(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
      ],
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const out = typeof raw === 'string' ? raw : raw ? raw.toString('utf8') : '';
    return out.trim() ? out : undefined;
  } catch {
    return undefined;
  }
}

export function acquireInstanceLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      const stalePid = Number(raw);
      let isRunningApp = false;
      if (Number.isFinite(stalePid) && stalePid > 0 && stalePid !== process.pid) {
        let alive: boolean;
        try {
          process.kill(stalePid, 0); // signal 0 = liveness probe
          alive = true;
        } catch (err) {
          // EPERM: the process EXISTS but runs at higher privilege. Treating
          // it as dead lets a second instance start over it and its debounced
          // persist can then overwrite our database file.
          alive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }

        if (alive) {
          const probed = isProcessOurApp(stalePid);
          if (probed === undefined) {
            // The pid is alive but we cannot verify its image (no probe available, access
            // denied). Removing the lock here risks two services writing one database —
            // fail closed, but LOUDLY: this stops the launch so the shell can show why.
            const msg = `Another process (pid ${stalePid}) holds the instance lock and its image could not be verified. Close it first or remove ${LOCK_FILE} manually.`;
            logger.warn('instance lock held by unverifiable process', { stalePid });
            throw new InstanceLockHeldError(msg);
          }
          isRunningApp = probed;
        }
      }

      if (isRunningApp) {
        const msg = `Another instance is already running (pid ${stalePid}). Close it first.`;
        logger.warn('instance lock held by our own app', { stalePid });
        throw new InstanceLockHeldError(msg);
      }

      // Stale lock: pid dead, own pid, recycled pid of another image, or an
      // unreadable/corrupt lock file. (An alive-but-unverifiable pid throws above.)
      logger.warn('stale instance lock removed', { stalePid, ownPid: process.pid });
      fs.rmSync(LOCK_FILE, { force: true });
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  } catch (err) {
    // A lock we are not allowed to take must STOP the launch, never be swallowed.
    //
    // This used to be a bare `catch` that only rethrew when the message contained
    // "already running" — the unrelated string. Every other refusal (an unverifiable
    // holder, our own app still running) was logged and then ignored, so the service
    // carried on and died later at `listen()` on the busy port. The result was a
    // running UI with no backend at all: "failed to fetch" and dead menus, with the
    // real reason only in a log file.
    if (err instanceof InstanceLockHeldError) throw err;
    // Anything else (missing file, permissions) must still not block startup.
    logger.warn('instance lock warning', { error: (err as Error).message });
    console.error('[antidetect] instance lock warning:', (err as Error).message);
  }
}

export function releaseInstanceLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      if (raw === String(process.pid)) fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown: stop browsers, flush DB, release the lock, exit.
// ---------------------------------------------------------------------------
let shuttingDown = false;

export async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown', { reason });
  console.log(`[antidetect] ${reason} received — shutting down...`);
  try {
    // The count matters: the shell bounds its exit path, so a profile that would not stop is
    // exactly the case where a browser is left running. Naming it turns a silent leak into a
    // line the operator can act on.
    const { stopped, failed } = await stopAll();
    if (failed.length > 0) {
      logger.error('shutdown: profiles that could not be stopped', { reason, failed });
      console.error(
        `[antidetect] ${failed.length} profile(s) could not be stopped and were force-killed: ${failed.join(', ')}`,
      );
    }
    logger.info('shutdown: profiles stopped', { reason, stopped: stopped.length, failed: failed.length });
  } catch (err) {
    logger.error('shutdown: stopAll threw', { reason, error: (err as Error).message });
  }
  try {
    await shutdownCleanup();
  } catch {
    // ignore
  }
  try {
    await shutdownAllAndroid();
  } catch (err) {
    logger.error('shutdown: android instances not stopped', { reason, error: (err as Error).message });
  }
  try {
    await stopAllSessions();
  } catch {
    // ignore
  }
  try {
    const mcp = McpService.getInstance();
    if (mcp.status().running) {
      await mcp.stop();
    }
  } catch {
    // ignore
  }
  try {
    stopScheduler();
    stopAllWorkers();
  } catch {
    // ignore
  }
  try {
    resetTelegramBotInstance();
  } catch {
    // ignore
  }
  try {
    await requestSync('exit');
    stopSyncEngine();
  } catch {
    // ignore
  }
  try {
    flushDb();
    closeDb();
  } catch {
    // ignore
  }
  flushLogs();
  releaseInstanceLock();
  process.exit(code);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Telegram bot wiring (umbrella 2.8): construct the singleton, bind command
// handlers, subscribe to profile status changes and task-group completion.
// All helpers no-op when the bot is disabled (no token / enabled flag).
// ---------------------------------------------------------------------------
const PROFILE_LIST_CAP = 20;

/** Wire the telegram singleton, command handlers and event hooks (exported for integration tests). */
export function wireTelegramBot(): void {
  const bot = getTelegramBotInstance();

  // Fix defect 1: start polling from the boot path whenever the bot is enabled.
  // startPolling() is idempotent (returns early if already polling).
  if (bot.isEnabled()) {
    bot.startPolling();
  }

  bot.setCommandHandlers({
    start: async (id) => {
      if (!id) return 'Usage: /start <profile id>';
      try {
        const profile = getProfile(id);
        if (profile?.browser_type === 'android') {
          return 'This profile uses Android — start it from the app, not via Telegram.';
        }
        const cfg = resolveLaunchConfig(id);
        if (cfg.browserType === 'firefox') {
          return 'This profile uses Firefox (Camoufox) — start it from the app, not via Telegram.';
        }
        const result = await startProfile(cfg);
        return result && result.pid ? `Profile ${id} started (pid ${result.pid}).` : `Profile ${id} start failed.`;
      } catch (err) {
        return `Profile ${id} start failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    stop: async (id) => {
      if (!id) return 'Usage: /stop <profile id>';
      try {
        await stopProfile(id);
        return `Profile ${id} stopped.`;
      } catch (err) {
        return `Profile ${id} stop failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    status: async () => {
      // The handler contract passes no id: report live + stored state globally.
      const page = listProfiles(1, PROFILE_LIST_CAP);
      const running = page.list.filter((p) => isRunning(p.user_id));
      const storedRunning = page.list.filter((p) => !isRunning(p.user_id) && p.status === 'running');
      const closed = page.list.length - running.length - storedRunning.length;
      let text = `Profiles: ${page.total} total\nRunning: ${running.length}\nClosed: ${closed}`;
      if (storedRunning.length > 0) {
        text += `\nStale "running" ${storedRunning.length} (crash recovery will close them)`;
      }
      return text;
    },
    list: async () => {
      const page = listProfiles(1, PROFILE_LIST_CAP);
      const rows = page.list.map((p) => `• ${p.name || p.user_id} — ${isRunning(p.user_id) ? 'running' : 'closed'}`);
      const omitted = page.total - rows.length;
      let text = rows.length ? rows.join('\n') : 'No profiles.';
      if (omitted > 0) text += `\n… and ${omitted} more omitted.`;
      return text;
    },
  });

  // Profile status notifications (second subscription beside the scheduler's).
  onProfileStatusChange((profileId, status) => {
    const name = getProfile(profileId)?.name ?? undefined;
    if (status === 'running') {
      notifyProfileStarted(profileId, name);
    } else if (status === 'closed' || status === 'error') {
      notifyProfileStopped(profileId, name);
    }
  });

  // Task-group completion notifications: the coordinator's 'group-finished'
  // event is fired from its tick; nobody else subscribes today.
  getTaskQueueCoordinator().on('group-finished', (groupId, finalStatus) => {
    const group = typeof groupId === 'string' || typeof groupId === 'number' ? getTaskGroup(String(groupId)) : undefined;
    notifyTaskGroupFinished(groupId, String(finalStatus), group?.name);
  });

  // Agent activity forwarding: only forward events originated by 'agent'
  onAgentActivity((event) => {
    if (event.source === 'agent') {
      notifyAgentActivity(event.summary);
    }
  });
}
export async function startMcpWithService(): Promise<{ started: boolean; error?: string }> {
  try {
    const service = McpService.getInstance();
    if (service.status().running) {
      return { started: true };
    }
    // `start()` either returns a running status or throws with the reason, so the failure path
    // is the catch below rather than a flag on the returned value.
    const status = await service.start();
    if (status.running) {
      logger.info('MCP server autostart succeeded', {
        tools: status.toolCount,
        url: status.httpUrl,
      });
      return { started: true };
    }
    const reason = 'MCP server did not report itself running after start';
    logger.warn('MCP server autostart failed', { reason });
    return { started: false, error: reason };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('MCP server autostart failed', { reason });
    return { started: false, error: reason };
  }
}


export async function startService(): Promise<void> {
  initLogger();
  logger.info('service starting', { pid: process.pid, dataDir: DATA_DIR, port: API_PORT });
  acquireInstanceLock();
  await initDb();
  startSyncEngine();
  seedDevices();

  // Crash recovery: profiles stuck in "running" from a previous session.
  const recovered = recoverStaleRunning();
  if (recovered > 0) {
    logger.warn('crash recovery applied', { recovered });
    console.log(`[antidetect] crash recovery: ${recovered} stale running profile(s) marked closed`);
  }

  // NOTE: orphaned on-disk profile dirs (no DB row) are deliberately NOT
  // re-registered. Silent auto-adoption created "Recovered profile" rows the
  // operator never asked for; the dirs stay on disk untouched.

  // Trash sweep (Sprint 2.4): permanently delete soft-deleted profiles older
  // than 30 days on every service start.
  const purged = purgeExpiredTrash();
  if (purged > 0) {
    logger.info('trash purge applied', { purged });
    console.log(`[antidetect] trash purge: ${purged} profile(s) older than 30 days removed`);
  }

  // Disposable profiles sweep: purge orphaned temporary profiles from prior sessions.
  try {
    const tempPurged = await startupPurgeSweep();
    if (tempPurged.purged.length > 0) {
      logger.info('temporary profiles startup sweep applied', { count: tempPurged.purged.length });
      console.log(`[antidetect] temporary profiles sweep: ${tempPurged.purged.length} orphaned dir(s) removed`);
    }
  } catch (err) {
    logger.warn('temporary profiles startup sweep failed', { error: String(err) });
  }

  // Script triggers (Sprint 4.3): scheduler tick + event hooks on status changes.
  startScheduler();
  onProfileStatusChange(onProfileStatusChanged);

  // Telegram bot (umbrella 2.8): construct singleton, bind commands and hooks.
  wireTelegramBot();

  await startApi();
  logger.info('service ready', { apiKey: getApiKey() });
  console.log(`[antidetect] ready. API key: ${getApiKey()}`);
  console.log(`[antidetect] try: curl http://${API_HOST}:${API_PORT}/status`);

  // Start MCP server with service (R07)
  await startMcpWithService();
}

// Allow running the backend standalone (without Electron): `npm run service`
if (require.main === module) {
  startService().catch((err) => {
    console.error('[antidetect] fatal', err);
    process.exit(1);
  });
}
