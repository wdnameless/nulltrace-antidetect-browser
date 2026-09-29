import * as fs from 'fs';
import { deriveHardwareVector } from '../fingerprints/derivation';
import { resolveFontConfig } from '../fingerprints/fonts';
import * as path from 'path';
import {
  deriveSubSeeds,
  getSyntheticVoicePool,
  getSyntheticMediaDevices,
  resolveSensorConfig,
  SubSeeds,
  SyntheticMediaDevice,
  SyntheticVoice,
} from './stealthNoise';
import { signStealthExtension } from '../security/extensionVerifier';
import type { KeyPairPem } from '../security/signing';

export type LogicalPlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export interface StealthOptions {
  mobile: boolean;
  logicalPlatform: LogicalPlatform;
  ua?: string;
  model?: string;
  platformVersion?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  maxTouchPoints?: number;
  seed?: number;
  locale?: string;
  canvasNoise?: boolean;
  audioNoise?: boolean;
  rectsNoise?: boolean;
  webglNoise?: boolean;
  webglVendor?: string;
  webglRenderer?: string;
  chip?: string;
  architecture?: string;
  fontList?: string[];
  /**
   * Surfaces the KERNEL already spoofs natively for this launch.
   *
   * Measured reason this exists: our own probe compared the main thread against a Worker and
   * found the page reporting `deviceMemory 8` while the worker reported `16`, and two different
   * canvas hashes for one claimed device (1457566783 vs 3616719147). The cause was duplication,
   * not a missing worker hook — the kernel already spoofed both surfaces, consistently in both
   * contexts, and the JavaScript layer overwrote them on the main thread only. An antifraud
   * script does not need to know which value is "right": the disagreement itself is the signal.
   *
   * With the kernel's canvas the hash is already unique per profile AND identical across
   * contexts (measured across four seeds), so the JavaScript noise adds nothing but divergence.
   * When the launcher runs a stock binary the kernel covers nothing and this stays falsy, which
   * is why the JavaScript path is retained rather than deleted.
   */
  engineCovers?: { canvas?: boolean; deviceMemory?: boolean; clientHints?: boolean; webgl?: boolean };
  webgpu?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
    disabled?: boolean;
    limitsClass?: 'high-end' | 'mid-range' | 'integrated' | 'budget';
  } | null;
  webauthnPlatformAuthenticator?: boolean;
}

const BRANDS = [
  { brand: 'Google Chrome', version: '148' },
  { brand: 'Chromium', version: '148' },
  { brand: 'Not=A?Brand', version: '24' },
];

const FULL_VERSION_LIST = [
  { brand: 'Google Chrome', version: '148.0.7712.0' },
  { brand: 'Chromium', version: '148.0.7712.0' },
  { brand: 'Not=A?Brand', version: '24.0.0.0' },
];

function uaPlatform(lp: LogicalPlatform): string {
  switch (lp) {
    case 'windows': return 'Windows';
    case 'macos': return 'macOS';
    case 'linux': return 'Linux';
    case 'android': return 'Android';
    case 'ios': return 'iOS';
  }
}

function navPlatform(lp: LogicalPlatform): string {
  switch (lp) {
    case 'windows': return 'Win32';
    case 'macos': return 'MacIntel';
    case 'linux': return 'Linux x86_64';
    case 'android': return 'Linux armv81';
    case 'ios': return 'iPhone';
  }
}

function defaultPlatformVersion(lp: LogicalPlatform): string {
  switch (lp) {
    case 'windows': return '15.0.0';
    case 'macos': return '14.5.0';
    case 'linux': return '6.5.0';
    case 'android': return '14.0.0';
    case 'ios': return '17.5.0';
  }
}

/**
 * Default device model reported to Client Hints for a platform that has one.
 *
 * Extracted from a nested ternary that read `android ? 'Pixel 8' : ios ? 'iPhone' : ''`, which is
 * parsed right-to-left and invites the reader to conclude the empty string applies to every
 * non-Apple platform. Desktop platforms genuinely have no model, so '' is correct for them.
 */
function defaultModelFor(lp: LogicalPlatform): string {
  switch (lp) {
    case 'android': return 'Pixel 8';
    case 'ios': return 'iPhone';
    default: return '';
  }
}

function getArchitecture(lp: LogicalPlatform, chip?: string, forcedArch?: string): string {
  if (forcedArch) return forcedArch;
  if (lp === 'macos') {
    return chip === 'Intel' ? 'x86' : 'arm';
  }
  switch (lp) {
    case 'android':
    case 'ios':
      return 'arm';
    default:
      return 'x86';
  }
}
export interface WebGpuInterimConfig {
  disabled?: boolean;
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  features?: string[];
  limits?: Record<string, number>;
}

