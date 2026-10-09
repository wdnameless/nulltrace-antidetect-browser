/**
 * Google Drive sync engine.
 *
 * The engine's whole job is deciding WHEN a sync cycle runs; the cycle itself lives in
 * `gdriveTransfer.runSyncCycle`. Five triggers, all funneling through one debounced, collapsed
 * worker:
 *
 * - `change`  — a write landed in the database or in settings. Subscribed, not polled, so nothing
 *               can mutate data without the engine noticing. This is the trigger that was declared
 *               but never had a producer, which is why "syncs automatically" was not true.
 * - `launch`  — app started: pull whatever the other machines left.
 * - `timer`   — periodic sweep, catching a machine that was asleep when a change happened.
 * - `manual`  — the operator pressed "Sync now".
 * - `exit`    — a final push, so a change made seconds before closing is not lost.
 *
 * Guarantees:
 *
 * 1. **Collapsing.** A burst of writes produces one sync. A trigger arriving mid-flight is queued as
 *    a single trailing run, never as a second concurrent upload racing the first on Drive.
 * 2. **Non-throwing.** Background triggers never reject. Failures land in `lastError` and in the
 *    `sync_log` table, so a sync that quietly stopped working is visible instead of silent.
 * 3. **Passphrase gating.** The payload is encrypted with the operator's passphrase, so a locked
 *    session cannot sync. The passphrase lives in memory only, never on disk and never in a log.
 */

import { getGDriveStatus, getGDriveTimestamps, getGDriveFolderId } from './gdriveAuth';
import { getSetting, setSetting } from '../config';
import { onDbWrite } from '../db';
import { onSettingsWrite } from '../config';
import { getDb } from '../db';
import {
  checkPassphraseVerifier,
  makePassphraseVerifier,
  openPayload,
  SyncDecryptError,
} from './syncCrypto';
import {
  isMirrorEnabled,
  uploadMirrorArchive,
  downloadMirrorArchive,
} from './gdriveFullMirror';
import { GDRIVE_FOLDER_NAME, GDRIVE_MIRROR_FILE, ensureSyncFolder, getGDriveTransport } from './gdriveTransfer';
import * as transfer from './gdriveTransfer';

export type SyncTrigger = 'launch' | 'change' | 'timer' | 'exit' | 'manual';

export interface SyncStatus {
  connected: boolean;
  account: string | null;
  /** true once the operator has unlocked the passphrase for this session. */
  unlocked: boolean;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  /** Rows a pull would bring in that have not been applied yet. */
  pendingRemoteChanges: number;
  /** Rows changed on both sides since the last sync. */
  conflicts: number;
  mirrorEnabled: boolean;
  /** The Drive folder every byte of sync traffic goes through, so the operator can see it. */
  folderName: string | null;
  /** When the last post-write integrity verification succeeded. */
  lastVerifiedAt: number | null;
}

export interface SyncLogEntry {
  id: number;
  at: number;
  direction: string;
  outcome: string;
  rowsPushed: number;
  rowsPulled: number;
  conflicts: number;
  error: string | null;
}

// In-memory session state (strictly ephemeral, never persisted to disk or DB)
let sessionPassphrase: string | null = null;
let sessionUnlocked = false;
let pendingPassphrase: string | null = null;

// Engine state
let engineStarted = false;
let isSyncing = false;
let lastSyncAt: number | null = null;
let lastError: string | null = null;
let pendingRemoteChanges = 0;
let conflictCount = 0;
let lastVerifiedAt: number | null = null;
let lastMirrorRestoreAt: number | null = null;

// Concurrency control: collapsing in-flight work and debouncing bursts
let debounceTimer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<void> | null = null;
let queuedTrigger: SyncTrigger | null = null;
let periodicTimer: NodeJS.Timeout | null = null;
let unsubscribeDb: (() => void) | null = null;
let unsubscribeSettings: (() => void) | null = null;

