import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { findKernelExecutable } from './util/kernelLayout';

// Base directory for app settings (settings.json). Electron sets ANTIDETECT_SETTINGS_DIR
// to app.getPath('userData'); standalone service falls back to ~/.antidetect.
function settingsBase(): string {
  // ANTIDETECT_SETTINGS_DIR wins over portability on purpose: a managed deployment or a test
  // pins where settings live, and silently relocating them would break that contract.
  if (process.env.ANTIDETECT_SETTINGS_DIR && process.env.ANTIDETECT_SETTINGS_DIR.length > 0) {
    return process.env.ANTIDETECT_SETTINGS_DIR;
  }
  // Portable launch: the settings file travels WITH the folder, so the recorded data location
  // is not left behind on the machine the stick was prepared on.
  if (isPortableMode()) {
    return portableBaseDir() as string;
  }
  // KEEP: Preserves existing install directory location ~/.antidetect across updates.
  return path.join(os.homedir(), '.antidetect');
}

function settingsFile(): string {
  return path.join(settingsBase(), 'settings.json');
}

/**
 * The settings file this installation used BEFORE settings moved beside the executable.
 *
 * An installation created before that change keeps its `settings.json` — and with it the record
 * of where its data lives — under the user profile. Reading only the portable location made that
 * record invisible: measured on a real install whose settings file held `dataDir: "D:\\NULLTRACE"`,
 * `readSettings()` returned `{}` and the app created a SECOND data directory beside itself,
 * leaving the profiles in the original one.
 *
 * Only consulted when the portable settings file does not exist, so a migrated installation is
 * never read from two places at once.
 */
function legacySettingsFile(): string | null {
  if (!isPortableMode()) return null;
  // An explicitly pinned settings directory is a deliberate decision by a deployment or a test:
  // it means "read settings HERE", so looking elsewhere would override that instruction with a
  // stale file from the user profile.
  if (process.env.ANTIDETECT_SETTINGS_DIR && process.env.ANTIDETECT_SETTINGS_DIR.length > 0) {
    return null;
  }
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'antidetect-browser', 'settings.json') : null,
    path.join(os.homedir(), '.antidetect', 'settings.json'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Move a settings file that cannot be parsed aside, so the next `writeSettings` does not
 * erase the only copy of the operator's choices.
 *
 * Without this, a truncated write (a crash mid-save, a power cut) meant the file was silently
 * replaced by defaults on the next save, taking the chosen data directory, ports and paths
 * with it — and leaving nothing to recover them from. The backup is best-effort: if it fails,
 * losing settings is still better than refusing to start.
 */
function quarantineSettings(file: string, raw: string): void {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dest = `${file}.corrupt-${stamp}`;
    fs.writeFileSync(dest, raw, 'utf8');
    console.error(`[config] settings file unreadable — kept a copy at ${dest}`);
  } catch {
    // nothing sensible to do; the caller still falls back to defaults
  }
}

export function readSettings(): Record<string, SettingValue> {
  const primary = settingsFile();
  try {
    return JSON.parse(fs.readFileSync(primary, 'utf8')) as Record<string, SettingValue>;
  } catch {
    // Only quarantine when the file EXISTS and is unreadable. A missing file is a first run,
    // not damage, and writing a .corrupt copy for it would just be noise.
    if (fs.existsSync(primary)) {
      try {
        quarantineSettings(primary, fs.readFileSync(primary, 'utf8'));
      } catch {
        // unreadable even as bytes — nothing to preserve
      }
    }

    // Fall back to the pre-move location, and MIGRATE it: once the portable file exists the
    // legacy one is never read again, which is what keeps a copied folder self-contained.
    const legacy = legacySettingsFile();
    if (legacy) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Record<string, SettingValue>;
        writeSettings(parsed);
        return parsed;
      } catch {
        // A corrupt legacy file is preserved for the same reason as the primary one.
        try {
          quarantineSettings(legacy, fs.readFileSync(legacy, 'utf8'));
        } catch {
          // nothing to preserve
        }
      }
    }
    return {};
  }
}

