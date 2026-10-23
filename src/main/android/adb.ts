import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import { logger } from '../util/logger';

/**
 * Upper bound for a single adb invocation. A guest that is mid-boot can leave `adb shell`
 * blocked; the caller must still get control back so its own deadline can fire.
 */
const ADB_TIMEOUT_MS = 20_000;

/**
 * Custom error class for Android Debug Bridge and emulator port allocation failures.
 * Carries a machine-readable error code and optional stderr output from ADB.
 */
export class AdbError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly stderr?: string
  ) {
    super(message);
    this.name = 'AdbError';
  }
}

/**
 * Runs an adb command with `content` on its stdin and returns only what the caller needs to judge
 * success. Used for streaming a file into the guest without shell quoting.
 */
function pipeToAdb(
  adbPath: string,
  serial: string,
  args: string[],
  content: Buffer,
): Promise<{ stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(adbPath, ['-s', serial, ...args], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stderr, exitCode: code ?? 0 }));
    proc.stdin?.end(content);
  });
}

/**
 * Checks whether a specific TCP port is currently free to bind on 127.0.0.1.
 */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Acquires a free ephemeral TCP port by binding to port 0 on loopback,
 * inspecting the allocated port number, and closing the server.
 */
async function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => {
      reject(new AdbError(`Failed to probe free port: ${err.message}`, 'ERR_ANDROID_PORT_PROBE_FAILED'));
    });
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => {
          reject(new AdbError('Probe server failed to yield a valid address', 'ERR_ANDROID_PORT_PROBE_FAILED'));
        });
        return;
      }
      const port = addr.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(new AdbError(`Probe server close failed: ${closeErr.message}`, 'ERR_ANDROID_PORT_PROBE_FAILED'));
        } else {
          resolve(port);
        }
      });
    });
  });
}

/**
 * Thin, honest wrapper over the ADB binary using `spawn`.
 * Avoids shell string interpolation by always passing argument arrays directly to ADB.
 */
export class AdbClient {
  public readonly adbPath: string;
  public readonly serial: string;

  constructor(adbPath: string, serial: string) {
    this.adbPath = adbPath;
    this.serial = serial;
  }

