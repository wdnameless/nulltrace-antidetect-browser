import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { DATA_DIR } from '../config';

export type AndroidHostPlatform = 'windows' | 'macos' | 'linux';
export type HypervisorBackend = 'whpx' | 'aehd' | 'hvf' | 'kvm';

export interface AndroidPlatform {
  host: AndroidHostPlatform;
  /** Guest ABI the system image must use. Apple Silicon -> arm64-v8a, everything else -> x86_64. */
  abi: 'x86_64' | 'arm64-v8a';
  /** Backends the resolver will accept, best first. */
  backends: HypervisorBackend[];
  /** Path (relative to the android engine dir) of the emulator executable. */
  emulatorSubpath: string;
}

export type AndroidPlatformErrorCode =
  | 'ERR_ANDROID_UNSUPPORTED_HOST'
  | 'ERR_ANDROID_NO_HYPERVISOR'
  | 'ERR_ANDROID_HYPERVISOR_NOT_READY';

export class AndroidPlatformError extends Error {
  constructor(message: string, public readonly code: AndroidPlatformErrorCode) {
    super(message);
    this.name = 'AndroidPlatformError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Pure resolver mapping the host operating system and CPU architecture to a concrete Android
 * engine execution plan.
 *
 * An unaccelerated emulator cannot deliver interactive frame rates for streaming or headless
 * automation, so the resolver intentionally restricts guest ABIs to match native hardware:
 * Apple Silicon hosts run native ARM64 guest system images under Apple's Hypervisor Framework (HVF),
 * whereas x86_64 Windows and Linux hosts run x86_64 guest images under WHPX/AEHD or KVM respectively.
 * Performing this resolution purely without disk or network I/O allows deterministic unit testing
 * and upfront validation before downloading multi-gigabyte assets.
 */
export function resolveAndroidPlatform(
  opts?: { platform?: NodeJS.Platform; arch?: string }
): AndroidPlatform {
  const hostPlatform = opts?.platform ?? process.platform;
  const hostArch = opts?.arch ?? process.arch;

  if (hostPlatform === 'win32') {
    return {
      host: 'windows',
      abi: 'x86_64',
      backends: ['whpx', 'aehd'],
      emulatorSubpath: path.join('emulator', 'emulator.exe'),
    };
  }

  if (hostPlatform === 'darwin') {
    return {
      host: 'macos',
      abi: hostArch === 'arm64' ? 'arm64-v8a' : 'x86_64',
      backends: ['hvf'],
      emulatorSubpath: path.join('emulator', 'emulator'),
    };
  }

  if (hostPlatform === 'linux') {
    return {
      host: 'linux',
      abi: 'x86_64',
      backends: ['kvm'],
      emulatorSubpath: path.join('emulator', 'emulator'),
    };
  }

  throw new AndroidPlatformError(
    `Unsupported host platform: ${hostPlatform}`,
    'ERR_ANDROID_UNSUPPORTED_HOST'
  );
}

// Named probe commands kept as explicit constants so hypervisor readiness checks remain
// easily greppable and auditable across the codebase.
export const WINDOWS_WHPX_PROBE_CMD = 'powershell.exe';
export const WINDOWS_WHPX_PROBE_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform',
];

export const WINDOWS_AEHD_PROBE_CMD = 'sc.exe';
export const WINDOWS_AEHD_PROBE_ARGS = ['query', 'aehd'];
export const WINDOWS_GVM_PROBE_ARGS = ['query', 'gvm'];

export const MACOS_HV_PROBE_CMD = 'sysctl';
export const MACOS_HV_PROBE_ARGS = ['-n', 'kern.hv_support'];

export const LINUX_KVM_DEVICE = '/dev/kvm';

/**
 * Probes whether the host machine provides active hardware virtualization acceleration.
 *
 * Running an Android virtual machine without hardware virtualization is too slow to be usable.
 * Rather than silently falling back to a software CPU interpreter or letting QEMU crash cryptically
 * on startup, this probe inspects the real host facilities:
 * - Windows: Verifies that Windows Hypervisor Platform (WHPX) is Enabled, or that the Android
 *   Emulator Hypervisor Driver (AEHD/GVM) kernel service is installed.
 * - macOS: Verifies that `sysctl kern.hv_support` equals 1.
 * - Linux: Verifies that `/dev/kvm` exists and is accessible for both reading and writing.
 *
 * If no supported hypervisor is found, throws `ERR_ANDROID_NO_HYPERVISOR` with concrete, actionable
 * instructions naming the exact command or driver the operator needs to enable.
 */
export function probeEmulatorAcceleration(dataDir: string): boolean {
  const candidates = [
    path.join(dataDir, 'android', 'emulator', 'emulator.exe'),
    path.join(dataDir, 'android', 'emulator', 'emulator'),
  ];
  for (const exe of candidates) {
    try {
      if (!fs.existsSync(exe)) continue;
      const res = spawnSync(exe, ['-accel-check'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
      // Both the success sentence and the `accel: 0` code mean the host can accelerate; the
      // sentence is checked first because a broken backend still prints `accel:` with a number.
      if (/is installed and usable|is installed and working/i.test(text)) return true;
      if (/^\s*accel:\s*0\s*$/m.test(text)) return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

export async function assertHypervisorReady(p: AndroidPlatform): Promise<void> {
  if (p.host === 'windows') {
    let whpxEnabled = false;
    try {
      const res = spawnSync(WINDOWS_WHPX_PROBE_CMD, WINDOWS_WHPX_PROBE_ARGS, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      if (res.stdout && /State\s*:\s*Enabled/i.test(res.stdout)) {
        whpxEnabled = true;
      }
    } catch {
      // Probe invocation failure falls through to secondary AEHD driver check.
    }

    if (whpxEnabled) {
      return;
    }

    let aehdInstalled = false;
    try {
      const aehdRes = spawnSync(WINDOWS_AEHD_PROBE_CMD, WINDOWS_AEHD_PROBE_ARGS, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      if (aehdRes.status === 0 && aehdRes.stdout && /STATE/i.test(aehdRes.stdout)) {
        aehdInstalled = true;
      }
    } catch {
      // Fall through to legacy GVM check.
    }

    if (!aehdInstalled) {
      try {
        const gvmRes = spawnSync(WINDOWS_AEHD_PROBE_CMD, WINDOWS_GVM_PROBE_ARGS, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000,
        });
        if (gvmRes.status === 0 && gvmRes.stdout && /STATE/i.test(gvmRes.stdout)) {
          aehdInstalled = true;
        }
      } catch {
        // Fall through to error.
      }
    }

    if (aehdInstalled) {
      return;
    }

    // The emulator itself is the authority on acceleration, and both probes above can miss a
    // working host: a localized Windows answers `State` in another language, a locked-down shell
    // may not be allowed to invoke DISM, and WHPX can be present through the Hyper-V feature
    // rather than `HypervisorPlatform`. Measured on this machine: `emulator -accel-check` reports
    // "WHPX(10.0.26200) is installed and usable" while the PowerShell probe is refused — and the
    // app then refused to launch with a red "HypervisorPlatform is not enabled" banner on a host
    // that boots Android perfectly. Ask the binary before refusing.
    if (probeEmulatorAcceleration(DATA_DIR)) {
      return;
    }

    throw new AndroidPlatformError(
      'Windows Hypervisor Platform is not enabled and AEHD driver is not installed. ' +
      'Enable HypervisorPlatform by running in elevated PowerShell: ' +
      'Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform ' +
      '(or install the Android Emulator Hypervisor Driver for AMD/Intel processors).',
      'ERR_ANDROID_NO_HYPERVISOR'
    );
  }

  if (p.host === 'macos') {
    let supported = false;
    try {
      const res = spawnSync(MACOS_HV_PROBE_CMD, MACOS_HV_PROBE_ARGS, {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (res.stdout && res.stdout.trim() === '1') {
        supported = true;
      }
    } catch {
      // Fall through to error.
    }

    if (!supported) {
      throw new AndroidPlatformError(
        'Apple Hypervisor framework is not supported or enabled (sysctl kern.hv_support != 1). ' +
        'Hardware virtualization support is required on macOS.',
        'ERR_ANDROID_NO_HYPERVISOR'
      );
    }
    return;
  }

  if (p.host === 'linux') {
    let kvmReady = false;
    try {
      if (fs.existsSync(LINUX_KVM_DEVICE)) {
        fs.accessSync(LINUX_KVM_DEVICE, fs.constants.R_OK | fs.constants.W_OK);
        kvmReady = true;
      }
    } catch {
      // Fall through to error.
    }

    if (!kvmReady) {
      throw new AndroidPlatformError(
        'Linux KVM acceleration is not available at /dev/kvm or is not readable/writable. ' +
        'Ensure virtualization is enabled in BIOS/UEFI, the kvm kernel module is loaded (e.g. modprobe kvm_intel or modprobe kvm_amd), ' +
        'and add your user to the kvm group: sudo usermod -aG kvm $USER',
        'ERR_ANDROID_NO_HYPERVISOR'
      );
    }
    return;
  }

  throw new AndroidPlatformError(
    `Unsupported host platform: ${p.host}`,
    'ERR_ANDROID_UNSUPPORTED_HOST'
  );
}