export type SettingsWriteListener = () => void;
const settingsWriteListeners = new Set<SettingsWriteListener>();
let settingsWriteSuppressionDepth = 0;

/** Subscribe to settings mutations. Returns an unsubscribe function. */
export function onSettingsWrite(fn: () => void): () => void {
  settingsWriteListeners.add(fn);
  return () => {
    settingsWriteListeners.delete(fn);
  };
}

/**
 * Silence settings write notifications while syncing remote settings,
 * preventing a local push from triggering immediately after pull.
 */
export function pushSettingsWriteSuppression(): void {
  settingsWriteSuppressionDepth += 1;
}

export function popSettingsWriteSuppression(): void {
  if (settingsWriteSuppressionDepth > 0) {
    settingsWriteSuppressionDepth -= 1;
  }
}

function notifySettingsWrite(): void {
  if (settingsWriteSuppressionDepth > 0) return;
  for (const listener of settingsWriteListeners) {
    try {
      listener();
    } catch (err) {
      console.error('[config] settings write listener error:', (err as Error).message);
    }
  }
}

function writeSettings(s: Record<string, unknown>): void {
  tryWriteSettings(s);
}

/**
 * True when running from the installer-free portable artefact.
 *
 * electron-builder's `portable` target self-extracts and exports
 * PORTABLE_EXECUTABLE_DIR pointing at the directory the user actually ran the
 * .exe from. A portable copy must resolve its data relative to THAT directory,
 * never to an absolute path captured on first run — otherwise moving the folder
 * to another machine or drive breaks it, which is the whole point of portable.
 */
export function isPortableMode(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR && process.env.PORTABLE_EXECUTABLE_DIR.length > 0);
}

/** Directory the portable executable was launched from, or null when not portable. */
export function portableBaseDir(): string | null {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR;
  return dir && dir.length > 0 ? dir : null;
}

/**
 * Marker file written into a data directory this installation has adopted.
 *
 * Its only job is to say "this folder belongs to NullTrace": the resolver uses it to keep a
 * recorded path without demanding that real data already exists there, which is the state a
 * freshly chosen folder is in. It is NOT a substitute for the database — a folder with data and
 * no marker is still honoured.
 */
const DATA_ROOT_MARKER = '.nulltrace-data-root';

/**
 * Resolve the data directory from the current environment and settings.
 *
 * Exported so the resolution order can be exercised directly: `DATA_DIR` is a module-level
 * constant, so testing the order through it would need a module reload per case.
 *
 * The portable rule is what makes the folder movable. A recorded `dataDir` used to win
 * unconditionally, which on removable media is the OLD machine's absolute path — the folder the
 * stick is plugged into would resolve to a directory that is not there. A recorded path is
 * therefore honoured only while it exists AND holds data; otherwise a portable launch falls
 * through to the folder beside the executable. On the machine that recorded it, the path still
 * exists and nothing changes.
 */
export function resolveDataDir(): string {
  // 1) Explicit env override (used by tests and CI, and by the shell so both agree).
  if (process.env.ANTIDETECT_DATA_DIR && process.env.ANTIDETECT_DATA_DIR.length > 0) {
    return process.env.ANTIDETECT_DATA_DIR;
  }
  const settings = readSettings();

  // 2) A recorded choice, but only one that is still usable HERE. A path that is absent, or
  //    present without any data, belongs to another machine — that is the moved-folder case.
  const saved = settings.dataDir;
  if (typeof saved === 'string' && saved.length > 0 && dataDirHoldsData(saved)) {
    markDataRoot(saved);
    return saved;
  }

  // 3) Portable mode: data beside the executable so the folder can be moved whole.
  //    Honours an explicit 'system' choice, which falls through to the default below.
  if (isPortableMode() && settings.dataMode !== 'system') {
    const portableData = path.join(portableBaseDir() as string, 'data');
    markDataRoot(portableData);
    return portableData;
  }

  // 4) Default: <settingsBase>/data (writable, stable across updates).
  const fallback = path.join(settingsBase(), 'data');
  markDataRoot(fallback);
  return fallback;
}

