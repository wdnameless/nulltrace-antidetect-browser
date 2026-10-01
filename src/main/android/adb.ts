import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn } from 'child_process';
import { logger } from '../util/logger';

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
  private async exec(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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

      proc.on('close', (code) => {
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
   * Polls `getprop sys.boot_completed` until `1` or deadline passes.
   * On timeout, rejects with the elapsed time in milliseconds included in the message.
   */
  async waitForBoot(opts?: {
    timeoutMs?: number;
    pollMs?: number;
    onWait?: (elapsedMs: number, timeoutMs: number) => void;
  }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const pollMs = opts?.pollMs ?? 1_000;
    const startTime = Date.now();
    // A cold guest boot is minutes of silence; without a heartbeat the operator cannot tell a
    // slow boot from a hang, so the wait reports itself every 10 s.
    let lastReport = 0;

    while (true) {
      try {
        const result = await this.shell(['getprop', 'sys.boot_completed']);
        if (result === '1') {
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
   */
  async install(apkPath: string): Promise<void> {
    const { stdout, stderr, exitCode } = await this.exec(['install', apkPath]);
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

    return { console: consolePort, adb: adbPort };
  }

  // Search standard Android emulator console port pairs (5554 through 5584)
  for (let port = 5554; port <= 5584; port += 2) {
    const [consoleFree, adbFree] = await Promise.all([isPortFree(port), isPortFree(port + 1)]);
    if (consoleFree && adbFree) {
      return { console: port, adb: port + 1 };
    }
  }

  throw new AdbError(
    'No free emulator port pairs found in standard range 5554-5585',
    'ERR_ANDROID_NO_FREE_PORTS'
  );
}
