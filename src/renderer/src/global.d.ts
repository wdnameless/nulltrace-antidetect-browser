export {};

export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; info: UpdateInfo }
  | { state: 'not-available'; info: UpdateInfo }
  | { state: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { state: 'downloaded'; info: UpdateInfo }
  /** Staged and being applied: the portable swap is running, or the installer is launching. */
  | { state: 'installing' }
  | { state: 'error'; message: string };

/**
 * The raw payload the shell emits on `update:status` (`UpdateStatusEvent` in
 * `src-tauri/src/updater.rs`).
 *
 * It is NOT `UpdateStatus`. The Rust side reports the plugin's vocabulary —
 * `checking-for-update` / `update-not-available` / `update-available` / `download-progress` /
 * `update-downloaded` / `error` — and carries progress in a nested `progress` object. Two
 * defects came from treating the two as the same shape: the footer landed every state as
 * `undefined` and reported a failure no matter what happened, and Settings switched on
 * `'available'`/`'downloading'`, strings the shell never sends, so its update panel rendered
 * nothing and its Download/Restart buttons were unreachable. `normalizeUpdateStatus` is the
 * single translation point; both consumers go through it.
 */
export interface UpdateStatusEventPayload {
  state: string;
  message?: string;
  info?: UpdateInfo;
  progress?: { transferred: number; total: number; percent: number } | null;
}

export interface UpdateInfo {
  version?: string;
  files?: Array<{ url?: string }>;
  releaseDate?: string;
  releaseNotes?: string;
}

declare global {
  const __APP_VERSION__: string;
  interface Window {
    antidetect?: {
      getApiKey: () => Promise<string>;
      licenseRefresh?: () => Promise<unknown>;
      /** Open a URL with the system handler — bridge.js exposes this as `openExternal`. */
      openExternal?: (url: string) => Promise<unknown>;
      /** Opens (or focuses) a standalone OS window for one Android profile. Absent outside Tauri. */
      openAndroidWindow?: (profileId: string) => Promise<{ ok: boolean; error?: string | null }>;
      data: {
        getDir: () => Promise<string>;
        setDir: () => Promise<{ ok: boolean; dir: string }>;
        /**
         * Ask the shell for a folder. The three outcomes are distinguishable on purpose:
         * `ok` chose one, `canceled` means the operator backed out, and `error` (with
         * `canceled:false`) means the dialog could not run at all.
         */
        prepareDir: () => Promise<{
          ok: boolean;
          canceled: boolean;
          dir: string;
          error: string;
        }>;
        migrateDir: (target: string, migrateData: boolean) => Promise<{ ok: boolean; dir: string; migrated?: boolean; error?: string }>;
        setDirPath: (dir: string) => Promise<{ ok: boolean; dir: string }>;
        openDir: () => Promise<string>;
        /**
         * Restart the shell so a persisting change takes effect — the data directory is
         * resolved once by the backend at startup, so relocating it cannot apply in place.
         * Absent in a browser client, which the caller must tolerate.
         */
        restart: () => Promise<{ ok: boolean; error?: string }>;
      };
      logs?: {
        openDir: () => Promise<string>;
      };
      update: {
        check: () => Promise<void>;
        download: () => Promise<void>;
        quitAndInstall: () => Promise<void>;
        /**
         * Receives the shell's raw `update:status` payload — NOT `UpdateStatus`. Pass it through
         * `normalizeUpdateStatus` before rendering; the two vocabularies differ.
         */
        onStatus: (cb: (status: UpdateStatusEventPayload) => void) => () => void;
      };
      /**
       * Frameless window controls. Present only in the Electron shell — a browser
       * client has no such bridge, so the renderer must detect it before rendering
       * any control rather than showing dead buttons.
       */
      window?: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
      };
    };
  }
}
