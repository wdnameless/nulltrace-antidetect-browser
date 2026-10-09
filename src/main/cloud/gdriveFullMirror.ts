// The opt-in "full mirror" facade: Zone B's frozen entry point for profile-directory sync.
//
// This module owns the operator-facing switch and the Drive-facing names, while the collection and
// framing rules live in `profileArchive.ts`. The split is deliberate: the archive module holds one
// exclusion policy that must never fork, and this file holds the on/off state and the progress
// contract the UI and the sync engine call.
//
// Both tiers are OFF by default. The measured reason is in `profileArchive.ts` and reproduced in
// the UI: the profile directories are 785 MB on a real install, of which 759.8 MB is regenerated
// cache and 1.75 MB is the site state that actually carries a login. Turning this on without the
// operator understanding that would be a silent quota burn.

import { getSetting, setSetting } from '../config';
import {
  buildProfileArchive,
  restoreProfileArchive,
  type MirrorProgress,
  type MirrorResult,
} from './profileArchive';
import {
  GDRIVE_MIRROR_FILE,
  ensureSyncFolder,
  getGDriveTransport,
  validateSyncFolder,
} from './gdriveTransfer';
import { sealPayload, openPayload } from './syncCrypto';

const MIRROR_ENABLED_KEY = 'gdriveFullMirrorEnabled';

/** Whether the operator turned the full directory mirror on. Off unless explicitly enabled. */
export function isMirrorEnabled(): boolean {
  return getSetting(MIRROR_ENABLED_KEY) === true;
}

/** Persist the choice. Enabling it does NOT start a run — the engine picks it up on its next pass. */
export function setMirrorEnabled(enabled: boolean): void {
  setSetting(MIRROR_ENABLED_KEY, enabled);
}

export type { MirrorProgress, MirrorResult };

/**
 * Discover the sync folder and refuse it when it is not ours.
 *
 * The data cycle validates before writing; the mirror writes the same folder, so it must apply the
 * same rule. Otherwise enabling the mirror quietly defeats a refusal the user was just shown.
 */
async function validatedSyncFolder(): Promise<string> {
  const folderId = await ensureSyncFolder();
  const validation = await validateSyncFolder(folderId);
  if (!validation.ok) {
    throw new Error(`Google Drive mirror refused: ${validation.reason}`);
  }
  return folderId;
}

/** Canonical mirror filename re-exported from gdriveTransfer to prevent configuration fork. */
export { GDRIVE_MIRROR_FILE };

/**
 * Upload the archive to the sync folder.
 *
 * This is what makes the mirror switch do something. An earlier revision of the route built the
 * archive, reported its size, and dropped the bytes — the operator saw "completed: 21 MB" while
 * Drive received nothing, which is worse than an error because it reads as success. The upload is
 * sealed with the same envelope as the data payloads: it contains `Local Storage` and `IndexedDB`,
 * which hold session tokens in plaintext on disk.
 *
 * Returns the uploaded byte count so the caller reports what actually left the machine.
 */
export async function uploadMirrorArchive(
  passphrase: string,
  profileIds: string[] | null = null,
  siteStateOnly = true
): Promise<{ bytes: number; fileCount: number; skipped: Array<{ profileId: string; reason: string }> }> {
  const built = siteStateOnly
    ? buildProfileArchive(profileIds, true)
    : buildProfileArchive(profileIds, false);

  const folderId = await validatedSyncFolder();
  const sealed = sealPayload(passphrase, built.blob);
  const transport = getGDriveTransport();
  const existing = (await transport.listFiles(folderId)).find((f) => f.name === GDRIVE_MIRROR_FILE);

  // Raw Buffer upload enables HttpGDriveTransport to trigger chunked resumable upload for archives >5 MB.
  await transport.uploadFile(GDRIVE_MIRROR_FILE, sealed, folderId, existing?.id);

  return { bytes: sealed.length, fileCount: built.fileCount, skipped: built.skipped };
}

/**
 * Download and restore the archive from the sync folder.
 *
 * `siteStateOnly` is ignored on the read path: the uploaded blob describes itself, so the same
 * function restores either tier.
 */
export async function downloadMirrorArchive(
  passphrase: string
): Promise<{ restoredProfiles: number; fileCount: number }> {
  const folderId = await validatedSyncFolder();
  const transport = getGDriveTransport();
  const found = (await transport.listFiles(folderId)).find((f) => f.name === GDRIVE_MIRROR_FILE);
  if (!found) {
    throw new Error(`no ${GDRIVE_MIRROR_FILE} in the Drive folder`);
  }

  // Download raw bytes directly without corrupting binary data with utf8-fallback.
  if (typeof transport.downloadBuffer !== 'function') {
    throw new Error('GDrive transport does not support binary buffer download');
  }
  const bytes = await transport.downloadBuffer(found.id);
  const plain = openPayload(passphrase, bytes);
  return restoreProfileArchive(plain);
}

/**
 * Build the archive for the given profiles (all live profiles when null) and hand back the bytes
 * for upload.
 *
 * `siteStateOnly` is the cheap tier: the ~1.75 MB of Local Storage / IndexedDB / cookies /
 * sessions, without the 23 MB of Chromium bookkeeping. The full tier adds everything that is not
 * a regenerated cache. Neither tier reads a running profile.
 */
export function createMirrorArchive(
  profileIds: string[] | null,
  onProgress?: (p: MirrorProgress) => void
): Promise<MirrorResult> {
  return Promise.resolve().then(() => {
    const { blob, fileCount, excluded, skipped } = buildProfileArchive(profileIds, false);
    onProgress?.({ files: fileCount, totalFiles: fileCount, uploadedBytes: blob.length });
    return {
      archiveBytes: blob.length,
      fileCount,
      skipped,
      excluded,
      // Returned so the caller can upload it; the frozen `MirrorResult` shape describes the report,
      // and the bytes travel with it rather than through a module-level cache (which would hold a
      // 25 MB buffer alive between calls).
      blob,
    } as MirrorResult & { blob: Buffer };
  });
}

/**
 * The small tier: site state only. This is the one worth enabling for an operator who wants their
 * logins on a second machine without moving a Chromium bookkeeping tree.
 */
export function createSiteStateArchive(
  profileIds: string[] | null,
  onProgress?: (p: MirrorProgress) => void
): Promise<MirrorResult & { blob: Buffer }> {
  return Promise.resolve().then(() => {
    const { blob, fileCount, excluded, skipped } = buildProfileArchive(profileIds, true);
    onProgress?.({ files: fileCount, totalFiles: fileCount, uploadedBytes: blob.length });
    return { archiveBytes: blob.length, fileCount, skipped, excluded, blob };
  });
}

/**
 * Restore a previously uploaded archive onto this machine.
 *
 * The database rows must already be imported by the caller: a profile directory without its
 * metadata row is invisible to the product, and metadata without the directory opens an empty
 * profile. Refuses to write outside the profile root (see `restoreProfileArchive`).
 */
export function restoreMirrorArchive(
  archive: Buffer,
  onProgress?: (p: MirrorProgress) => void
): Promise<{ restoredProfiles: number }> {
  return Promise.resolve().then(() => {
    const { restoredProfiles, fileCount } = restoreProfileArchive(archive);
    onProgress?.({ files: fileCount, totalFiles: fileCount, uploadedBytes: archive.length });
    return { restoredProfiles };
  });
}