/**
 * Claim a directory as this installation's data root, so the resolver keeps honouring it before
 * any real data exists there (a folder the operator has just chosen, or one a move is about to
 * fill).
 *
 * Must be called WHEN THE CHOICE IS MADE, not when it is next read: the next launch asks
 * `dataDirHoldsData` before the folder has a database, so a marker written later would arrive
 * after the decision that needed it. Best-effort by design — a folder that cannot be marked is
 * still usable, and failing here must not take a settings write down with it.
 */
export function markDataRoot(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, DATA_ROOT_MARKER), 'nulltrace\n', 'utf8');
  } catch {
    // Not fatal: the folder still works, it just relies on real data to be recognised.
  }
}

/**
 * True when `candidateDir` exists and holds real data:
 * - the database file `antidetect.db` exists inside it, OR
 * - the `profiles/` directory exists inside it and is non-empty.
 *
 * The marker must be something only real use can produce: `config.ts` eagerly creates the data
 * dir, `profiles/`, `chromium/` and an empty database at import, so their mere existence proves
 * nothing.
 */
export function dataDirHoldsData(candidateDir: string): boolean {
  try {
    if (!fs.existsSync(candidateDir)) return false;
    if (fs.existsSync(path.join(candidateDir, 'antidetect.db'))) return true;
    // A folder this installation has already adopted. Without this, choosing a NEW empty folder
    // in the first-run prompt was honoured on that launch and silently discarded on the next
    // one: `config.ts` creates the database, `profiles/` and `chromium/` eagerly, so a freshly
    // adopted folder looks identical to a stranger's directory for one launch — long enough for
    // the data to move somewhere else. Measured: the recorded path was ignored and the app
    // resolved to `<launch folder>\data` instead.
    if (fs.existsSync(path.join(candidateDir, DATA_ROOT_MARKER))) return true;
    return hasProfileData(path.join(candidateDir, 'profiles'));
  } catch {
    return false;
  }
}

/**
 * Whether this launch should ask the operator where to keep its data.
 *
 * This is the first-run prompt, and it applies to EVERY build, not just the portable one:
 * an installed app puts profiles, the database, the browser kernel and downloaded
 * extensions under the user profile, which may be on a small system drive. The operator gets
 * to choose once, and the answer is honoured from then on.
 *
 * It deliberately returns false wherever the location is imposed rather than chosen:
 *   - `ANTIDETECT_DATA_DIR` was set from outside — CI, tests and managed deployments pin the
 *     path. The desktop shell also exports this variable, but only so the sidecar agrees with
 *     the path the shell resolved; it marks that export with
 *     `ANTIDETECT_DATA_DIR_FROM_SHELL`, which keeps a first run on the desktop prompting
 *     instead of silently resolving to the default;
 *   - server mode — a headless deployment has no one to click, and its paths come from the
 *     environment;
 *   - a directory or a mode was already recorded — never re-ask;
 *   - the current directory already holds profiles — an install upgraded from a version that
 *     never recorded a choice. Asking there would be an invitation to relocate away from
 *     existing profiles, which looks exactly like losing them.
 */
export function needsFirstRunDataChoice(): boolean {
  const shellExported = process.env.ANTIDETECT_DATA_DIR_FROM_SHELL === '1';
  const pinnedExternally =
    !shellExported && typeof process.env.ANTIDETECT_DATA_DIR === 'string' && process.env.ANTIDETECT_DATA_DIR.length > 0;
  if (pinnedExternally) return false;
  if (SERVER_MODE) return false;
  const s = readSettings();
  if (typeof s.dataDir === 'string' && s.dataDir.length > 0) return false;
  if (s.dataMode === 'portable' || s.dataMode === 'system') return false;
  // Existing data is itself proof that the location is settled. Without this an upgrade from
  // a build that predates the prompt would ask a user with hundreds of profiles to start
  // fresh, and the obvious answer — "pick a new folder" — would open an empty library.
  //
  // The marker must be something only real use can produce. `config.ts` eagerly creates the
  // data dir, `profiles/`, `chromium/` and an empty database at import, so their mere
  // existence proves nothing — an earlier revision checked the folders themselves and the
  // prompt never fired. A NON-EMPTY profiles directory is the reliable signal: profile
  // folders are only created when the operator actually runs a profile. An installed kernel
  // is deliberately NOT used — a dev checkout leaves an empty `chromium/fingerprint-chromium`
  // symlink, which would silently suppress the prompt on a fresh install.
  const target = resolveDataDir();
  if (hasProfileData(path.join(target, 'profiles'))) return false;
  return true;
}

