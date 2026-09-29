import * as crypto from 'crypto';

export interface SubSeeds {
  canvas: number;
  webgl: number;
  audio: number;
  rects: number;
}

export interface SensorProfile {
  gravity: { x: number; y: number; z: number };
  jitterAmplitude: number;
  orientation: {
    type: 'portrait-primary' | 'portrait-secondary' | 'landscape-primary' | 'landscape-secondary';
    angle: number;
  };
  rotationCapability: boolean;
}

/**
 * Derive deterministic 32-bit unsigned integer sub-seeds from a master profile seed
 * and surface domain tags using SHA-256.
 */
export function deriveSubSeeds(masterSeed: number = 12345): SubSeeds {
  const surfaces = ['canvas', 'webgl', 'audio', 'rects'] as const;
  const result: Record<string, number> = {};

  for (const surface of surfaces) {
    const hash = crypto
      .createHash('sha256')
      .update(`${masterSeed}:seed_${surface}`)
      .digest();
    result[surface] = hash.readUInt32LE(0);
  }

  // SAFETY: surfaces covers all four SubSeeds keys ('canvas' | 'webgl' | 'audio' | 'rects').
  return result as unknown as SubSeeds;
}

export interface SyntheticVoice {
  default: boolean;
  lang: string;
  localService: boolean;
  name: string;
  voiceURI: string;
}

const WIN_LOCALE_VOICES: Record<string, { lang: string; sName: string; gName: string }> = {
  ru: { lang: 'ru-RU', sName: 'Microsoft Irina - Russian (Russia)', gName: 'Google русский' },
  de: { lang: 'de-DE', sName: 'Microsoft Hedda - German (Germany)', gName: 'Google Deutsch' },
  fr: { lang: 'fr-FR', sName: 'Microsoft Hortense - French (France)', gName: 'Google français' },
  es: { lang: 'es-ES', sName: 'Microsoft Helena - Spanish (Spain)', gName: 'Google español' },
};

const APPLE_LOCALE_VOICES: Record<string, { lang: string; primary: string; secondary: string }> = {
  ru: { lang: 'ru-RU', primary: 'Milena', secondary: 'Yuri' },
  de: { lang: 'de-DE', primary: 'Anna', secondary: 'Markus' },
  fr: { lang: 'fr-FR', primary: 'Thomas', secondary: 'Amelie' },
  es: { lang: 'es-ES', primary: 'Monica', secondary: 'Jorge' },
};

/**
 * Get realistic SpeechSynthesis voice pool coherent with operating system and locale.
 */
export function getSyntheticVoicePool(
  platform: 'windows' | 'macos' | 'linux' | 'android' | 'ios' = 'windows',
  locale: string = 'en-US'
): SyntheticVoice[] {
  const langPrefix = locale.toLowerCase().slice(0, 2);
  const makeVoice = (name: string, lang: string, localService: boolean, isDefault: boolean): SyntheticVoice => ({
    default: isDefault,
    lang,
    localService,
    name,
    voiceURI: name,
  });

  if (platform === 'windows') {
    const voices: SyntheticVoice[] = [];
    const loc = WIN_LOCALE_VOICES[langPrefix];
    if (loc) {
      voices.push(
        makeVoice(loc.sName, loc.lang, true, true),
        makeVoice(loc.gName, loc.lang, false, false)
      );
    }
    const isEnDefault = voices.length === 0;
    voices.push(
      makeVoice('Microsoft David - English (United States)', 'en-US', true, isEnDefault),
      makeVoice('Microsoft Zira - English (United States)', 'en-US', true, false),
      makeVoice('Microsoft Mark - English (United States)', 'en-US', true, false),
      makeVoice('Google US English', 'en-US', false, false)
    );
    return voices;
  }

  if (platform === 'macos' || platform === 'ios') {
    const voices: SyntheticVoice[] = [];
    const loc = APPLE_LOCALE_VOICES[langPrefix];
    if (loc) {
      voices.push(
        makeVoice(loc.primary, loc.lang, true, true),
        makeVoice(loc.secondary, loc.lang, true, false)
      );
    }
    const isEnDefault = voices.length === 0;
    voices.push(
      makeVoice('Samantha', 'en-US', true, isEnDefault),
      makeVoice('Alex', 'en-US', true, false),
      makeVoice('Fred', 'en-US', true, false),
      makeVoice('Victoria', 'en-US', true, false)
    );
    if (platform === 'macos') {
      voices.push(makeVoice('Google US English', 'en-US', false, false));
    }
    return voices;
  }

  // Linux / Android voice pool: Google / OS-neutral voices (never Apple Samantha or Microsoft SAPI)
  const voices: SyntheticVoice[] = [];
  const loc = WIN_LOCALE_VOICES[langPrefix];
  if (loc) {
    voices.push(makeVoice(loc.gName, loc.lang, false, true));
  }
  const isEnDefault = voices.length === 0;
  voices.push(
    makeVoice('Google US English', 'en-US', false, isEnDefault),
    makeVoice('Google UK English Female', 'en-GB', false, false)
  );
  return voices;
}

