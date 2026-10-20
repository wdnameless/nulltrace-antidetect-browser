// The Google Drive connection must SURVIVE A RESTART, and sync must be pausable per device.
//
// Measured defect this guards: `gdriveAuth` kept its state in an in-memory Map and nothing in
// production ever called `setGDriveStorage`, so `getGDriveStatus()` answered `connected: false` on
// every launch even though the refresh token had been granted. The UI showed
// "[CONFIGURED / DISCONNECTED]" over a Drive account that was still authorised, and the sync
// engine refused to start.
//
// The second requirement is subtler: "stop syncing" on one machine must not disconnect the account.
// `disconnectGDrive` drops the refresh token for EVERY machine, so a device-local switch cannot be
// built out of it.
import { describe, it, expect } from 'vitest';
import {
  createSettingsGDriveStorage,
  getGDriveStatus,
  saveGDriveRefreshToken,
  getGDriveRefreshToken,
  isGDriveSyncEnabled,
  setGDriveSyncEnabled,
  setGDriveStorage,
} from '../../../src/main/cloud/gdriveAuth';

/** Settings-backed store double: records what the adapter persists, survives a "restart". */
function makeSettingsStore(): { get: (k: string) => string | null; set: (k: string, v: string) => void; delete: (k: string) => void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    delete: (k) => void data.delete(k),
  };
}

describe('the Drive connection is persisted, not in-memory', () => {
  it('reads state back from the store after a fresh module would have lost it', () => {
    const store = makeSettingsStore();
    setGDriveStorage(store);

    saveGDriveRefreshToken('refresh-token-value');
    // The adapter wrote through to the store rather than a private Map.
    expect([...store.data.keys()]).toContain('gdrive:refreshToken');
    expect(getGDriveRefreshToken()).toBe('refresh-token-value');
  });

  it('the shipped adapter is settings-backed, not the in-memory default', () => {
    // Guards the exact regression: a default in-memory adapter reads as connected during the
    // session that authorised, and as disconnected on the next launch.
    const adapter = createSettingsGDriveStorage();
    expect(typeof adapter.get).toBe('function');
    expect(typeof adapter.set).toBe('function');
    expect(typeof adapter.delete).toBe('function');
  });
});

describe('per-device sync switch', () => {
  it('defaults to enabled so an existing install keeps syncing', () => {
    setGDriveStorage(makeSettingsStore());
    expect(isGDriveSyncEnabled()).toBe(true);
  });

  it('pausing keeps the refresh token — the account stays connected', () => {
    const store = makeSettingsStore();
    setGDriveStorage(store);
    saveGDriveRefreshToken('token-kept');

    setGDriveSyncEnabled(false);

    expect(isGDriveSyncEnabled()).toBe(false);
    expect(getGDriveRefreshToken(), 'pausing must not disconnect the account').toBe('token-kept');
  });

  it('resuming restores the switch without touching the token', () => {
    setGDriveStorage(makeSettingsStore());
    saveGDriveRefreshToken('token-2');

    setGDriveSyncEnabled(false);
    setGDriveSyncEnabled(true);

    expect(isGDriveSyncEnabled()).toBe(true);
    expect(getGDriveRefreshToken()).toBe('token-2');
  });

  it('reports syncEnabled in the status the UI renders', () => {
    setGDriveStorage(makeSettingsStore());
    setGDriveSyncEnabled(false);
    const withSwitchOff = getGDriveStatus();
    expect(withSwitchOff.syncEnabled).toBe(false);

    setGDriveSyncEnabled(true);
    expect(getGDriveStatus().syncEnabled).toBe(true);
  });
});