/** True when `profilesDir` holds at least one entry, i.e. the app has been used for real. */
function hasProfileData(profilesDir: string): boolean {
  try {
    return fs.readdirSync(profilesDir).length > 0;
  } catch {
    return false;
  }
}

/**
 * The directory that would be used if the operator accepts the default.
 *
 * Shown in the first-run prompt and used when they press "Use this folder" without picking
 * anything, so the UI can state the actual path instead of describing it vaguely.
 */
export function defaultDataDir(): string {
  if (isPortableMode()) return path.join(portableBaseDir() as string, 'data');
  return path.join(settingsBase(), 'data');
}

/**
 * Persist the first-run choice and report whether it was actually written.
 *
 * A concrete `dir` is stored under `dataDir` — the same key the resolver reads and Settings
 * writes — and a `mode` records one of the two well-known layouts, clearing any earlier
 * explicit path because a stale path would otherwise silently outrank the mode the operator
 * just picked. Takes effect on the next start: `DATA_DIR` is resolved once at import time.
 */
export function setFirstRunDataChoice(choice: { dir?: string | null; mode?: 'portable' | 'system' }): { ok: boolean; error?: string } {
  if (choice.dir && choice.dir.trim().length > 0) {
    const chosen = path.resolve(choice.dir.trim());
    // Claim it BEFORE recording it: the next launch decides whether the recorded path is
    // usable, and at that moment a freshly chosen folder contains only a database created
    // during import — which is not by itself proof that the folder is ours.
    markDataRoot(chosen);
    const s = readSettings();
    s.dataDir = chosen;
    return tryWriteSettings(s);
  }
  if (choice.mode === 'portable' || choice.mode === 'system') {
    const s = readSettings();
    s.dataMode = choice.mode;
    delete s.dataDir;
    return tryWriteSettings(s);
  }
  return { ok: false, error: 'either dir or mode is required' };
}

/**
 * True when the directory can actually hold the data: it exists or can be created, and is
 * writable. A prompt that accepts an unwritable path (Program Files, a read-only share)
 * would fail later with an opaque database error instead of at the moment of choosing.
 *
 * `create: false` answers the question WITHOUT touching the filesystem. The prompt checks a
 * path on every blur while the operator is still typing, so the default must not create
 * anything — an earlier revision did, and merely typing `…/settings.json` created a
 * directory with that name, which then broke writing the real settings file.
 */
export function isUsableDataDir(dir: string, opts: { create?: boolean } = {}): { ok: boolean; error?: string } {
  const create = opts.create !== false;
  if (create) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `cannot create folder: ${(err as Error).message}` };
    }
  } else if (!fs.existsSync(dir)) {
    // Does not exist yet: judge the nearest existing ancestor, since that is what a later
    // create would have to write into.
    let probe = path.dirname(path.resolve(dir));
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    try {
      fs.accessSync(probe, fs.constants.W_OK);
    } catch {
      return { ok: false, error: 'folder cannot be created there (parent is not writable)' };
    }
    return { ok: true };
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    return { ok: false, error: 'folder is not writable' };
  }
  if (!fs.statSync(dir).isDirectory()) {
    return { ok: false, error: 'a file already exists at this path' };
  }
  return { ok: true };
}

/**
 * True when `dir` would collide with the app's own settings file.
 *
 * A directory at `settings.json` cannot be written to, so choosing that path would break
 * settings permanently — including the record of the choice itself, which is why it must be
 * refused rather than accepted and then reported as an unwritable file later.
 */
export function dataDirCollidesWithSettings(dir: string): boolean {
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(settingsFile())) return true;
  // Also refuse a parent that would swallow the settings directory, e.g. choosing the
  // user profile itself puts data next to unrelated files and is almost always a misclick.
  const base = path.resolve(settingsBase());
  return base.startsWith(resolved + path.sep);
}