const DEBOUNCE_DELAY_MS = 3000;
const PERIODIC_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * A background sync that fails must not stop the engine.
 *
 * Backoff is exponential and capped: a machine offline for an hour retries every ~8 minutes rather
 * than every 3 seconds, so a laptop in a tunnel is not hammering Drive the whole way.
 */
const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
let consecutiveFailures = 0;

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

/**
 * Record one run.
 *
 * Kept in SQLite rather than a log file because the question an operator actually asks is "what
 * happened to my sync", and they ask it while the app is open, next to the status panel.
 */
function logRun(entry: {
  direction: string;
  outcome: 'ok' | 'failed';
  rowsPushed?: number;
  rowsPulled?: number;
  conflicts?: number;
  error?: string | null;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO sync_log (at, direction, outcome, rows_pushed, rows_pulled, conflicts, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        entry.direction,
        entry.outcome,
        entry.rowsPushed ?? 0,
        entry.rowsPulled ?? 0,
        entry.conflicts ?? 0,
        entry.error ?? null
      );
  } catch {
    // The log is diagnostics: never let it break a sync.
  }
}

export function getSyncLog(limit = 100): SyncLogEntry[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, at, direction, outcome, rows_pushed, rows_pulled, conflicts, error
           FROM sync_log ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as Array<{
      id: number;
      at: number;
      direction: string;
      outcome: string;
      rows_pushed: number;
      rows_pulled: number;
      conflicts: number;
      error: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      direction: r.direction,
      outcome: r.outcome,
      rowsPushed: r.rows_pushed,
      rowsPulled: r.rows_pulled,
      conflicts: r.conflicts,
      error: r.error,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Current sync state. Safe to call at any time; never throws.
 */
export function getSyncStatus(): SyncStatus {
  const gdrive = getGDriveStatus();
  const connected = Boolean(gdrive.connected);

  let effectiveLastSync = lastSyncAt;
  if (effectiveLastSync === null) {
    const { lastPush, lastPull } = getGDriveTimestamps();
    const maxTs = Math.max(lastPush ?? 0, lastPull ?? 0);
    if (maxTs > 0) effectiveLastSync = maxTs;
  }

  return {
    connected,
    account: gdrive.email || null,
    unlocked: sessionUnlocked,
    syncing: isSyncing,
    lastSyncAt: effectiveLastSync,
    lastError,
    pendingRemoteChanges,
    conflicts: conflictCount,
    mirrorEnabled: isMirrorEnabled(),
    folderName: getGDriveFolderId() ? GDRIVE_FOLDER_NAME : null,
    lastVerifiedAt,
  };
}

export function isUnlocked(): boolean {
  return sessionUnlocked;
}

/**
 * Record an out-of-band sync outcome for the status panel.
 *
 * Needed because authorization completes AFTER the HTTP request that started it has been answered:
 * the operator's approval arrives at a loopback listener minutes later, and without a way to write
 * the result down, a failed connect would be completely silent — the button would appear to do
 * nothing while the app waited for a token it never got.
 */
export function setSyncError(message: string | null): void {
  lastError = message;
  logRun({ direction: 'authorize', outcome: message ? 'failed' : 'ok', error: message });
}

export function getSessionPassphrase(): string | null {
  return sessionPassphrase;
}

/**
 * Stash a passphrase across a multi-step device-code authorisation, so the engine can unlock the
 * instant the token exchange completes instead of making the operator type it twice.
 */
export function setPendingPassphrase(passphrase: string): void {
  pendingPassphrase = passphrase;
}

export function getPendingPassphrase(): string | null {
  return pendingPassphrase;
}

export function clearPendingPassphrase(): void {
  pendingPassphrase = null;
}

/** Drop every in-memory secret and stop the engine. Called on disconnect and on credential reset. */
export function clearSyncSession(): void {
  sessionPassphrase = null;
  sessionUnlocked = false;
  pendingPassphrase = null;
  transfer.setSyncPassphrase(null);
  lastError = null;
  conflictCount = 0;
  stopSyncEngine();
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

/**
 * Unlock the engine for this session.
 *
 * Verification order:
 * 1. A local verifier (a sealed canary, no secret data) if one exists — no network round-trip.
 * 2. Otherwise test-decrypt the remote payload, which is what a second machine must do: it has no
 *    verifier yet and has no other way to learn whether the passphrase is right.
 * 3. If neither exists — a brand-new install — accept the passphrase as the initial master secret.
 *
 * Security invariant: the plaintext passphrase is held only in `sessionPassphrase` for the lifetime
 * of this process. It is never written to disk, settings.json, the database, or a log line.
 */
export async function unlockSession(passphrase: string): Promise<boolean> {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    return false;
  }

  const trimmed = passphrase.trim();
  const storedVerifier = getSetting('syncPassphraseVerifier');

  if (typeof storedVerifier === 'string' && storedVerifier.length > 0) {
    if (!checkPassphraseVerifier(trimmed, Buffer.from(storedVerifier, 'base64'))) {
      logRun({ direction: 'unlock', outcome: 'failed', error: 'wrong passphrase' });
      return false;
    }
  } else if (getGDriveStatus().connected) {
    // Second machine: the only evidence available is whether the remote payload opens.
    try {
      const verification = await transfer.verifyRemoteState(trimmed);
      if (!verification.ok && /no sync data/i.test(verification.reason ?? '')) {
        // Empty folder: nothing to verify against, so this passphrase becomes the master secret.
      } else if (!verification.ok) {
        logRun({ direction: 'unlock', outcome: 'failed', error: verification.reason });
        return false;
      }
    } catch (err) {
      if (err instanceof SyncDecryptError) {
        logRun({ direction: 'unlock', outcome: 'failed', error: 'wrong passphrase' });
        return false;
      }
      // A network blip is not evidence of a wrong passphrase — falling through would let anyone
      // "unlock" by unplugging the cable.
      return false;
    }
  }

  try {
    setSetting('syncPassphraseVerifier', makePassphraseVerifier(trimmed).toString('base64'));
  } catch {
    // Non-fatal: the verifier can be regenerated on the next unlock.
  }

  sessionPassphrase = trimmed;
  sessionUnlocked = true;
  lastError = null;
  transfer.setSyncPassphrase(trimmed);

  if (engineStarted) {
    requestSync('launch');
  } else {
    startSyncEngine();
  }
  logRun({ direction: 'unlock', outcome: 'ok' });
  return true;
}

/**
 * Change the sync passphrase.
 *
 * There is no re-encrypt pass: the payload is assembled from local data on every push, so switching
 * the key and pushing once produces a complete revision under the new passphrase, and the old
 * revisions are pruned. The current passphrase is verified first — otherwise anyone who can reach
 * the settings page could take the folder over.
 */
export async function changePassphrase(
  current: string,
  next: string
): Promise<{ changed: boolean; reason?: string }> {
  if (!next || next.trim().length < 8) {
    return { changed: false, reason: 'the new passphrase must be at least 8 characters' };
  }
  if (!(await unlockSession(current))) {
    return { changed: false, reason: 'the current passphrase is not correct' };
  }

  const trimmed = next.trim();
  sessionPassphrase = trimmed;
  transfer.setSyncPassphrase(trimmed);
  setSetting('syncPassphraseVerifier', makePassphraseVerifier(trimmed).toString('base64'));

  try {
    await runCycle('manual');
    logRun({ direction: 'passphrase', outcome: 'ok' });
    return { changed: true };
  } catch (err) {
    const reason = (err as Error).message;
    logRun({ direction: 'passphrase', outcome: 'failed', error: reason });
    return { changed: false, reason };
  }
}

/** Re-download the committed revision and check its digest. */
export async function verifyRemoteState(): Promise<{
  ok: boolean;
  revision: string;
  reason?: string;
}> {
  const result = await transfer.verifyRemoteState(sessionPassphrase ?? undefined);
  if (result.ok) {
    lastVerifiedAt = Date.now();
    logRun({ direction: 'verify', outcome: 'ok' });
  } else {
    logRun({ direction: 'verify', outcome: 'failed', error: result.reason });
  }
  return result;
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

async function runCycle(reason: SyncTrigger): Promise<void> {
  if (!getGDriveStatus().connected) {
    lastError = 'Google Drive is not connected';
    return;
  }
  if (!sessionUnlocked || !sessionPassphrase) {
    lastError =
      reason === 'manual'
        ? 'Google Drive sync is locked. Please enter your passphrase.'
        : (lastError ?? null);
    return;
  }

  try {
    // Look before writing: the operator should see what a pull would do without triggering one.
    const inspection = await transfer.inspectGDrivePull(sessionPassphrase);
    pendingRemoteChanges = inspection.newRows;
    conflictCount = inspection.conflicts.length;

    const result = await transfer.runSyncCycle({
      passphrase: sessionPassphrase,
      conflictResolution: 'keep_local',
    });

    pendingRemoteChanges = 0;
    conflictCount = result.conflicts;
    lastSyncAt = result.timestamp;
    lastError = result.verified ? null : 'sync committed but post-write verification failed';
    if (result.verified) lastVerifiedAt = Date.now();
    consecutiveFailures = 0;

    logRun({
      direction: reason,
      outcome: result.verified ? 'ok' : 'failed',
      rowsPushed: result.pushedRows,
      rowsPulled: result.pulledProfiles + result.pulledScripts + result.pulledVault,
      conflicts: result.conflicts,
      error: result.verified ? null : lastError,
    });

    if (isMirrorEnabled()) {
      await syncMirror();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = message;
    consecutiveFailures += 1;
    logRun({ direction: reason, outcome: 'failed', error: message });
  }
}

/**
 * Two-way mirror for the opt-in profile-directory tiers.
 *
 * The order is the whole design. Uploading first and downloading after would hand each machine back
 * its OWN bytes: B would overwrite A's site state on upload and then restore B, so nothing ever
 * crossed machines and A's archive was gone from Drive. So the remote is read and restored FIRST, and
 * this machine's own archive is published only when it is genuinely newer than what it just restored.
 *
 * Every failure here is confined to the mirror: the data cycle has already committed by the time this
 * runs, and a broken archive must never mark a successful data sync as failed.
 */
async function syncMirror(): Promise<void> {
  const passphrase = sessionPassphrase ?? '';
  try {
    const remoteStamp = await peekMirrorStamp();
    const restored =
      remoteStamp !== null && (lastMirrorRestoreAt === null || remoteStamp > lastMirrorRestoreAt)
        ? await downloadMirrorArchive(passphrase)
        : null;
    if (restored) lastMirrorRestoreAt = remoteStamp;

    await uploadMirrorArchive(passphrase, null, true);
    lastMirrorRestoreAt = Date.now();

    logRun({
      direction: 'mirror',
      outcome: 'ok',
      rowsPulled: restored?.restoredProfiles ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = message;
    logRun({ direction: 'mirror', outcome: 'failed', error: message });
  }
}

/** When the shared mirror file was last written, or `null` when the folder holds none. */
async function peekMirrorStamp(): Promise<number | null> {
  const found = (await getGDriveTransport().listFiles(await ensureSyncFolder())).find(
    (f) => f.name === GDRIVE_MIRROR_FILE
  );
  return found?.modifiedTime ? Date.parse(found.modifiedTime) : null;
}

/** Manual mirror restore, exposed for the "pull site state" action in the UI. */
export async function pullMirrorNow(): Promise<{
  restoredProfiles: number;
  fileCount: number;
}> {
  const result = await downloadMirrorArchive(sessionPassphrase ?? '');
  lastMirrorRestoreAt = Date.now();
  logRun({ direction: 'mirror', outcome: 'ok', rowsPulled: result.restoredProfiles });
  return result;
}

export function getLastMirrorRestoreAt(): number | null {
  return lastMirrorRestoreAt;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Ask for a sync.
 *
 * `change` is debounced: a batch import touches hundreds of rows in a second, and syncing on each
 * one would upload the same payload hundreds of times.
 */
export function requestSync(reason: SyncTrigger): Promise<void> | void {
  try {
    if (reason === 'change') {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (engineStarted) {
          executeSync('change').catch(() => {});
        }
      }, DEBOUNCE_DELAY_MS);
      if (debounceTimer.unref) debounceTimer.unref();
      return;
    }

    // A manual request while locked should tell the operator why nothing happened, rather than
    // appearing to do nothing at all.
    if (reason === 'manual' && !sessionUnlocked) {
      lastError = 'Google Drive sync is locked. Please enter your passphrase.';
      return;
    }
    return executeSync(reason);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Collapse concurrent requests into one in-flight run plus a single trailing run.
 *
 * Two uploads racing each other on the same Drive files is the failure mode this exists to prevent:
 * the loser overwrites the winner's payload and the manifest then names a revision nobody can read.
 */
async function executeSync(reason: SyncTrigger): Promise<void> {
  if (!engineStarted) {
    queuedTrigger = null;
    return;
  }

  if (inFlightPromise) {
    queuedTrigger = reason;
    return inFlightPromise;
  }

  isSyncing = true;
  inFlightPromise = (async () => {
    try {
      await runCycle(reason);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      isSyncing = false;
      inFlightPromise = null;

      if (engineStarted && queuedTrigger) {
        const next = queuedTrigger;
        queuedTrigger = null;
        executeSync(next).catch(() => {});
      }
    }
  })();

  return inFlightPromise;
}

/**
 * Start the engine: subscribe to writes, arm the periodic sweep, and pull on launch.
 *
 * Idempotent. When Drive is not connected it returns without arming anything; `unlockSession` calls
 * back in once the operator connects.
 */
export function startSyncEngine(): void {
  if (engineStarted) return;

  if (!getGDriveStatus().connected) {
    return;
  }

  engineStarted = true;

  if (!periodicTimer) {
    periodicTimer = setInterval(() => {
      // A machine that was asleep when a change happened elsewhere gets it here. Backoff after a
      // failure keeps a dead connection from retrying every 15 minutes' worth of nothing.
      if (consecutiveFailures > 0) {
        const delay = RETRY_BACKOFF_MS[Math.min(consecutiveFailures - 1, RETRY_BACKOFF_MS.length - 1)];
        if (Date.now() - (lastSyncAt ?? 0) < delay) return;
      }
      requestSync('timer');
    }, PERIODIC_SYNC_INTERVAL_MS);
    if (periodicTimer.unref) periodicTimer.unref();
  }

  // The change trigger. Two chokepoints, so no mutation anywhere in the app can slip past: every
  // write reaches either the database handle or the settings store.
  unsubscribeDb = onDbWrite(() => requestSync('change'));
  unsubscribeSettings = onSettingsWrite(() => requestSync('change'));

  if (sessionUnlocked) {
    requestSync('launch');
  }
}

/** Stop the engine and release both subscriptions. Called during graceful shutdown. */
export function stopSyncEngine(): void {
  engineStarted = false;
  clearInterval(periodicTimer ?? undefined);
  periodicTimer = null;
  clearTimeout(debounceTimer ?? undefined);
  debounceTimer = null;
  unsubscribeDb?.();
  unsubscribeDb = null;
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  queuedTrigger = null;
  inFlightPromise = null;
  isSyncing = false;
}

// Re-exported so callers that already import the crypto helper keep working after the engine gained
// its own passphrase handling.
export { openPayload };