export function resolveWebGpuConfig(opts: StealthOptions): WebGpuInterimConfig | null {
  if (opts.webgpu?.disabled) {
    return { disabled: true };
  }
  if (opts.webgpu) {
    const defaultLimits = {
      maxTextureDimension1D: 8192,
      maxTextureDimension2D: 8192,
      maxTextureDimension3D: 2048,
      maxTextureArrayLayers: 256,
      maxBindGroups: 4,
      maxDynamicUniformBuffersPerPipelineLayout: 8,
      maxDynamicStorageBuffersPerPipelineLayout: 4,
      maxSampledTexturesPerShaderStage: 16,
      maxSamplersPerShaderStage: 16,
      maxStorageBuffersPerShaderStage: 8,
      maxStorageTexturesPerShaderStage: 4,
      maxUniformBuffersPerShaderStage: 12,
      maxUniformBufferBindingSize: 65536,
      maxStorageBufferBindingSize: 134217728,
      minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256,
      maxVertexBuffers: 8,
      maxBufferSize: 268435456,
      maxVertexAttributes: 16,
      maxVertexBufferArrayStride: 2048,
      maxInterStageShaderVariables: 16,
      maxColorAttachments: 8,
      maxColorAttachmentBytesPerSample: 32,
      maxComputeWorkgroupStorageSize: 16384,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeWorkgroupSizeZ: 64,
      maxComputeWorkgroupsPerDimension: 65535,
    };
    return {
      disabled: false,
      vendor: opts.webgpu.vendor ?? 'intel',
      architecture: opts.webgpu.architecture ?? 'gen-12',
      device: opts.webgpu.device ?? 'Intel Iris Xe Graphics',
      description: opts.webgpu.description ?? opts.webgpu.device ?? 'Intel Iris Xe Graphics',
      features: [
        'depth-clip-control',
        'depth32float-stencil8',
        'texture-compression-bc',
        'indirect-first-instance',
        'rg11b10ufloat-renderable',
        'bgra8unorm-storage',
        'float32-filterable',
      ],
      limits: defaultLimits,
    };
  }

  const lp = opts.logicalPlatform;
  const renderer = opts.webglRenderer ?? '';
  const rLower = renderer.toLowerCase();

  // Linux headless / no-gpu families -> resolve undefined (no adapter)
  if (lp === 'linux' && (rLower.includes('llvmpipe') || rLower.includes('software') || rLower.includes('swiftshader') || rLower.includes('mesa offscreen') || !renderer)) {
    return null;
  }

  let vendor = 'intel';
  let architecture = 'gen-12';
  let device = 'Intel UHD Graphics';
  let description = renderer || 'Intel Graphics';

  if (lp === 'macos') {
    vendor = 'apple';
    if (rLower.includes('m1 pro') || rLower.includes('m1 max') || rLower.includes('m1 ultra')) {
      architecture = 'apple-m1-pro';
      device = 'Apple M1 Pro';
    } else if (rLower.includes('m1')) {
      architecture = 'apple-m1';
      device = 'Apple M1';
    } else if (rLower.includes('m2 pro') || rLower.includes('m2 max') || rLower.includes('m2 ultra')) {
      architecture = 'apple-m2-pro';
      device = 'Apple M2 Pro';
    } else if (rLower.includes('m2')) {
      architecture = 'apple-m2';
      device = 'Apple M2';
    } else if (rLower.includes('m3')) {
      architecture = 'apple-m3';
      device = 'Apple M3';
    } else if (rLower.includes('m4')) {
      architecture = 'apple-m4';
      device = 'Apple M4';
    } else if (rLower.includes('intel') || rLower.includes('iris')) {
      vendor = 'intel';
      architecture = 'gen-9';
      device = 'Intel Iris Plus Graphics 655';
    } else {
      architecture = 'apple-m2';
      device = 'Apple M2';
    }
    description = device;
  } else if (rLower.includes('nvidia') || rLower.includes('geforce') || rLower.includes('rtx') || rLower.includes('gtx')) {
    vendor = 'nvidia';
    if (rLower.includes('4090') || rLower.includes('4080') || rLower.includes('4070') || rLower.includes('4060')) {
      architecture = 'ada-lovelace';
      device = rLower.includes('4070') ? 'NVIDIA GeForce RTX 4070' : 'NVIDIA GeForce RTX 4060';
    } else if (rLower.includes('3080') || rLower.includes('3070') || rLower.includes('3060')) {
      architecture = 'ampere';
      device = 'NVIDIA GeForce RTX 3060';
    } else if (rLower.includes('1650') || rLower.includes('1660') || rLower.includes('2060')) {
      architecture = 'turing';
      device = 'NVIDIA GeForce GTX 1650';
    } else {
      architecture = 'ampere';
      device = 'NVIDIA GeForce RTX 3060';
    }
    description = device;
  } else if (rLower.includes('amd') || rLower.includes('radeon')) {
    vendor = 'amd';
    if (rLower.includes('7800') || rLower.includes('7900') || rLower.includes('780m')) {
      architecture = 'rdna-3';
      device = rLower.includes('7800') ? 'AMD Radeon RX 7800 XT' : 'AMD Radeon 780M';
    } else if (rLower.includes('6700') || rLower.includes('6800') || rLower.includes('6600') || rLower.includes('680m')) {
      architecture = 'rdna-2';
      device = rLower.includes('6700') ? 'AMD Radeon RX 6700 XT' : 'AMD Radeon RX 6600';
    } else {
      architecture = 'rdna-2';
      device = 'AMD Radeon RX 6600';
    }
    description = device;
  } else if (rLower.includes('qualcomm') || rLower.includes('adreno')) {
    vendor = 'qualcomm';
    architecture = 'adreno-x1';
    device = 'Qualcomm(R) Adreno(TM) X1-85 GPU';
    description = device;
  } else if (rLower.includes('arc') || rLower.includes('a770') || rLower.includes('a370')) {
    vendor = 'intel';
    architecture = 'alchemist';
    device = rLower.includes('a770') ? 'Intel(R) Arc(TM) A770 Graphics' : 'Intel(R) Arc(TM) Graphics';
    description = device;
  } else if (rLower.includes('iris')) {
    vendor = 'intel';
    architecture = 'gen-12';
    device = 'Intel(R) Iris(R) Xe Graphics';
    description = device;
  } else if (rLower.includes('uhd')) {
    vendor = 'intel';
    if (rLower.includes('770') || rLower.includes('730')) {
      architecture = 'gen-12';
      device = rLower.includes('770') ? 'Intel(R) UHD Graphics 770' : 'Intel(R) UHD Graphics 730';
    } else {
      architecture = 'gen-9';
      device = 'Intel(R) UHD Graphics 620';
    }
    description = device;
  }

  const defaultLimits = {
    maxTextureDimension1D: 8192,
    maxTextureDimension2D: 8192,
    maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 256,
    maxBindGroups: 4,
    maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 4,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16,
    maxStorageBuffersPerShaderStage: 8,
    maxStorageTexturesPerShaderStage: 4,
    maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536,
    maxStorageBufferBindingSize: 134217728,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    maxVertexBuffers: 8,
    maxBufferSize: 268435456,
    maxVertexAttributes: 16,
    maxVertexBufferArrayStride: 2048,
    maxInterStageShaderVariables: 16,
    maxColorAttachments: 8,
    maxColorAttachmentBytesPerSample: 32,
    maxComputeWorkgroupStorageSize: 16384,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535,
  };

  return {
    disabled: false,
    vendor,
    architecture,
    device,
    description,
    features: [
      'depth-clip-control',
      'depth32float-stencil8',
      'texture-compression-bc',
      'indirect-first-instance',
      'rg11b10ufloat-renderable',
      'bgra8unorm-storage',
      'float32-filterable',
    ],
    limits: defaultLimits,
  };
}

export function resolveWebAuthnPlatformAuthenticator(opts: StealthOptions): boolean {
  if (typeof opts.webauthnPlatformAuthenticator === 'boolean') {
    return opts.webauthnPlatformAuthenticator;
  }
  const lp = opts.logicalPlatform;
  if (lp === 'macos') {
    // Apple Silicon macs have Touch ID platform authenticator; older Intel macs usually don't
    const chip = (opts.chip ?? '').toLowerCase();
    const rLower = (opts.webglRenderer ?? '').toLowerCase();
    if (chip.startsWith('m') || rLower.includes('apple m')) {
      return true;
    }
    return false;
  }
  if (lp === 'windows') {
    // Windows Hello: modern Win11 / Win10 often true, older windows families false
    const pv = opts.platformVersion ?? '';
    const majorVer = parseInt(pv.split('.')[0] || '0', 10);
    // platformVersion '15.0.0' or higher corresponds to Windows 11
    if (majorVer >= 15) {
      return true;
    }
    return false;
  }
  // Linux typically does not have built-in platform authenticators
  return false;
}