/**
 * Persists settings and reports whether it worked.
 *
 * `writeSettings` intentionally swallows failures — settings are best-effort and must never
 * take the service down. But a FIRST-RUN choice is not best-effort: reporting success while
 * the file was never written sends the operator into a restart that silently resolves to the
 * default folder, which looks identical to the choice being ignored.
 */
export function tryWriteSettings(s: Record<string, unknown>): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(settingsBase(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
    notifySettingsWrite();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// KEEP: Preserves existing data directory location across updates.
export const DATA_DIR = resolveDataDir();
export const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
export const CHROMIUM_DIR = path.join(DATA_DIR, 'chromium');
export const CHROMEDRIVER_DIR = path.join(DATA_DIR, 'chromedriver');
export const EXTENSIONS_DIR = path.join(DATA_DIR, 'extensions');
// KEEP: Preserves existing database filename antidetect.db.
export const DB_PATH = path.join(DATA_DIR, 'antidetect.db');

export const API_HOST = process.env.API_HOST || '127.0.0.1';
export const API_PORT = Number(process.env.API_PORT || 50325);

/**
 * Publisher's OAuth client, injected at build time. Empty when the build was not given one —
 * the UI then falls back to the per-operator Client ID fields, so a dev build still works.
 *
 * Why empty by default:
 * A placeholder string would break the fallback logic in `getGDriveCredentials()`, which relies
 * on an empty or missing value to detect that the build was not configured with a publisher
 * client. Without this check, a dev build would attempt OAuth against an invalid client ID rather
 * than letting the operator supply their own credentials in the UI.
 */
export const SHIPPED_GDRIVE_CLIENT_ID: string = (
  process.env.SHIPPED_GDRIVE_CLIENT_ID ||
  '609547936669-83dooobh9mvvba417kmnimc6rg3lr5ji.apps.googleusercontent.com'
).trim();

/**
 * The shipped client's secret, present only when the build was given one.
 *
 * Measured against live Google, twice, in opposite directions: without a secret the token
 * endpoint answers `invalid_request: client_secret is missing`, and with a secret belonging
 * to a DIFFERENT client it answers `invalid_client`. So the value injected here must be the
 * secret of the exact client in `SHIPPED_GDRIVE_CLIENT_ID` above — pairing is load-bearing.
 * It is never logged, never returned by status, and reaches Google only inside token bodies.
 *
 * No default is shipped on purpose: the value lives in the repository secret
 * `GDRIVE_CLIENT_SECRET`, and CI injects it into the build tree on the runner. A build
 * without it (forks, PRs) falls back to operator-entered credentials in Advanced.
 */
export const SHIPPED_GDRIVE_CLIENT_SECRET: string = (
  process.env.SHIPPED_GDRIVE_CLIENT_SECRET || ''
).trim();
/**
 * The running application version, read from package.json.
 *
 * Resolved by walking up from this file so it works both compiled (`dist/src/main`) and
 * from source, and falls back to a clearly-unknown marker rather than a plausible-looking
 * number: a health endpoint that reports a version it invented is worse than one that
 * admits it does not know.
 */
export const APP_VERSION: string = (() => {
  // The desktop shell knows its version exactly — Tauri injects it from tauri.conf.json at
  // build time — so it passes it down. That is the authoritative channel: the installed
  // artefact does NOT ship package.json, so reading the file worked in development and
  // returned "unknown" in the build the operator actually runs.
  const fromShell = process.env.ANTIDETECT_APP_VERSION;
  if (typeof fromShell === 'string' && fromShell.trim().length > 0) return fromShell.trim();

  // Standalone service (npm run service): walk up for package.json. Compiled output lives
  // under dist/src/main, so this climbs several levels.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Never invent a number: an endpoint reporting a version it made up is worse than one
  // that admits it does not know.
  return 'unknown';
})();

/**
 * Server mode: the service is deployed on a remote machine and reached through
 * a reverse proxy (Traefik) over VPN. Enables trusted non-loopback Host headers,
 * disables permissive CORS and enables request logging to DATA_DIR/server.log.
 */
export const SERVER_MODE = process.env.ANTIDETECT_SERVER_MODE === '1';

/** Extra Host headers accepted in server mode (comma-separated, host only). */
export const TRUSTED_HOSTS: string[] = (process.env.ANTIDETECT_TRUSTED_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter((h) => h.length > 0);

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** True when the request arrived through a public/trusted entry point. */
export function isRemoteHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const h = String(hostHeader);
  if (LOOPBACK_HOST_RE.test(h)) return false;
  if (!SERVER_MODE) return true;
  const bare = h.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  return TRUSTED_HOSTS.includes(bare);
}

for (const dir of [DATA_DIR, PROFILES_DIR, CHROMIUM_DIR, EXTENSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Current data directory (profiles, kernel, extensions, DB). */
export function getDataDir(): string {
  return DATA_DIR;
}

/**
 * Persist a new data directory. The change takes effect after the app restarts
 * (the backend resolves DATA_DIR at import time). Returns the new path.
 */
export function setDataDir(dir: string): string {
  // Claim the destination as well as recording it: Settings lets the operator name a folder that
  // does not exist yet, and the next launch would otherwise treat it as another machine's.
  markDataRoot(dir);
  const s = readSettings();
  s.dataDir = dir;
  writeSettings(s);
  return dir;
}

/** Read a single persisted setting (settings.json). */
/**
 * A value that came out of settings.json.
 *
 * JSON has no functions, no symbols and no `undefined`, so `unknown` was wider than the truth: it
 * forced every caller to re-derive the shape by hand and permitted the impossible. Naming the type
 * documents the boundary and lets a caller that knows better narrow once instead of guessing.
 */
export type SettingValue =
  | string
  | number
  | boolean
  | null
  | SettingValue[]
  | { [key: string]: SettingValue };

export function getSetting(key: string): SettingValue | undefined {
  return readSettings()[key];
}

/** Persist a single setting (takes effect immediately). */
export function setSetting(key: string, value: SettingValue): void {
  const s = readSettings();
  s[key] = value;
  writeSettings(s);
}

/**
 * Every persisted setting except these travels between machines.
 * Denylist must be a genuine safety boundary: exclude dataDir, dataMode,
 * syncPassphraseVerifier, every key starting gdrive:, plus any key that holds
 * a token/secret/port/host.
 */
export const SETTINGS_SYNC_DENYLIST: readonly string[] = Object.freeze([
  'dataDir',
  'dataMode',
  'syncPassphraseVerifier',
  'cloudToken',
  'syncToken',
  'licenseKey',
  'telegram_bot_token',
  'apiKey',
  'apiHost',
  'apiPort',
  'host',
  'port',
  'mcpBundleDir',
  'syncCustomUrl',
  'syncEndpointMode',
  'gdrive:clientId',
  'gdrive:clientSecret',
  'gdrive:refreshToken',
  'gdrive:folderId',
  'gdrive:lastPush',
  'gdrive:lastPull',
  'gdrive:userEmail',
  // Provenance label for the manifest; a second machine must keep its own, not inherit this one's.
  'syncDeviceId',
  'gdriveScope',
]);

/**
 * Property names that must never be written from an object literal.
 *
 * A remote settings payload is a `JSON.parse` result, and `setSetting` does `s[key] = value`. For
 * `__proto__` that assignment invokes the inherited setter and rebinds the settings object's
 * prototype, so every subsequent missing-key read in the same import returns the attacker's value.
 * Object.prototype itself is not polluted, but a silently wrong settings read is still a bug.
 */
const FORBIDDEN_SETTING_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

function isDenylistedSetting(key: string): boolean {
  if (SETTINGS_SYNC_DENYLIST.includes(key)) return true;
  if (key.startsWith('gdrive:')) return true;
  if (key.startsWith('teamKey:')) return true;
  if (key.startsWith('syncCursor:')) return true;
  const lower = key.toLowerCase();
  return (
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('port') ||
    lower.includes('host')
  );
}

/** Portable projection of settings.json, denylist applied. */
export function exportSyncableSettings(): Record<string, SettingValue> {
  const settings = readSettings();
  const result: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!isDenylistedSetting(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Whether a value that arrived from another machine may be written into settings.json.
 *
 * The payload is JSON parsed on the sending side and authenticated by the sync envelope, so this is
 * not a hostile-input defence — it is the boundary check that keeps the type honest. `undefined`,
 * functions and symbols cannot be serialised, and a value that is none of the permitted shapes is
 * skipped rather than written as something the next `JSON.stringify` would silently drop.
 */
function isSettingValue(value: unknown): value is SettingValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isSettingValue);
  if (t === 'object') return Object.values(value as Record<string, unknown>).every(isSettingValue);
  return false;
}

/** Merge a remote settings object in, denylist applied. Machine-local keys are never touched. */
export function importSyncableSettings(remote: Record<string, unknown>): number {
  if (!remote || typeof remote !== 'object') return 0;
  const current = readSettings();
  let written = 0;
  for (const [key, value] of Object.entries(remote)) {
    if (isDenylistedSetting(key) || FORBIDDEN_SETTING_KEYS.includes(key)) continue;
    if (!isSettingValue(value)) continue;
    if (isDeepStrictEqual(current[key], value)) continue;
    setSetting(key, value);
    current[key] = value;
    written += 1;
  }
  return written;
}

/**
 * Script catalog manifest URL (Sprint 4.4). Default stub ships empty so the
 * catalog starts disabled; users point it at their own GitHub raw manifest in
 * Settings. Env override wins for CI/server deployments.
 */
export const CATALOG_URL_DEFAULT = '';
export function getCatalogUrl(): string {
  const fromEnv = process.env.ANTIDETECT_CATALOG_URL;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const saved = getSetting('catalogUrl');
  return typeof saved === 'string' ? saved : CATALOG_URL_DEFAULT;
}

let cachedApiKey: string | null = null;

export function getApiKey(): string {
  if (cachedApiKey) return cachedApiKey;
  const keyFile = path.join(DATA_DIR, 'api_key');
  if (fs.existsSync(keyFile)) {
    cachedApiKey = fs.readFileSync(keyFile, 'utf8').trim();
  } else {
    cachedApiKey = randomUUID();
    fs.writeFileSync(keyFile, cachedApiKey, 'utf8');
  }
  return cachedApiKey;
}
/**
 * In Tauri mode the host injects ANTIDETECT_TARGET_RESOURCES_DIR so the
 * backend resolves bundled resources without referencing `process.resourcesPath`.
 * Returns null when unset or empty.
 */
export function targetResourcesDir(): string | null {
  const dir = process.env.ANTIDETECT_TARGET_RESOURCES_DIR?.trim();
  return dir && dir.length > 0 ? dir : null;
}

/**
 * Directories that may hold the fingerprint-chromium kernel, in priority order:
 * a packaged build ships it under resources/kernel, a dev/portable run keeps it
 * under the data dir.
 *
 * Exported so the executable lookup and the version report read the SAME list —
 * they previously disagreed, and a packaged app therefore launched fine while
 * Settings reported the kernel as missing.
 */
export function kernelBaseDirs(): string[] {
  const dirs: string[] = [];
  // Packaged app: kernel shipped inside resources/kernel (extraResources).
  const resDir = targetResourcesDir();
  if (resDir) {
    dirs.push(path.join(resDir, 'kernel', 'fingerprint-chromium'));
  }
  dirs.push(path.join(CHROMIUM_DIR, 'fingerprint-chromium'));
  return dirs;
}

/**
 * Locate the patched fingerprint-chromium executable.
 * Priority: CHROMIUM_PATH env -> packaged resources (targetResourcesDir/kernel) -> data dir.
 */
function findFingerprintChromium(): string | null {
  // Delegated to `kernelLayout`, which knows all THREE layouts (Windows' payload directory,
  // Linux's AppImage file, macOS's bundle). This function used to search for `chrome.exe` inside
  // every subdirectory, which matched Windows only: on Linux the AppImage is a file rather than a
  // directory, and on macOS the binary is inside `Chromium.app/Contents/MacOS/`. Both fell through
  // to a hardcoded `'chrome.exe'` and failed to spawn — a kernel installed and unusable.
  for (const base of kernelBaseDirs()) {
    const found = findKernelExecutable(base);
    if (found) return found;
  }
  return null;
}

/**
 * Locate the Camoufox (Firefox) executable under data/chromium/camoufox/extracted/camoufox.exe.
 */
function findCamoufox(): string | null {
  const candidate = path.join(CHROMIUM_DIR, 'camoufox', 'extracted', 'camoufox.exe');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve a Chromium/Chrome executable.
 * Priority: CHROMIUM_PATH env -> fingerprint-chromium build -> other builds under data/chromium
 * -> common system paths -> PATH.
 */
export function getChromiumPath(): string {
  if (process.env.CHROMIUM_PATH && process.env.CHROMIUM_PATH.length > 0) {
    return process.env.CHROMIUM_PATH;
  }

  const fingerprintKernel = findFingerprintChromium();
  if (fingerprintKernel) return fingerprintKernel;

  const candidates: string[] = [];

  // A second scan of the kernel dir for a SYSTEM-Chrome-like layout. The pattern is platform-aware
  // because the extension is not universal: `.exe` on Windows, a bare `chrome`/`chromium` on POSIX.
  // The original regex was `/…\.exe$/i`, which can never match a macOS or Linux binary.
  const systemBinary = process.platform === 'win32' ? /^(chrome|chromium|chrome-headless-shell)\.exe$/i : /^(chrome|chromium|chrome-headless-shell|Google Chrome)$/;
  try {
    const scan = (dir: string, depth: number): void => {
      if (depth > 5 || !fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full, depth + 1);
        } else if (systemBinary.test(entry.name)) {
          candidates.push(full);
        }
      }
    };
    scan(CHROMIUM_DIR, 0);
  } catch {
    // ignore scan errors
  }

  // The well-known install locations, per platform. These were Windows paths applied to every
  // platform — on macOS they were not merely useless, they made the function return
  // `C:\Program Files\…\chrome.exe` as if it existed.
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData\\Local');
    candidates.push(path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'));
    candidates.push(path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'));
    candidates.push(path.join(local, 'Google\\Chrome\\Application\\chrome.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }

  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return found;

  // Last resort: the name as it would be found on PATH.
  //
  // This used to be a hardcoded `'chrome.exe'` on EVERY platform. That string is what made the
  // macOS failure confusing: `launcher/chromium.ts` skips its own "binary not found" check when the
  // executable equals `'chrome.exe'`, so instead of a clear message the operator got a bare ENOENT
  // from `spawn`. The name is now the platform's own, and `launcher/chromium.ts` no longer treats
  // one magic string as "assume it is on PATH".
  return process.platform === 'win32' ? 'chrome.exe' : process.platform === 'darwin' ? 'Google Chrome' : 'google-chrome';
}

/** Resolve the Camoufox (Firefox) executable, or null if not installed. */
export function getCamoufoxPath(): string | null {
  if (process.env.CAMOUFOX_PATH && process.env.CAMOUFOX_PATH.length > 0) {
    return process.env.CAMOUFOX_PATH;
  }
  return findCamoufox();
}

/**
 * Locate chromedriver matching the kernel (Chromium 148) for Selenium via debuggerAddress.
 * Priority: CHROMEDRIVER_PATH env -> packaged resources -> data/chromedriver. Null if absent.
 */
export function getChromedriverPath(): string | null {
  if (process.env.CHROMEDRIVER_PATH && process.env.CHROMEDRIVER_PATH.length > 0) {
    return process.env.CHROMEDRIVER_PATH;
  }
  const candidates: string[] = [];
  const resDir = targetResourcesDir();
  if (resDir) candidates.push(path.join(resDir, 'chromedriver', 'chromedriver.exe'));
  candidates.push(path.join(CHROMEDRIVER_DIR, 'chromedriver.exe'));
  candidates.push(path.join(CHROMEDRIVER_DIR, 'chromedriver-win64', 'chromedriver.exe'));
  return candidates.find((c) => fs.existsSync(c)) ?? null;

}