export interface SyntheticMediaDevice {
  deviceId: string;
  kind: 'audioinput' | 'audiooutput' | 'videoinput';
  label: string;
  groupId: string;
}

/**
 * Generate synthetic MediaDeviceInfo objects deterministically from seed.
 */
export function getSyntheticMediaDevices(
  masterSeed: number = 12345,
  mobile: boolean = false
): SyntheticMediaDevice[] {
  const hash = (tag: string) =>
    crypto
      .createHash('sha256')
      .update(`${masterSeed}:${tag}`)
      .digest('hex');

  const groupAudio = hash('group_audio');
  const groupVideo = hash('group_video');

  const devices: SyntheticMediaDevice[] = [
    {
      deviceId: hash('dev_audio_in'),
      kind: 'audioinput',
      label: '',
      groupId: groupAudio,
    },
    {
      deviceId: hash('dev_audio_out'),
      kind: 'audiooutput',
      label: '',
      groupId: groupAudio,
    },
    {
      deviceId: hash('dev_video_in_0'),
      kind: 'videoinput',
      label: '',
      groupId: groupVideo,
    },
  ];

  if (mobile) {
    devices.push({
      deviceId: hash('dev_video_in_1'),
      kind: 'videoinput',
      label: '',
      groupId: groupVideo,
    });
  }

  return devices;
}

/**
 * Returns default font inventory pool for a logical platform.
 */
export function getPlatformFontPool(platform: string): string[] {
  switch (platform) {
    case 'macos':
    case 'ios':
      return [
        'Arial', 'Arial Hebrew', 'Avenir', 'Avenir Next', 'Courier', 'Courier New',
        'Geneva', 'Georgia', 'Helvetica', 'Helvetica Neue', 'Lucida Grande', 'Menlo',
        'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'PingFang SC', 'PingFang TC',
        'SF Pro', 'SF Pro Display', 'SF Pro Text', 'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana'
      ];
    case 'linux':
    case 'android':
      return [
        'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans',
        'Liberation Serif', 'Liberation Mono', 'Roboto', 'Noto Sans'
      ];
    case 'windows':
    default:
      return [
        'Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New',
        'Georgia', 'Impact', 'Lucida Console', 'Microsoft Sans Serif', 'Segoe UI',
        'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol', 'Segoe UI Variable',
        'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'
      ];
  }
}

/**
 * Resolve sensor configuration deterministically from profile seed.
 * Returns null for non-mobile profiles.
 */
export function resolveSensorConfig(opts: {
  mobile?: boolean;
  seed?: number;
  logicalPlatform?: string;
}): SensorProfile | null {
  if (!opts || !opts.mobile) {
    return null;
  }

  const masterSeed = opts.seed ?? 12345;
  const hash = (tag: string) =>
    crypto
      .createHash('sha256')
      .update(`${masterSeed}:${tag}`)
      .digest();

  const jitterBuf = hash('sensor_jitter');
  // Handheld jitter amplitude in range [0.02, 0.08] m/s^2
  const jitterAmplitude = 0.02 + (jitterBuf.readUInt32LE(0) % 600) / 10000;

  const orientBuf = hash('sensor_orientation');
  const orientPick = orientBuf.readUInt8(0) % 2; // Default mobile orientation is usually portrait-primary (0 deg) or occasionally landscape-primary (90 deg)
  const isPortrait = orientPick === 0;

  const orientation = isPortrait
    ? { type: 'portrait-primary' as const, angle: 0 }
    : { type: 'landscape-primary' as const, angle: 90 };

  // Gravity: on flat surface or slightly tilted handheld.
  // Standard gravity is 9.80665 m/s^2.
  // Slight tilt derived deterministically:
  const gravBuf = hash('sensor_gravity');
  const tiltX = ((gravBuf.readInt16LE(0) % 100) / 1000); // [-0.1, 0.1]
  const tiltY = ((gravBuf.readInt16LE(2) % 100) / 1000); // [-0.1, 0.1]
  const gz = isPortrait ? 9.8 : 9.8;
  const _gx = isPortrait ? tiltX : 9.8;
  const gy = isPortrait ? (tiltY + (opts.logicalPlatform === 'ios' ? 0.2 : 0.1)) : tiltY;

  return {
    gravity: { x: Number(tiltX.toFixed(4)), y: Number(gy.toFixed(4)), z: Number(gz.toFixed(4)) },
    jitterAmplitude: Number(jitterAmplitude.toFixed(4)),
    orientation,
    rotationCapability: true,
  };
}