export function buildStealthScript(opts: StealthOptions): string {
  const masterSeed = opts.seed ?? 12345;
  const subSeeds: SubSeeds = deriveSubSeeds(masterSeed);
  const voices: SyntheticVoice[] = getSyntheticVoicePool(opts.logicalPlatform, opts.locale ?? 'en-US');
  const mediaDevices: SyntheticMediaDevice[] = getSyntheticMediaDevices(masterSeed, opts.mobile);
  const hwVector = opts.logicalPlatform === 'windows' ? deriveHardwareVector(masterSeed) : null;
  const webgpuCfg = resolveWebGpuConfig(opts);
  const webauthnPlatformAuth = resolveWebAuthnPlatformAuthenticator(opts);
  const fontCfg = resolveFontConfig(opts);
  const sensorCfg = resolveSensorConfig(opts);
  const cfg = {
    mobile: opts.mobile,
    logicalPlatform: opts.logicalPlatform,
    locale: opts.locale ?? (hwVector ? hwVector.locale : 'en-US'),
    uaPlatform: uaPlatform(opts.logicalPlatform),
    navPlatform: navPlatform(opts.logicalPlatform),
    platformVersion: opts.platformVersion ?? (hwVector ? hwVector.platformVersion : defaultPlatformVersion(opts.logicalPlatform)),
    architecture: getArchitecture(opts.logicalPlatform, opts.chip, opts.architecture),
    bitness: '64',
    // Flattened from a nested ternary: `android ? 'Pixel 8' : ios ? 'iPhone' : ''` is read
    // right-to-left and is easy to misread as assigning '' to everything non-Apple.
    model: opts.model ?? defaultModelFor(opts.logicalPlatform),
    brands: BRANDS,
    fullVersionList: FULL_VERSION_LIST,
    hardwareConcurrency: opts.hardwareConcurrency ?? (hwVector ? hwVector.cpuCores : null),
    deviceMemory: opts.deviceMemory ?? (hwVector ? hwVector.ramGB : null),
    maxTouchPoints: opts.maxTouchPoints ?? null,
    canvasNoise: opts.canvasNoise ?? true,
    // Whether the kernel handles a surface natively for this launch. When it does, the JavaScript
    // layer stands down so the two cannot disagree (see StealthOptions.engineCovers).
    engineCoversCanvas: opts.engineCovers?.canvas ?? false,
    engineCoversDeviceMemory: opts.engineCovers?.deviceMemory ?? false,
    engineCoversClientHints: opts.engineCovers?.clientHints ?? false,
    engineCoversWebgl: opts.engineCovers?.webgl ?? false,
    audioNoise: opts.audioNoise ?? true,
    rectsNoise: opts.rectsNoise ?? true,
    webglNoise: opts.webglNoise ?? true,
    webglVendor: opts.webglVendor ?? (hwVector ? hwVector.gpuVendor : 'Google Inc. (NVIDIA)'),
    webglRenderer: opts.webglRenderer ?? (hwVector ? hwVector.gpuRenderer : 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    webgpu: webgpuCfg,
    webauthnPlatformAuth,
    fonts: fontCfg,
    sensors: sensorCfg,
    seeds: subSeeds,
    voices,
    mediaDevices,
  };
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const isMobile = CFG.mobile;

  // Tiny embedded PRNG (Mulberry32)
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --- Function.prototype.toString interception & Native function registry ---
  // TODO(engine-parity): Function.prototype.toString
  const origToString = Function.prototype.toString;
  const nativeFunctions = new WeakSet();
  const customNames = new WeakMap();

  function makeNative(fn, name, length) {
    if (typeof fn !== 'function') return fn;
    nativeFunctions.add(fn);
    if (name) {
      customNames.set(fn, name);
      try {
        Object.defineProperty(fn, 'name', {
          value: name,
          configurable: true,
          writable: false,
          enumerable: false,
        });
      } catch (e) {}
    }
    if (typeof length === 'number') {
      try {
        Object.defineProperty(fn, 'length', {
          value: length,
          configurable: true,
          writable: false,
          enumerable: false,
        });
      } catch (e) {}
    }
    return fn;
  }

  const customToString = function toString() {
    if (this === customToString) {
      return 'function toString() { [native code] }';
    }
    if (typeof this !== 'function') {
      return origToString.call(this);
    }
    if (nativeFunctions.has(this)) {
      const name = customNames.get(this) || this.name || '';
      return 'function ' + name + '() { [native code] }';
    }
    return origToString.call(this);
  };

  makeNative(customToString, 'toString', 0);

  try {
    Object.defineProperty(Function.prototype, 'toString', {
      value: customToString,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch (e) {}

  function hookMethod(target, prop, fn) {
    if (!target) return;
    try {
      const orig = target[prop];
      const origLength = (orig && typeof orig.length === 'number') ? orig.length : 0;
      makeNative(fn, prop, origLength);
      Object.defineProperty(target, prop, {
        value: fn,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch (e) {}
  }

  function hookGetter(target, prop, getter) {
    if (!target) return;
    try {
      makeNative(getter, 'get ' + prop, 0);
      Object.defineProperty(target, prop, {
        get: getter,
        configurable: true,
        enumerable: true,
      });
    } catch (e) {}
  }

  // --- Client Hints: full navigator.userAgentData ---
  // TODO(engine-parity): Navigator.prototype.userAgentData
  const getHighEntropyValuesFn = makeNative(async function getHighEntropyValues(hints) {
    return {
      brands: CFG.brands,
      mobile: isMobile,
      platform: CFG.uaPlatform,
      platformVersion: CFG.platformVersion,
      architecture: CFG.architecture,
      bitness: CFG.bitness,
      wow64: false,
      model: CFG.model,
      fullVersionList: CFG.fullVersionList,
      formFactors: isMobile ? ['mobile'] : ['desktop'],
    };
  }, 'getHighEntropyValues', 1);

  const toJSONFn = makeNative(function toJSON() {
    return { brands: CFG.brands, mobile: isMobile, platform: CFG.uaPlatform };
  }, 'toJSON', 0);

  const uaData = {
    brands: CFG.brands,
    mobile: isMobile,
    platform: CFG.uaPlatform,
    platformVersion: CFG.platformVersion,
    architecture: CFG.architecture,
    bitness: CFG.bitness,
    wow64: false,
    model: CFG.model,
    fullVersionList: CFG.fullVersionList,
    formFactors: isMobile ? ['mobile'] : ['desktop'],
    getHighEntropyValues: getHighEntropyValuesFn,
    toJSON: toJSONFn,
  };

  // Same stand-down as canvas and deviceMemory, for the same measured reason.
  //
  // The kernel fills every SYNC Client Hints field identically on the page and inside a worker
  // (measured: with NT_NO_EXT=1 the two contexts agree; the JS layer is what introduced the gap).
  // This hook then overwrote the page's object with values a worker never receives, because
  // Navigator inside a worker is a different object. Result: the page reported
  // {arch:arm,bits:64,pv:14.5.0} while the worker reported {} — one claimed device, two answers,
  // exactly the pattern the other stand-downs in this module were added for.
  //
  // getHighEntropyValues is left hooked: it is an async method the kernel also answers, but the JS
  // version is what the page's other surfaces were made consistent with. Kept when the kernel is
  // absent, where it is the only source of these values.
  if (typeof Navigator !== 'undefined' && !CFG.engineCoversClientHints) {
    hookGetter(Navigator.prototype, 'userAgentData', function () { return uaData; });
  }

  // --- Headless trace: window.chrome.runtime / webstore ---
  if (typeof window !== 'undefined' && window.chrome) {
    // TODO(engine-parity): window.chrome.runtime
    if (!window.chrome.runtime) {
      const noop = makeNative(function () {}, '', 0);
      const noopArrow = () => {};
      const evt = { addListener: noop, removeListener: noop, hasListener: makeNative(function () { return false; }, 'hasListener', 0) };
      const runtime = {
        id: undefined,
        OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
        connect: () => null,
        connectNative: () => null,
        getBackgroundPage: () => null,
        getManifest: () => ({}),
        getURL: (p) => p,
        reload: noopArrow,
        requestUpdateCheck: (cb) => { if (cb) cb('no_update'); },
        sendMessage: noopArrow,
        sendNativeMessage: noopArrow,
        setUninstallURL: noopArrow,
        onConnect: evt,
        onInstalled: evt,
        onMessage: evt,
        onMessageExternal: evt,
        onStartup: evt,
        onSuspend: evt,
        onSuspendCanceled: evt,
        onUpdateAvailable: evt,
      };
      try { Object.defineProperty(window.chrome, 'runtime', { configurable: true, value: runtime }); } catch (e) {}
    }
    // TODO(engine-parity): window.chrome.webstore
    if (!window.chrome.webstore) {
      const noop = makeNative(function () {}, '', 0);
      const noopArrow = () => {};
      const evt = { addListener: noop, removeListener: noop, hasListener: makeNative(function () { return false; }, 'hasListener', 0) };
      const webstore = {
        appPrivate: {
          beginInstallWithManifest: noopArrow,
          completeInstall: noopArrow,
          install: noopArrow,
          isInstalled: noopArrow,
          launch: noopArrow,
        },
        onInstallStageChanged: evt,
        onDownloadProgress: evt,
      };
      try { Object.defineProperty(window.chrome, 'webstore', { configurable: true, value: webstore }); } catch (e) {}
    }
  }

  // --- Platform consistency ---
  // TODO(engine-parity): Navigator.prototype.platform
  if (typeof Navigator !== 'undefined') {
    hookGetter(Navigator.prototype, 'platform', function () { return CFG.navPlatform; });
  }

  // --- Hardware signals ---
  if (typeof Navigator !== 'undefined') {
    // TODO(engine-parity): Navigator.prototype.hardwareConcurrency
    if (CFG.hardwareConcurrency !== null) {
      hookGetter(Navigator.prototype, 'hardwareConcurrency', function () { return CFG.hardwareConcurrency; });
    }

    // TODO(engine-parity): Navigator.prototype.deviceMemory
    //
    // Skipped when the kernel already spoofs it: there is no --fingerprint-device-memory switch
    // (measured — the kernel ignores one and picks 4/8/16/32/64 from the seed itself), so a value
    // chosen here can only ever DISAGREE with the engine on DESKTOP, where the engine's answer is
    // in range. Measured: 251 of 400 seeds (63%) get a ramGB that differs from the engine's.
    if (isMobile) {
      // On a phone the engine's answer is out of range, not merely different.
      //
      // Chromium clamps this per platform, in
      // third_party/blink/common/device_memory/approximated_device_memory.cc:
      //   float kMinMemory = 2.0f;  float kMaxMemory = 32.0f;   // desktop
      //   #if BUILDFLAG(IS_ANDROID)  kMinMemory = 1.0f;  kMaxMemory = 8.0f;  #endif
      // Our kernel is a DESKTOP build, so it happily reports 16 or 32 while claiming to be an
      // Android phone — a value no real Android Chrome can produce, readable in one line:
      //   navigator.deviceMemory <= 8 is guaranteed on Android.
      // The JS layer cannot make the WORKER agree (workers never see it), so on mobile the honest
      // options are a clamped page value or none; undefined is what a phone without the API
      // reports, and it is consistent in both contexts because the kernel does not fake it there.
      hookGetter(Navigator.prototype, 'deviceMemory', function () { return undefined; });
    } else if (CFG.deviceMemory !== null && !CFG.engineCoversDeviceMemory) {
      hookGetter(Navigator.prototype, 'deviceMemory', function () { return CFG.deviceMemory; });
    }

    // TODO(engine-parity): Navigator.prototype.maxTouchPoints
    if (CFG.maxTouchPoints !== null) {
      hookGetter(Navigator.prototype, 'maxTouchPoints', function () { return CFG.maxTouchPoints; });
    }
  }

  // --- Mobile-only consistency ---
  if (isMobile) {
    const empty = {
      length: 0,
      item: makeNative(function item() { return null; }, 'item', 1),
      namedItem: makeNative(function namedItem() { return null; }, 'namedItem', 1),
      [Symbol.iterator]: function* () {},
    };
    if (typeof Navigator !== 'undefined') {
      // TODO(engine-parity): Navigator.prototype.plugins
      hookGetter(Navigator.prototype, 'plugins', function () { return empty; });
      // TODO(engine-parity): Navigator.prototype.mimeTypes
      hookGetter(Navigator.prototype, 'mimeTypes', function () { return empty; });
    }
    if (typeof Screen !== 'undefined') {
      // TODO(engine-parity): Screen.prototype.orientation
      // TODO(engine-parity: sensors)
      const orient = (CFG.sensors && CFG.sensors.orientation)
        ? { type: CFG.sensors.orientation.type, angle: CFG.sensors.orientation.angle, onchange: null }
        : { type: 'portrait-primary', angle: 0, onchange: null };
      hookGetter(Screen.prototype, 'orientation', function () { return orient; });
    }
    // TODO(engine-parity): Navigator.prototype.connection
    //
    // REMOVED, on measurement, and the reasoning is the same one that removed the desktop copy.
    // The getter returned a fresh object per read — a probe reading it twice saw a NEW OBJECT EACH
    // READ, where a real NetworkInformation is a stable singleton. Worse, the value reached the
    // page only: a worker reads the host's real connection, so a page claiming a constant 10
    // against a worker reporting 1.3 is a 590% disagreement, where an unmodified browser shows
    // about 3% drift between the two contexts. Spoofing one context made the profile more
    // conspicuous than leaving the real value alone in both.

    // --- Mobile Motion & Orientation Sensors ---
    if (CFG.sensors) {
      // TODO(engine-parity: sensors)
      const sensorProfile = CFG.sensors;
      const g = sensorProfile.gravity;
      const jitterAmp = sensorProfile.jitterAmplitude || 0.05;

      // Periodic coherent sensor reading generator
      let readingStep = 0;
      const getReadings = function() {
        readingStep++;
        const jitter = Math.sin(readingStep) * jitterAmp;
        return {
          accel: { x: jitter * 0.1, y: jitter * 0.1, z: jitter * 0.1 },
          accelGravity: { x: g.x + jitter, y: g.y + jitter, z: g.z + jitter },
          rotRate: { alpha: jitter * 0.5, beta: jitter * 0.5, gamma: jitter * 0.5 },
          orientation: {
            alpha: (sensorProfile.orientation.angle + jitter * 2) % 360,
            beta: (g.y * 5 + jitter * 2),
            gamma: (g.x * 5 + jitter * 2),
            absolute: true,
          },
        };
      };

      // DeviceMotionEvent & DeviceOrientationEvent constructors and permission
      // TODO(engine-parity: sensors)
      if (typeof DeviceMotionEvent !== 'undefined') {
        if (typeof DeviceMotionEvent.requestPermission !== 'function') {
          try {
            DeviceMotionEvent.requestPermission = makeNative(function requestPermission() {
              return Promise.resolve('granted');
            }, 'requestPermission', 0);
          } catch {}
        }
      }

      // TODO(engine-parity: sensors)
      if (typeof DeviceOrientationEvent !== 'undefined') {
        if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
          try {
            DeviceOrientationEvent.requestPermission = makeNative(function requestPermission() {
              return Promise.resolve('granted');
            }, 'requestPermission', 0);
          } catch {}
        }
      }

      // Periodic event delivery for listeners
      // TODO(engine-parity: sensors)
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        const motionListeners = [];
        const orientListeners = [];

        const origAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = makeNative(function(type, listener, options) {
          if (this === window || this === globalThis) {
            if (type === 'devicemotion' && typeof listener === 'function') {
              motionListeners.push(listener);
            } else if (type === 'deviceorientation' && typeof listener === 'function') {
              orientListeners.push(listener);
            }
          }
          return origAddEventListener.call(this, type, listener, options);
        }, 'addEventListener', 2);

        setInterval(function() {
          if (motionListeners.length === 0 && orientListeners.length === 0) return;
          const readings = getReadings();
          if (motionListeners.length > 0) {
            const ev = {
              acceleration: readings.accel,
              accelerationIncludingGravity: readings.accelGravity,
              rotationRate: readings.rotRate,
              interval: 16,
              type: 'devicemotion',
            };
            for (let i = 0; i < motionListeners.length; i++) {
              try { motionListeners[i].call(window, ev); } catch {}
            }
          }
          if (orientListeners.length > 0) {
            const ev = {
              alpha: readings.orientation.alpha,
              beta: readings.orientation.beta,
              gamma: readings.orientation.gamma,
              absolute: readings.orientation.absolute,
              type: 'deviceorientation',
            };
            for (let i = 0; i < orientListeners.length; i++) {
              try { orientListeners[i].call(window, ev); } catch {}
            }
          }
        }, 100);
      }

      // Generic Sensor API family: Accelerometer, Gyroscope, Magnetometer, LinearAccelerationSensor, GravitySensor
      // TODO(engine-parity: sensors)
      const createSensorClass = function(name, readingExtractor) {
        const SensorBase = function(options) {
          this.activated = false;
          this.hasReading = false;
          this.timestamp = null;
          this._interval = (options && options.frequency) ? (1000 / options.frequency) : 60;
          this._timer = null;
          this.onreading = null;
          this.onerror = null;
          this.onactivate = null;
          this._listeners = { reading: [], error: [], activate: [] };
        };

        SensorBase.prototype.addEventListener = makeNative(function(type, listener) {
          if (this._listeners && this._listeners[type] && typeof listener === 'function') {
            this._listeners[type].push(listener);
          }
        }, 'addEventListener', 2);

        SensorBase.prototype.removeEventListener = makeNative(function(type, listener) {
          if (this._listeners && this._listeners[type]) {
            const idx = this._listeners[type].indexOf(listener);
            if (idx >= 0) this._listeners[type].splice(idx, 1);
          }
        }, 'removeEventListener', 2);

        SensorBase.prototype.start = makeNative(function() {
          if (this.activated) return;
          this.activated = true;
          if (typeof this.onactivate === 'function') {
            try { this.onactivate(); } catch {}
          }
          if (this._listeners && this._listeners.activate) {
            for (let i = 0; i < this._listeners.activate.length; i++) {
              try { this._listeners.activate[i].call(this); } catch {}
            }
          }
          const self = this;
          this._timer = setInterval(function() {
            if (!self.activated) return;
            const readings = getReadings();
            readingExtractor.call(self, readings);
            self.hasReading = true;
            self.timestamp = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            if (typeof self.onreading === 'function') {
              try { self.onreading(); } catch {}
            }
            if (self._listeners && self._listeners.reading) {
              for (let i = 0; i < self._listeners.reading.length; i++) {
                try { self._listeners.reading[i].call(self); } catch {}
              }
            }
          }, self._interval);
        }, 'start', 0);

        SensorBase.prototype.stop = makeNative(function() {
          this.activated = false;
          if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
          }
        }, 'stop', 0);

        return makeNative(SensorBase, name, 0);
      };

      // TODO(engine-parity: sensors)
      if (typeof globalThis.Accelerometer === 'undefined') {
        globalThis.Accelerometer = createSensorClass('Accelerometer', function(r) {
          this.x = r.accelGravity.x;
          this.y = r.accelGravity.y;
          this.z = r.accelGravity.z;
        });
      }

      // TODO(engine-parity: sensors)
      if (typeof globalThis.GravitySensor === 'undefined') {
        globalThis.GravitySensor = createSensorClass('GravitySensor', function(r) {
          this.x = r.accelGravity.x;
          this.y = r.accelGravity.y;
          this.z = r.accelGravity.z;
        });
      }

      // TODO(engine-parity: sensors)
      if (typeof globalThis.LinearAccelerationSensor === 'undefined') {
        globalThis.LinearAccelerationSensor = createSensorClass('LinearAccelerationSensor', function(r) {
          this.x = r.accel.x;
          this.y = r.accel.y;
          this.z = r.accel.z;
        });
      }

      // TODO(engine-parity: sensors)
      if (typeof globalThis.Gyroscope === 'undefined') {
        globalThis.Gyroscope = createSensorClass('Gyroscope', function(r) {
          this.x = r.rotRate.beta;
          this.y = r.rotRate.gamma;
          this.z = r.rotRate.alpha;
        });
      }

      // TODO(engine-parity: sensors)
      if (typeof globalThis.Magnetometer === 'undefined') {
        globalThis.Magnetometer = createSensorClass('Magnetometer', function() {
          this.x = 20.0;
          this.y = -10.0;
          this.z = 45.0;
        });
      }

      // navigator.permissions.query consistent with sensor constructors
      // TODO(engine-parity: sensors)
      if (typeof navigator !== 'undefined' && navigator.permissions && typeof navigator.permissions.query === 'function') {
        const origPermQuery = navigator.permissions.query;
        const sensorNames = { accelerometer: true, gyroscope: true, magnetometer: true };
        navigator.permissions.query = makeNative(function(desc) {
          if (desc && sensorNames[desc.name]) {
            return Promise.resolve({ state: 'granted', onchange: null });
          }
          return origPermQuery.call(this, desc);
        }, 'query', 1);
      }
    }
  }

  // --- Notification permission ---
  // TODO(engine-parity): Notification.permission
  if (typeof Notification !== 'undefined') {
    try {
      const realPerm = Object.getOwnPropertyDescriptor(Notification, 'permission');
      hookGetter(Notification, 'permission', function () {
        let v = 'default';
        try { v = realPerm && realPerm.get ? realPerm.get.call(Notification) : Notification.permission; } catch (e) {}
        return v === 'denied' ? 'default' : v;
      });
    } catch (e) {}
  }

  // --- permissions.query ---
  // TODO(engine-parity): navigator.permissions.query
  if (typeof navigator !== 'undefined' && navigator.permissions && navigator.permissions.query) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    hookMethod(navigator.permissions, 'query', function query(desc) {
      return origQuery(desc).then(function (status) {
        if (desc && desc.name === 'notifications' && status && status.state === 'denied') {
          try { hookGetter(status, 'state', function () { return 'prompt'; }); } catch (e) {}
        }
        return status;
      });
    });
  }

  // --- Chromium API presence ---
  // TODO(engine-parity): window.ContentIndex
  if (typeof window !== 'undefined' && !('ContentIndex' in window)) {
    class ContentIndex {
      add() { return Promise.resolve(); }
      delete() { return Promise.resolve(); }
      getAll() { return Promise.resolve([]); }
      getDescriptions() { return Promise.resolve([]); }
    }
    try { Object.defineProperty(window, 'ContentIndex', { configurable: true, value: ContentIndex }); } catch (e) {}
  }

  // TODO(engine-parity): window.ContactsManager
  if (typeof window !== 'undefined' && !('ContactsManager' in window)) {
    class ContactsManager {
      select() { return Promise.resolve([]); }
      getProperties() { return Promise.resolve({}); }
    }
    try { Object.defineProperty(window, 'ContactsManager', { configurable: true, value: ContactsManager }); } catch (e) {}
  }

  // TODO(engine-parity): NetworkInformation.prototype.downlinkMax
  if (typeof window !== 'undefined' && window.NetworkInformation && window.NetworkInformation.prototype) {
    const niProto = window.NetworkInformation.prototype;
    if (!('downlinkMax' in niProto)) {
      hookGetter(niProto, 'downlinkMax', function () { return 10; });
    }
  }

  // --- Canvas 2D Noise Injection ---
  //
  // Skipped when the kernel already spoofs canvas. Measured: with the kernel alone the hash is
  // unique per profile AND identical on the page and in a worker (four seeds produced four
  // distinct hashes, each stable across contexts). Layering this noise on top changed only the
  // MAIN thread, because these prototypes are document-scoped and workers never see them — so
  // the page and the worker reported 1457566783 vs 3616719147 for one claimed device. An
  // antifraud script does not need to know the correct value; the disagreement is the signal.
  if (CFG.canvasNoise && typeof CanvasRenderingContext2D !== 'undefined' && !CFG.engineCoversCanvas) {
    // TODO(engine-parity): CanvasRenderingContext2D.prototype.getImageData
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    hookMethod(CanvasRenderingContext2D.prototype, 'getImageData', function getImageData(sx, sy, sw, sh) {
      const imageData = origGetImageData.apply(this, arguments);
      if (imageData && imageData.data) {
        const data = imageData.data;
        const seed = (CFG.seeds.canvas ^ (Number(sx) * 73856093) ^ (Number(sy) * 19349663) ^ (Number(sw) * 83492791) ^ (Number(sh) * 42345677)) >>> 0;
        const rng = mulberry32(seed);
        for (let i = 0; i < data.length; i += 4) {
          const n0 = Math.floor(rng() * 5) - 2;
          const n1 = Math.floor(rng() * 5) - 2;
          const n2 = Math.floor(rng() * 5) - 2;
          data[i] = Math.min(255, Math.max(0, data[i] + n0));
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + n1));
          data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + n2));
        }
      }
      return imageData;
    });

    if (typeof HTMLCanvasElement !== 'undefined') {
      // TODO(engine-parity): HTMLCanvasElement.prototype.toDataURL
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      hookMethod(HTMLCanvasElement.prototype, 'toDataURL', function toDataURL() {
        try {
          if (typeof document !== 'undefined' && document.createElement && this.width > 0 && this.height > 0) {
            const temp = document.createElement('canvas');
            temp.width = this.width;
            temp.height = this.height;
            const tCtx = temp.getContext('2d');
            if (tCtx && tCtx.drawImage) {
              tCtx.drawImage(this, 0, 0);
              const img = tCtx.getImageData(0, 0, temp.width, temp.height);
              tCtx.putImageData(img, 0, 0);
              return origToDataURL.apply(temp, arguments);
            }
          }
        } catch (e) {}
        return origToDataURL.apply(this, arguments);
      });

      // TODO(engine-parity): HTMLCanvasElement.prototype.toBlob
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      hookMethod(HTMLCanvasElement.prototype, 'toBlob', function toBlob(callback) {
        try {
          if (typeof document !== 'undefined' && document.createElement && this.width > 0 && this.height > 0) {
            const temp = document.createElement('canvas');
            temp.width = this.width;
            temp.height = this.height;
            const tCtx = temp.getContext('2d');
            if (tCtx && tCtx.drawImage) {
              tCtx.drawImage(this, 0, 0);
              const img = tCtx.getImageData(0, 0, temp.width, temp.height);
              tCtx.putImageData(img, 0, 0);
              return origToBlob.apply(temp, arguments);
            }
          }
        } catch (e) {}
        return origToBlob.apply(this, arguments);
      });
    }
  }

  // --- WebGL / WebGL2 Noise & Vendor Spoofing ---
  //
  // Third surface with the same stand-down, and this one was found by an independent reviewer
  // running the probe with the launcher's GPU flags, which the probe had been omitting — without
  // them the kernel exposes no WebGL context at all and the comparison silently read 'no-gl' on
  // both sides, i.e. it agreed because nothing was measured. With the flags: kernel-only gives
  // identical strings in both contexts, while the JavaScript layer makes the page report 'no-gl'
  // against the worker's spoofed
  // 'Google Inc. (Apple)|ANGLE (...)'.
  if (CFG.webglNoise && !CFG.engineCoversWebgl) {
    const UNMASKED_VENDOR_WEBGL = 0x9245;
    const UNMASKED_RENDERER_WEBGL = 0x9246;

    if (typeof WebGLRenderingContext !== 'undefined') {
      // TODO(engine-parity): WebGLRenderingContext.prototype.getParameter
      const origGetParam = WebGLRenderingContext.prototype.getParameter;
      hookMethod(WebGLRenderingContext.prototype, 'getParameter', function getParameter(param) {
        if (param === UNMASKED_VENDOR_WEBGL) return CFG.webglVendor;
        if (param === UNMASKED_RENDERER_WEBGL) return CFG.webglRenderer;
        return origGetParam.apply(this, arguments);
      });

      // TODO(engine-parity): WebGLRenderingContext.prototype.readPixels
      const origReadPixels = WebGLRenderingContext.prototype.readPixels;
      hookMethod(WebGLRenderingContext.prototype, 'readPixels', function readPixels(x, y, w, h, format, type, pixels) {
        origReadPixels.apply(this, arguments);
        if (pixels && pixels.length) {
          const seed = (CFG.seeds.webgl ^ (Number(x) * 73856093) ^ (Number(y) * 19349663) ^ (Number(w) * 83492791) ^ (Number(h) * 42345677)) >>> 0;
          const rng = mulberry32(seed);
          for (let i = 0; i < pixels.length; i += 4) {
            const n0 = Math.floor(rng() * 5) - 2;
            const n1 = Math.floor(rng() * 5) - 2;
            const n2 = Math.floor(rng() * 5) - 2;
            pixels[i] = Math.min(255, Math.max(0, pixels[i] + n0));
            pixels[i + 1] = Math.min(255, Math.max(0, pixels[i + 1] + n1));
            pixels[i + 2] = Math.min(255, Math.max(0, pixels[i + 2] + n2));
          }
        }
      });
    }

    if (typeof WebGL2RenderingContext !== 'undefined') {
      // TODO(engine-parity): WebGL2RenderingContext.prototype.getParameter
      const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
      hookMethod(WebGL2RenderingContext.prototype, 'getParameter', function getParameter(param) {
        if (param === UNMASKED_VENDOR_WEBGL) return CFG.webglVendor;
        if (param === UNMASKED_RENDERER_WEBGL) return CFG.webglRenderer;
        return origGetParam2.apply(this, arguments);
      });

      // TODO(engine-parity): WebGL2RenderingContext.prototype.readPixels
      const origReadPixels2 = WebGL2RenderingContext.prototype.readPixels;
      hookMethod(WebGL2RenderingContext.prototype, 'readPixels', function readPixels(x, y, w, h, format, type, pixels) {
        origReadPixels2.apply(this, arguments);
        if (pixels && pixels.length) {
          const seed = (CFG.seeds.webgl ^ (Number(x) * 73856093) ^ (Number(y) * 19349663) ^ (Number(w) * 83492791) ^ (Number(h) * 42345677)) >>> 0;
          const rng = mulberry32(seed);
          for (let i = 0; i < pixels.length; i += 4) {
            const n0 = Math.floor(rng() * 5) - 2;
            const n1 = Math.floor(rng() * 5) - 2;
            const n2 = Math.floor(rng() * 5) - 2;
            pixels[i] = Math.min(255, Math.max(0, pixels[i] + n0));
            pixels[i + 1] = Math.min(255, Math.max(0, pixels[i + 1] + n1));
            pixels[i + 2] = Math.min(255, Math.max(0, pixels[i + 2] + n2));
          }
        }
      });
    }
  }

  // --- Audio Spoofing ---
  if (CFG.audioNoise) {
    if (typeof AudioBuffer !== 'undefined') {
      // TODO(engine-parity): AudioBuffer.prototype.getChannelData
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      hookMethod(AudioBuffer.prototype, 'getChannelData', function getChannelData(channel) {
        const data = origGetChannelData.apply(this, arguments);
        if (data && data.length) {
          const ch = Number(channel) || 0;
          const seed = (CFG.seeds.audio ^ (ch * 10007)) >>> 0;
          const rng = mulberry32(seed);
          for (let i = 0; i < data.length; i += 10) {
            const noise = (rng() * 0.0002) - 0.0001;
            data[i] = Math.max(-1, Math.min(1, data[i] + noise));
          }
        }
        return data;
      });

      // TODO(engine-parity): AudioBuffer.prototype.copyFromChannel
      const origCopyFromChannel = AudioBuffer.prototype.copyFromChannel;
      if (origCopyFromChannel) {
        hookMethod(AudioBuffer.prototype, 'copyFromChannel', function copyFromChannel(destination, channelNumber, startInChannel) {
          origCopyFromChannel.apply(this, arguments);
          if (destination && destination.length) {
            const ch = Number(channelNumber) || 0;
            const seed = (CFG.seeds.audio ^ (ch * 10007)) >>> 0;
            const rng = mulberry32(seed);
            for (let i = 0; i < destination.length; i += 10) {
              const noise = (rng() * 0.0002) - 0.0001;
              destination[i] = Math.max(-1, Math.min(1, destination[i] + noise));
            }
          }
        });
      }
    }

    if (typeof AnalyserNode !== 'undefined') {
      // TODO(engine-parity): AnalyserNode.prototype.getFloatFrequencyData
      const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
      if (origGetFloatFreq) {
        hookMethod(AnalyserNode.prototype, 'getFloatFrequencyData', function getFloatFrequencyData(array) {
          origGetFloatFreq.apply(this, arguments);
          if (array && array.length) {
            const rng = mulberry32(CFG.seeds.audio);
            for (let i = 0; i < array.length; i += 5) {
              const noise = (rng() * 0.0002) - 0.0001;
              array[i] = array[i] + noise;
            }
          }
        });
      }
    }
  }

  // --- DOMRect / ClientRects Noise ---
  if (CFG.rectsNoise) {
    function applyRectJitter(rect) {
      if (!rect) return rect;
      const seed = (CFG.seeds.rects ^ Math.round((rect.width || 0) * 100) ^ Math.round((rect.height || 0) * 100) ^ Math.round((rect.x || rect.left || 0) * 100) ^ Math.round((rect.y || rect.top || 0) * 100)) >>> 0;
      const rng = mulberry32(seed);
      const dx = (rng() * 0.0002) - 0.0001;
      const dy = (rng() * 0.0002) - 0.0001;
      const dw = (rng() * 0.0002) - 0.0001;
      const dh = (rng() * 0.0002) - 0.0001;
      const x = (rect.x !== undefined ? rect.x : rect.left) + dx;
      const y = (rect.y !== undefined ? rect.y : rect.top) + dy;
      const width = rect.width + dw;
      const height = rect.height + dh;
      if (typeof DOMRect !== 'undefined') {
        return new DOMRect(x, y, width, height);
      }
      return {
        x: x,
        y: y,
        width: width,
        height: height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
        toJSON: function() { return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }; }
      };
    }

    function wrapRectList(rectList) {
      if (!rectList || rectList.length === 0) return rectList;
      return new Proxy(rectList, {
        get(target, prop) {
          if (prop === 'item') {
            return makeNative(function item(index) {
              const r = target.item ? target.item(index) : target[index];
              return applyRectJitter(r);
            }, 'item', 1);
          }
          if (typeof prop === 'string' && !isNaN(Number(prop))) {
            const idx = Number(prop);
            const r = target[idx];
            return applyRectJitter(r);
          }
          const val = Reflect.get(target, prop);
          if (typeof val === 'function') {
            return val.bind(target);
          }
          return val;
        }
      });
    }

    if (typeof Element !== 'undefined') {
      // TODO(engine-parity): Element.prototype.getBoundingClientRect
      const origElemGetBoundingClientRect = Element.prototype.getBoundingClientRect;
      if (origElemGetBoundingClientRect) {
        hookMethod(Element.prototype, 'getBoundingClientRect', function getBoundingClientRect() {
          const rect = origElemGetBoundingClientRect.apply(this, arguments);
          return applyRectJitter(rect);
        });
      }

      // TODO(engine-parity): Element.prototype.getClientRects
      const origElemGetClientRects = Element.prototype.getClientRects;
      if (origElemGetClientRects) {
        hookMethod(Element.prototype, 'getClientRects', function getClientRects() {
          const rectList = origElemGetClientRects.apply(this, arguments);
          return wrapRectList(rectList);
        });
      }
    }

    if (typeof Range !== 'undefined') {
      // TODO(engine-parity): Range.prototype.getBoundingClientRect
      const origRangeGetBoundingClientRect = Range.prototype.getBoundingClientRect;
      if (origRangeGetBoundingClientRect) {
        hookMethod(Range.prototype, 'getBoundingClientRect', function getBoundingClientRect() {
          const rect = origRangeGetBoundingClientRect.apply(this, arguments);
          return applyRectJitter(rect);
        });
      }

      // TODO(engine-parity): Range.prototype.getClientRects
      const origRangeGetClientRects = Range.prototype.getClientRects;
      if (origRangeGetClientRects) {
        hookMethod(Range.prototype, 'getClientRects', function getClientRects() {
          const rectList = origRangeGetClientRects.apply(this, arguments);
          return wrapRectList(rectList);
        });
      }
    }
  }

  // --- Peripherals & Voices ---
  // TODO(engine-parity): speechSynthesis.getVoices
  if (typeof window !== 'undefined' && 'speechSynthesis' in window && window.speechSynthesis) {
    const voices = CFG.voices || [];
    hookMethod(window.speechSynthesis, 'getVoices', function getVoices() {
      return voices.map(function(v) {
        const obj = {
          default: v.default,
          lang: v.lang,
          localService: v.localService,
          name: v.name,
          voiceURI: v.voiceURI,
        };
        if (typeof SpeechSynthesisVoice !== 'undefined') {
          Object.setPrototypeOf(obj, SpeechSynthesisVoice.prototype);
        }
        return obj;
      });
    });
  }

  // TODO(engine-parity): navigator.mediaDevices.enumerateDevices
  if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const devices = CFG.mediaDevices || [];
    hookMethod(navigator.mediaDevices, 'enumerateDevices', function enumerateDevices() {
      return Promise.resolve(devices.map(function(d) {
        const obj = {
          deviceId: d.deviceId,
          kind: d.kind,
          label: d.label,
          groupId: d.groupId,
          toJSON: function() { return { deviceId: d.deviceId, kind: d.kind, label: d.label, groupId: d.groupId }; }
        };
        if (typeof MediaDeviceInfo !== 'undefined') {
          Object.setPrototypeOf(obj, MediaDeviceInfo.prototype);
        }
        return obj;
      }));
    });
  }

  // TODO(engine-parity): navigator.getBattery
  if (typeof navigator !== 'undefined') {
    hookMethod(navigator, 'getBattery', function getBattery() {
      const isMob = isMobile;
      const batteryManager = {
        charging: !isMob,
        chargingTime: isMob ? Infinity : 0,
        dischargingTime: isMob ? 12000 : Infinity,
        level: isMob ? 0.85 : 1.0,
        onchargingchange: null,
        onchargingtimechange: null,
        ondischargingtimechange: null,
        onlevelchange: null,
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; },
      };
      if (typeof BatteryManager !== 'undefined') {
        Object.setPrototypeOf(batteryManager, BatteryManager.prototype);
      }
      return Promise.resolve(batteryManager);
    });
  }

  // --- WebGPU Interim Surface Hardening ---
  // TODO(engine-parity: webgpu-dawn): navigator.gpu.requestAdapter
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    const webgpuCfg = CFG.webgpu;
    if (webgpuCfg && !webgpuCfg.disabled) {
      hookMethod(navigator.gpu, 'requestAdapter', function requestAdapter(options) {
        void options;
        const adapterInfo = {
          vendor: webgpuCfg.vendor || '',
          architecture: webgpuCfg.architecture || '',
          device: webgpuCfg.device || '',
          description: webgpuCfg.description || '',
        };
        if (typeof GPUAdapterInfo !== 'undefined') {
          Object.setPrototypeOf(adapterInfo, GPUAdapterInfo.prototype);
        }
        const adapter = {
          isFallbackAdapter: false,
          features: new Set(webgpuCfg.features || []),
          limits: Object.assign({}, webgpuCfg.limits || {}),
          requestAdapterInfo: makeNative(function requestAdapterInfo() {
            return Promise.resolve(adapterInfo);
          }, 'requestAdapterInfo', 0),
          requestDevice: makeNative(function requestDevice() {
            return Promise.resolve(null);
          }, 'requestDevice', 0),
        };
        if (typeof GPUAdapter !== 'undefined') {
          Object.setPrototypeOf(adapter, GPUAdapter.prototype);
        }
        return Promise.resolve(adapter);
      });
    } else {
      hookMethod(navigator.gpu, 'requestAdapter', function requestAdapter() {
        return Promise.resolve(undefined);
      });
    }
  }

  // --- WebAuthn Interim Surface Hardening ---
  // TODO(engine-parity: webauthn): PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
  if (typeof PublicKeyCredential !== 'undefined' && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    const isAuthAvailable = Boolean(CFG.webauthnPlatformAuth);
    hookMethod(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', function isUserVerifyingPlatformAuthenticatorAvailable() {
      return Promise.resolve(isAuthAvailable);
    });
  }

  // --- Font Pinning & Enumeration Cloaking ---
  // TODO(engine-parity: fonts): DirectWrite/CoreText/FreeType system fallback and CSS/canvas
  // glyph rasterization of host-installed fonts remain engine-owned without C++ Blink/Skia patches.
  // Every JS-measurable enumeration and metric probe surface (FontFaceSet.check, measureText on
  // CanvasRenderingContext2D & OffscreenCanvasRenderingContext2D, HTMLElement offsetWidth/offsetHeight,
  // window/self.queryLocalFonts, navigator.fonts absence) is closed below across main and worker contexts.
  if (CFG.fonts && CFG.fonts.inventory) {
    const fontInventory = CFG.fonts.inventory;
    const hiddenHostFonts = CFG.fonts.hiddenHostFonts || [];
    const fallbackFace = CFG.fonts.fallbackFace || 'Arial';
    const inventorySet = new Set(fontInventory.map((f) => f.toLowerCase().trim()));
    const hiddenSet = new Set(hiddenHostFonts.map((f) => f.toLowerCase().trim()));

    function splitShorthandPrefix(firstPart) {
      const trimmed = (firstPart || '').trim();
      const m = trimmed.match(/^((?:.*?\\s)?(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger|[0-9.]+(?:px|pt|em|rem|%)(?:\\/[0-9.]+(?:px|pt|em|rem|%)?)?)\\s+)(.+)$/i);
      if (m) return { prefix: m[1], familyRaw: m[2].trim() };
      return { prefix: '', familyRaw: trimmed };
    }

    function normalizeFontFamily(fontStr) {
      if (!fontStr || typeof fontStr !== 'string') return [];
      return fontStr
        .split(',')
        .map((part, idx) => {
          const raw = idx === 0 ? splitShorthandPrefix(part).familyRaw : part.trim();
          const unquoted = raw.replace(/^["']|["']$/g, '').trim();
          const m = unquoted.match(/(?:(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger|[0-9.]+(?:px|pt|em|rem|%))\\s+)+(.+)$/i);
          return (m ? m[1].replace(/^["']|["']$/g, '').trim() : unquoted).toLowerCase();
        })
        .filter(Boolean);
    }

    function stripFontFamilies(fontStr, shouldStrip) {
      if (!fontStr || typeof fontStr !== 'string') return '';
      const parts = fontStr.split(',');
      const firstSplit = splitShorthandPrefix(parts[0]);
      const kept = [];
      for (let i = 0; i < parts.length; i++) {
        const raw = i === 0 ? firstSplit.familyRaw : parts[i].trim();
        const unquoted = raw.replace(/^["']|["']$/g, '').trim();
        const m = unquoted.match(/(?:(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger|[0-9.]+(?:px|pt|em|rem|%))\\s+)+(.+)$/i);
        const fam = (m ? m[1].replace(/^["']|["']$/g, '').trim() : unquoted).toLowerCase();
        if (fam && !shouldStrip(fam)) {
          kept.push(raw);
        }
      }
      if (kept.length === 0) return '';
      return firstSplit.prefix + kept.join(', ');
    }

    // TODO(engine-parity: fonts): document.fonts.check, self.fonts.check, and FontFaceSet.prototype.check
    function makeFontCheckHook(origCheck) {
      return function check(font, text) {
        const families = normalizeFontFamily(font).filter(function (fam) {
          return !hiddenSet.has(fam);
        });
        if (families.length === 0) return false;
        for (const fam of families) {
          if (inventorySet.has(fam)) return true;
        }
        const filteredFont = stripFontFamilies(font, function (fam) {
          return hiddenSet.has(fam);
        });
        if (!filteredFont) return false;
        try {
          return origCheck.call(this, filteredFont, text);
        } catch {
          return false;
        }
      };
    }

    if (typeof FontFaceSet !== 'undefined' && FontFaceSet.prototype && FontFaceSet.prototype.check) {
      const origCheck = FontFaceSet.prototype.check;
      hookMethod(FontFaceSet.prototype, 'check', makeFontCheckHook(origCheck));
    }
    if (typeof self !== 'undefined' && self.fonts && typeof self.fonts.check === 'function') {
      if (typeof FontFaceSet === 'undefined' || !(self.fonts instanceof FontFaceSet)) {
        const origWorkerCheck = self.fonts.check;
        hookMethod(self.fonts, 'check', makeFontCheckHook(origWorkerCheck));
      }
    }

    // TODO(engine-parity: fonts): CanvasRenderingContext2D & OffscreenCanvasRenderingContext2D measureText
    // Real presence detection works by measuring the same probe string twice — once with
    // the candidate family first, once with a known fallback — and comparing widths. A
    // family the profile declares must behave like a font that machine actually has, i.e.
    // it must produce a width distinct from the plain fallback. A font we must hide has to
    // drop out of the chain so the next candidate (or the fallback) answers instead.
    function hookMeasureTextOnProto(proto) {
      if (!proto || typeof proto.measureText !== 'function') return;
      const origMeasureText = proto.measureText;
      hookMethod(proto, 'measureText', function measureText(text) {
        const currentFont = this.font || '';
        const families = normalizeFontFamily(currentFont);
        let hasHidden = false;
        let hasDeclared = false;
        for (const fam of families) {
          if (hiddenSet.has(fam)) {
            hasHidden = true;
          } else if (inventorySet.has(fam)) {
            hasDeclared = true;
          }
        }

        if (!hasHidden && !hasDeclared) {
          return origMeasureText.call(this, text);
        }

        const prevFont = this.font;
        try {
          const effectiveFont = hasHidden
            ? stripFontFamilies(currentFont, function (fam) {
                return hiddenSet.has(fam);
              })
            : currentFont;

          if (!hasDeclared) {
            this.font = effectiveFont;
            return origMeasureText.call(this, text);
          }

          this.font = effectiveFont;
          const measured = origMeasureText.call(this, text);
          const declaredStripped = stripFontFamilies(effectiveFont, function (fam) {
            return inventorySet.has(fam) || hiddenSet.has(fam);
          });
          this.font = declaredStripped || "'" + fallbackFace + "'";
          const strippedMeasurement = origMeasureText.call(this, text);
          if (strippedMeasurement.width === measured.width) {
            this.font = "'" + fallbackFace + "'";
            return origMeasureText.call(this, text);
          }
          return measured;
        } finally {
          this.font = prevFont;
        }
      });
    }

    if (typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype) {
      hookMeasureTextOnProto(CanvasRenderingContext2D.prototype);
    }
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined' && OffscreenCanvasRenderingContext2D.prototype) {
      hookMeasureTextOnProto(OffscreenCanvasRenderingContext2D.prototype);
    }

    // TODO(engine-parity: fonts): probe elements offsetWidth / offsetHeight
    if (typeof HTMLElement !== 'undefined') {
      function hookElementFontMetric(prop) {
        const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
        if (!desc || !desc.get) return;
        const origGet = desc.get;
        hookGetter(HTMLElement.prototype, prop, function get() {
          const style = this.style ? this.style.fontFamily : '';
          if (!style) return origGet.call(this);
          const fams = normalizeFontFamily(style);
          let hasHidden = false;
          let hasDeclared = false;
          for (const fam of fams) {
            if (hiddenSet.has(fam)) {
              hasHidden = true;
            } else if (inventorySet.has(fam)) {
              hasDeclared = true;
            }
          }
          if (!hasHidden && !hasDeclared) {
            return origGet.call(this);
          }
          const prevFam = this.style.fontFamily;
          try {
            const effectiveFam = hasHidden
              ? stripFontFamilies(style, function (fam) {
                  return hiddenSet.has(fam);
                })
              : style;
            this.style.fontFamily = effectiveFam;
            const measured = origGet.call(this);
            if (hasDeclared) {
              const declaredStripped = stripFontFamilies(effectiveFam, function (fam) {
                return inventorySet.has(fam) || hiddenSet.has(fam);
              });
              this.style.fontFamily = declaredStripped || fallbackFace;
              const strippedMeasured = origGet.call(this);
              if (strippedMeasured === measured) {
                this.style.fontFamily = fallbackFace;
                return origGet.call(this);
              }
            }
            return measured;
          } finally {
            this.style.fontFamily = prevFam;
          }
        });
      }
      hookElementFontMetric('offsetWidth');
      hookElementFontMetric('offsetHeight');
    }

    // TODO(engine-parity: fonts): window.queryLocalFonts & navigator.fonts absence
    // Stock Chrome exposes Local Font Access through window.queryLocalFonts() and has
    // NO navigator.fonts object. Defining one would itself be a detectable tell, so we
    // only neutralise the real surface: present, but rejecting until permission is given.
    const rejectLocalFonts = function queryLocalFonts() {
      const err = new DOMException('Permission denied', 'NotAllowedError');
      return Promise.reject(err);
    };
    if (typeof window !== 'undefined' && window.queryLocalFonts) {
      hookMethod(window, 'queryLocalFonts', rejectLocalFonts);
    }
    if (typeof self !== 'undefined' && self.queryLocalFonts) {
      hookMethod(self, 'queryLocalFonts', rejectLocalFonts);
    }
  }
})();`;
}

export async function applyStealth(wsEndpoint: string, opts: StealthOptions): Promise<() => void> {
  // CDP script injection is broken in this kernel (addScriptToEvaluateOnNewDocument is
  // accepted but never runs; addScriptToEvaluateOnLoad fails deserialization). The stealth
  // layer is therefore delivered as a per-profile MV3 extension (MAIN world, document_start)
  // loaded via --load-extension. Nothing to do at CDP time.
  void wsEndpoint;
  void opts;
  return () => {};
}

export interface WriteStealthExtensionOptions {
  signingKey?: KeyPairPem;
  version?: string;
}

export function writeStealthExtension(
  dir: string,
  opts: StealthOptions,
  signingOpts?: WriteStealthExtensionOptions
): string {
  const manifest = {
    manifest_version: 3,
    name: 'Stealth Layer',
    version: '1.0.0',
    description: 'Hardware and Client Hints consistency layer',
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['stealth.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: true,
      },
    ],
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'stealth.js'), buildStealthScript(opts), 'utf8');
  if (signingOpts?.signingKey) {
    signStealthExtension(dir, signingOpts.signingKey, signingOpts.version ?? '1.0.0');
  }
  return dir;
}