  /**
   * Internal spawn runner. Spawns adb with target serial flag [-s, <serial>, ...args].
   * Rejects immediately if the adb executable cannot be spawned.
   */
  private async exec(
    args: string[],
    opts?: { timeoutMs?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const fullArgs = ['-s', this.serial, ...args];
      let proc;
      try {
        proc = spawn(this.adbPath, fullArgs, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(
          new AdbError(
            `Failed to spawn ADB binary at "${this.adbPath}": ${(err as Error).message}`,
            'ERR_ANDROID_ADB_SPAWN'
          )
        );
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on('error', (err) => {
        reject(
          new AdbError(
            `ADB process error (${this.serial}): ${err.message}`,
            'ERR_ANDROID_ADB_SPAWN'
          )
        );
      });

      // Every adb call is bounded. A stuck `adb shell` (adb server wedged, guest unresponsive
      // mid-boot) otherwise never returns, and the caller's own deadline never gets a chance to
      // fire: the boot wait blocks forever instead of timing out, which is exactly how a 300 s
      // deadline turns into a hang with no log line.
      const timeoutMs = opts?.timeoutMs ?? ADB_TIMEOUT_MS;
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Already gone.
        }
        reject(
          new AdbError(
            `adb ${args.join(' ')} on ${this.serial} did not finish within ${timeoutMs}ms`,
            'ERR_ANDROID_ADB_TIMEOUT'
          )
        );
      }, timeoutMs);
      timer.unref?.();

      proc.on('close', (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        });
      });
    });
  }

  /**
   * Runs `adb -s <serial> exec-out <args>` and returns RAW stdout bytes.
   *
   * `exec()` decodes stdout as utf-8, which corrupts binary payloads (a PNG from
   * `exec-out screencap -p` loses bytes at the decode/encode round-trip). This twin
   * keeps the Buffer. Stderr is still text for the error message.
   */
  async execOut(args: string[], opts?: { timeoutMs?: number }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fullArgs = ['-s', this.serial, 'exec-out', ...args];
      let proc;
      try {
        proc = spawn(this.adbPath, fullArgs, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(
          new AdbError(
            `Failed to spawn ADB binary at "${this.adbPath}": ${(err as Error).message}`,
            'ERR_ANDROID_ADB_SPAWN',
          ),
        );
      }
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout?.on('data', (c: Buffer) => outChunks.push(c));
      proc.stderr?.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('error', (err) => {
        reject(new AdbError(`ADB process error (${this.serial}): ${err.message}`, 'ERR_ANDROID_ADB_SPAWN'));
      });
      const timeoutMs = opts?.timeoutMs ?? ADB_TIMEOUT_MS;
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* already gone */ }
        reject(new AdbError(
          `adb exec-out ${args.join(' ')} on ${this.serial} did not finish within ${timeoutMs}ms`,
          'ERR_ANDROID_ADB_TIMEOUT',
        ));
      }, timeoutMs);
      timer.unref?.();
      proc.on('close', (code) => {
        clearTimeout(timer);
        if ((code ?? 0) !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf-8');
          reject(new AdbError(
            `adb exec-out ${args.join(' ')} failed on ${this.serial} (exit code ${code}): ${stderr.trim()}`,
            'ERR_ANDROID_ADB_EXEC_OUT',
            stderr,
          ));
          return;
        }
        resolve(Buffer.concat(outChunks));
      });
    });
  }
  /**
   * Asks adbd to restart as root: `adb -s <serial> root`.
   *
   * This is a HOST-side adb verb, not a guest shell command — `adb shell root` lands in the
   * guest's `/system/bin/sh`, which has no such binary (exit 127, "root: inaccessible or not
   * found"), and that failure is what silently downgraded every identity/network step.
   *
   * Returns the daemon's answer; the caller waits for adbd to come back before using it.
   */
  async root(): Promise<{ ok: boolean; message: string }> {
    const { stdout, stderr, exitCode } = await this.exec(['root']);
    const message = (stdout.trim() || stderr.trim()).replace(/\r/g, '');
    // A locked production image answers "adbd cannot run as root in production builds" and
    // still exits 0 in some versions, so the text decides, not the code alone.
    const ok = exitCode === 0 && !/cannot run as root/i.test(message);
    return { ok, message };
  }

  /**
   * Runs `adb -s <serial> shell <args>` and reports the exit code instead of throwing on it,
   * for probes whose whole question is "did this succeed" (`test -x`, `which`, `getprop`).
   * Only spawn-level failures reject.
   */
  async shellCode(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.exec(['shell', ...args]);
  }

  /**
   * Writes bytes to a guest file by piping them into `adb shell cat > path`.
   *
   * The payload travels as process stdin, never as part of a shell command string: a heredoc,
   * base64 or a quoted multi-line argument is re-parsed by the device shell and mangles the
   * content (measured: a staged `.prop` ended up 0 bytes).
   */
  async writeFile(remotePath: string, content: Buffer): Promise<{ stderr: string; exitCode: number }> {
    try {
      return await pipeToAdb(this.adbPath, this.serial, ['shell', `cat > ${remotePath}`], content);
    } catch (err) {
      return { stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
    }
  }

  /**
   * Runs `adb -s <serial> shell <args>`, returns trimmed stdout; throws on non-zero exit.
   */
  async shell(args: string[]): Promise<string> {
    const { stdout, stderr, exitCode } = await this.exec(['shell', ...args]);
    if (exitCode !== 0) {
      throw new AdbError(
        `adb shell ${args.join(' ')} failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_SHELL',
        stderr
      );
    }
    return stdout.trim();
  }

  /**
   * Pushes a local file to the guest filesystem: `adb -s <serial> push <localPath> <remotePath>`.
   */
  async push(localPath: string, remotePath: string): Promise<void> {
    const { stdout, stderr, exitCode } = await this.exec(['push', localPath, remotePath]);
    if (exitCode !== 0) {
      throw new AdbError(
        `adb push from "${localPath}" to "${remotePath}" failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_PUSH',
        stderr
      );
    }
  }

  /**
   * Sets up port forwarding: `adb -s <serial> forward tcp:<local> <remote>`.
   * When localPort is omitted, dynamically allocates a free port on 127.0.0.1 and returns it.
   */
  async forward(remote: string, localPort?: number): Promise<number> {
    const chosenPort = localPort ?? (await probeFreePort());
    const remoteTarget = remote.includes(':') ? remote : `tcp:${remote}`;
    const { stdout, stderr, exitCode } = await this.exec(['forward', `tcp:${chosenPort}`, remoteTarget]);

    if (exitCode !== 0) {
      throw new AdbError(
        `adb forward tcp:${chosenPort} ${remoteTarget} failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_FORWARD',
        stderr
      );
    }

    return chosenPort;
  }

  /**
   * Maps a guest abstract socket onto a host TCP port: `adb -s <serial> reverse <remote> tcp:<port>`.
   *
   * This is the direction scrcpy needs when the server runs with `tunnel_forward=false`: the
   * guest dials `localabstract:scrcpy` and adb delivers that connection to the host listener.
   */
  async reverse(remote: string, localPort: number): Promise<void> {
    const remoteTarget = remote.includes(':') ? remote : `localabstract:${remote}`;
    const { stdout, stderr, exitCode } = await this.exec(['reverse', remoteTarget, `tcp:${localPort}`]);

    if (exitCode !== 0) {
      throw new AdbError(
        `adb reverse ${remoteTarget} tcp:${localPort} failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_REVERSE',
        stderr
      );
    }
  }

  /** Removes a reverse mapping: `adb -s <serial> reverse --remove <remote>`. */
  async removeReverse(remote: string): Promise<void> {
    const remoteTarget = remote.includes(':') ? remote : `localabstract:${remote}`;
    const { stdout, stderr, exitCode } = await this.exec(['reverse', '--remove', remoteTarget]);

    if (exitCode !== 0) {
      throw new AdbError(
        `adb reverse --remove ${remoteTarget} failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_REVERSE_REMOVE',
        stderr
      );
    }
  }

  /**
   * Removes a forwarded local TCP port: `adb -s <serial> forward --remove tcp:<localPort>`.
   */
  async removeForward(localPort: number): Promise<void> {
    const { stdout, stderr, exitCode } = await this.exec(['forward', '--remove', `tcp:${localPort}`]);
    if (exitCode !== 0) {
      throw new AdbError(
        `adb forward --remove tcp:${localPort} failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_FORWARD_REMOVE',
        stderr
      );
    }
  }

  /**
   * Waits until the device is no longer reachable over adb, which is what a reboot looks like from
   * the host. A transport that survives the reboot keeps answering `getprop` from the old boot, so
   * callers must observe the gap before waiting for `sys.boot_completed` again.
   *
   * Resolves when the device drops (or after the deadline), never rejects: the caller's next step
   * is the boot wait, which is the authoritative check.
   */
  async waitForDisconnect(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.exec(['get-state'], { timeoutMs: 5_000 });
      const answer = `${state.stdout}${state.stderr}`;
      if (state.exitCode !== 0 || !/^device\b/m.test(answer.trim())) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * Polls `getprop sys.boot_completed` until `1` or deadline passes.
   * On timeout, rejects with the elapsed time in milliseconds included in the message.
   */
  async waitForBoot(opts?: {
    timeoutMs?: number;
    pollMs?: number;
    onWait?: (elapsedMs: number, timeoutMs: number) => void;
    /**
     * Cancels the wait from outside. `Promise.race` does not cancel the losing arm, so a race
     * against "the emulator process exited" would otherwise leave this loop polling adb forever —
     * keeping the process alive and hiding the real failure behind a hang.
     */
    signal?: AbortSignal;
  }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollMs = opts?.pollMs ?? 1_000;
    const startTime = Date.now();
    // A cold guest boot is minutes of silence; without a heartbeat the operator cannot tell a
    // slow boot from a hang, so the wait reports itself every 10 s.
    let lastReport = 0;

    while (true) {
      if (opts?.signal?.aborted) {
        throw new AdbError(`Boot wait for ${this.serial} was cancelled`, 'ERR_ANDROID_BOOT_CANCELLED');
      }
      try {
        // Bounded per poll: an adb server holding a stale transport (offline guest, half-dead
        // adbd) can leave `shell` blocked indefinitely, and an unbounded call is what turned the
        // boot deadline into a hang. A timeout here just means "not ready yet" — the elapsed
        // check below is what ends the wait.
        const poll = await this.exec(['shell', 'getprop', 'sys.boot_completed'], {
          timeoutMs: 5_000,
        });
        // After a restart the previous transport can keep answering for a while; a poll that exits
        // non-zero is the device being absent, not a booted guest answering "". Requiring exit 0
        // and the value `1` is what distinguishes the two.
        if (poll.exitCode === 0 && poll.stdout.trim() === '1') {
          logger.info(`[ADB] Emulator ${this.serial} boot completed in ${Date.now() - startTime}ms`);
          return;
        }
      } catch {
        // Device may be offline or booting during initial attempts; continue polling
      }

      const elapsed = Date.now() - startTime;
      if (elapsed - lastReport >= 10_000) {
        lastReport = elapsed;
        logger.info(
          `[ADB] Emulator ${this.serial} still booting (${Math.round(elapsed / 1000)}s of ${Math.round(timeoutMs / 1000)}s)`
        );
        opts?.onWait?.(elapsed, timeoutMs);
      }
      if (elapsed >= timeoutMs) {
        throw new AdbError(
          `Android emulator (${this.serial}) failed to boot after ${elapsed}ms (timeout: ${timeoutMs}ms)`,
          'ERR_ANDROID_BOOT_TIMEOUT'
        );
      }

      const remaining = timeoutMs - elapsed;
      const waitTime = Math.min(pollMs, remaining);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Installs an APK onto the target device: `adb -s <serial> install <apkPath>`.
   *
   * The timeout is generous on purpose: pushing + dexopting a real-world APK takes minutes
   * (measured: TikTok 477 MB installs in ~2-4 min on this AVD), and the default 20 s budget
   * would kill every large install mid-push.
   */
  async install(apkPath: string, opts?: { timeoutMs?: number }): Promise<void> {
    const { stdout, stderr, exitCode } = await this.exec(['install', apkPath], {
      timeoutMs: opts?.timeoutMs ?? 600_000,
    });
    if (exitCode !== 0) {
      throw new AdbError(
        `adb install "${apkPath}" failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_INSTALL',
        stderr
      );
    }
  }

  /**
   * Sends emulator kill command: `adb -s <serial> emu kill`.
   */
  async kill(): Promise<void> {
    const { stdout, stderr, exitCode } = await this.exec(['emu', 'kill']);
    if (exitCode !== 0) {
      throw new AdbError(
        `adb emu kill failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_KILL',
        stderr
      );
    }
  }

  /**
   * Sends arbitrary emulator console commands: `adb -s <serial> emu <args>`.
   */
  async emu(args: string[]): Promise<string> {
    const { stdout, stderr, exitCode } = await this.exec(['emu', ...args]);
    if (exitCode !== 0) {
      throw new AdbError(
        `adb emu ${args.join(' ')} failed on ${this.serial} (exit code ${exitCode}): ${stderr.trim() || stdout.trim()}`,
        'ERR_ANDROID_ADB_EMU',
        stderr
      );
    }
    return stdout.trim();
  }
}

/**
 * Returns platform-aware candidate paths for the ADB binary within the engine directory
 * and validates existence, throwing a clear error naming the missing paths if not found.
 */
export function resolveAdbPath(engineDir: string): string {
  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'adb.exe' : 'adb';

  const candidatePaths = [
    path.join(engineDir, 'platform-tools', exeName),
    path.join(engineDir, exeName),
    path.join(engineDir, 'bin', exeName),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  throw new AdbError(
    `ADB binary not found in engine directory "${engineDir}". Checked candidate paths:\n` +
      candidatePaths.map((p) => `  - ${p}`).join('\n'),
    'ERR_ANDROID_ADB_NOT_FOUND'
  );
}

/**
 * Console ports this process has handed out and not yet released. `isPortFree` alone cannot
 * prevent two concurrent starts from picking the same pair: between the probe and the spawn
 * both callers see the ports as free. The registry closes that race inside this process; the
 * probe still guards against ports taken by foreign processes.
 */
const claimedConsolePorts = new Set<number>();

/** Releases a console port previously handed out by `allocateEmulatorPorts`. Idempotent. */
export function releaseEmulatorPorts(consolePort: number): void {
  claimedConsolePorts.delete(consolePort);
}

/**
 * Allocates a paired set of ports { console, adb } for an Android emulator instance.
 * ADB port is always console + 1.
 * If preferred port is specified, asserts that both preferred and preferred+1 are free,
 * throwing ERR_ANDROID_PORT_OCCUPIED on collision.
 * If preferred is omitted, checks standard Android emulator console port pairs (5554..5584).
 */
export async function allocateEmulatorPorts(
  preferred?: number
): Promise<{ console: number; adb: number }> {
  if (preferred !== undefined) {
    const consolePort = preferred;
    const adbPort = preferred + 1;
    const [consoleFree, adbFree] = await Promise.all([isPortFree(consolePort), isPortFree(adbPort)]);

    if (!consoleFree || !adbFree) {
      const occupied =
        !consoleFree && !adbFree
          ? `${consolePort} and ${adbPort}`
          : !consoleFree
            ? `${consolePort}`
            : `${adbPort}`;
      throw new AdbError(
        `Preferred emulator port ${consolePort} collides with occupied port (${occupied})`,
        'ERR_ANDROID_PORT_OCCUPIED'
      );
    }

    claimedConsolePorts.add(consolePort);
    return { console: consolePort, adb: adbPort };
  }

  // Search standard Android emulator console port pairs (5554 through 5584). Claimed ports
  // are skipped without probing: they belong to a sibling instance that has not bound yet.
  for (let port = 5554; port <= 5584; port += 2) {
    if (claimedConsolePorts.has(port)) continue;
    const [consoleFree, adbFree] = await Promise.all([isPortFree(port), isPortFree(port + 1)]);
    if (consoleFree && adbFree) {
      claimedConsolePorts.add(port);
      return { console: port, adb: port + 1 };
    }
  }

  throw new AdbError(
    'No free emulator port pairs found in standard range 5554-5585',
    'ERR_ANDROID_NO_FREE_PORTS'
  );
}
