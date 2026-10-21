/**
 * Fixtures for guest-network tests.
 *
 * The production probe is `shellCode` (it reports the exit code instead of throwing), because
 * "which tun2socks" and "test -x" answering non-zero is the normal case on a stock image, not an
 * error. These helpers model that contract without repeating it in every test.
 */
import type { AdbClient } from '../../src/main/android/adb';

export interface ProbeOutcome {
  /** Exit code for a probe (`which`, `test`); 0 means found. */
  exitCode?: number;
  /** stdout for a probe. */
  stdout?: string;
}

/**
 * AdbClient double whose `shellCode` answers a per-argument probe table and whose `shell`
 * records every call, throwing only where a test explicitly wants a failure.
 *
 * `root` defaults to refusal: most fixtures model a guest where the daemon will not elevate,
 * which is also the case the identity injector must degrade from rather than crash on.
 */
export function fakeAdb(opts: {
  probes?: (args: string[]) => ProbeOutcome | undefined;
  onShell?: (args: string[]) => string | undefined;
  pushes?: Array<[string, string]>;
  root?: { ok: boolean; message: string };
  /** Staged file writes (`writeFile`); the default answers success. */
  onWriteFile?: (remotePath: string, content: Buffer) => { exitCode: number; stderr?: string };
}): AdbClient {
  const fake = {
    root: async () => opts.root ?? { ok: false, message: 'adbd cannot run as root in production builds' },
    shell: async (args: string[]) => {
      if (opts.onShell) {
        const result = opts.onShell(args);
        if (result !== undefined) return result;
      }
      return '';
    },
    shellCode: async (args: string[]) => {
      const outcome = opts.probes?.(args) ?? {};
      return {
        stdout: outcome.stdout ?? '',
        stderr: '',
        exitCode: outcome.exitCode ?? 1,
      };
    },
    push: async (localPath: string, remotePath: string) => {
      opts.pushes?.push([localPath, remotePath]);
    },
    writeFile: async (remotePath: string, content: Buffer) => {
      const outcome = opts.onWriteFile?.(remotePath, content) ?? { exitCode: 0 };
      return { stderr: outcome.stderr ?? '', exitCode: outcome.exitCode };
    },
  };
  return fake as unknown as AdbClient;
}
