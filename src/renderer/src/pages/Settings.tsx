import { useEffect, useState } from 'react';
import { getApiBase, api } from '../api';
import type { UpdateStatus } from '../global';
import { isUpdatesUnconfigured, normalizeUpdateStatus } from '../updateStatus';
import { useI18n, type Lang } from '../i18n';
import { SettingsIcon, RefreshIcon, CopyIcon, CheckIcon } from '../icons';
import { SyncSettings } from './SyncSettings';
import { LicenseSettings } from './LicenseSettings';
import { SecuritySettings } from './SecuritySettings';

function AndroidEngineSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<import('../api').AndroidEngineStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.androidEngine();
      if (res.code === 0 && res.data) setStatus(res.data);
      else setError(res.msg || 'Failed to load engine status');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const install = async () => {
    setInstalling(true);
    setError('');
    try {
      const res = await api.androidEngineInstall();
      if (res.code !== 0) setError(res.msg || 'Engine installation failed');
      else await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };
  return (
    <div className="panel">
      <div className="panel-header">{t('Android Engine')}</div>
      <div className="setting-row">
        <span className="setting-label">{t('Status')}</span>
        <strong style={{ color: status?.installed ? 'var(--ok)' : 'var(--warn)' }}>
          {loading ? t('Loading…') : status?.installed ? t('Installed') : t('Not Installed')}
        </strong>
      </div>
      {status?.platform ? (
        <div className="setting-row">
          <span className="setting-label">{t('Platform')}</span>
          <span>{status.platform.host} · {status.platform.abi} ({status.platform.backends.join(', ')})</span>
        </div>
      ) : null}
      {status?.installedApiLevels && status.installedApiLevels.length > 0 ? (
        <div className="setting-row">
          <span className="setting-label">{t('System Image')}</span>
          <span>API {status.installedApiLevels.join(', ')}</span>
        </div>
      ) : null}
      {error ? <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p> : null}
      <div className="setting-row">
        <span className="setting-label">{t('Actions')}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={() => void load()} disabled={loading || installing}>
            {t('Refresh')}
          </button>
          {!status?.installed ? (
            <button type="button" className="btn btn-primary" onClick={() => void install()} disabled={installing || loading}>
              {installing ? t('Installing…') : t('Install Engine')}
            </button>
          ) : null}
        </div>
      </div>
      <p className="hint">
        {t('The emulator binaries and system image are acquired on demand to keep the application lightweight.')}
      </p>
    </div>
  );
}

function TelegramSettings() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [chatIdsInput, setChatIdsInput] = useState('');
  const [tokenVisible, setTokenVisible] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [events, setEvents] = useState<Record<string, boolean>>({
    'profile.started': true,
    'profile.stopped': true,
    'profile.created': true,
    'profile.deleted': true,
    'taskgroup.finished': true,
    'agent.activity': false,
  });
  const [toastsEnabled, setToastsEnabled] = useState<boolean>(() => {
    // absent = enabled; string '0' = disabled
    return localStorage.getItem('nt.toasts.enabled') !== '0';
  });
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    setBusy(true);
    fetch('/api/v1/settings/telegram')
      .then((r) => r.json())
      .then((res) => {
        if (res.code === 0 && res.data) {
          setEnabled(Boolean(res.data.enabled));
          setHasToken(Boolean(res.data.has_token));
          if (Array.isArray(res.data.chatIds)) {
            setChatIdsInput(res.data.chatIds.join(', '));
          }
          if (res.data.events && typeof res.data.events === 'object') {
            setEvents((prev) => ({
              ...prev,
              ...res.data.events,
            }));
          }
        }
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  const onSave = async () => {
    setBusy(true);
    setSaveMsg('');
    try {
      const chatIds = chatIdsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const body: {
        enabled: boolean;
        chatIds: string[];
        events: Record<string, boolean>;
        token?: string;
      } = {
        enabled,
        chatIds,
        events,
      };
      if (tokenInput.trim().length > 0) {
        body.token = tokenInput.trim();
      }
      const res = await fetch('/api/v1/settings/telegram', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

      if (res.code === 0 && res.data) {
        setHasToken(Boolean(res.data.has_token));
        setTokenInput('');
        setSaveMsg(t('Settings saved successfully'));
        setTimeout(() => setSaveMsg(''), 3000);
      } else {
        setSaveMsg(res.msg || t('Save failed'));
      }
    } catch (e) {
      setSaveMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyToken = () => {
    if (!tokenInput) return;
    void navigator.clipboard.writeText(tokenInput).then(() => {
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 1500);
    });
  };

  const CANONICAL_EVENTS: Array<{ key: string; label: string; hint?: string }> = [
    { key: 'profile.started', label: t('Profile started') },
    { key: 'profile.stopped', label: t('Profile stopped') },
    { key: 'profile.created', label: t('Profile created') },
    { key: 'profile.deleted', label: t('Profile deleted') },
    { key: 'taskgroup.finished', label: t('Task group finished') },
    {
      key: 'agent.activity',
      label: t('Agent activity'),
      hint: t('High frequency (many alerts per minute while an agent is active)'),
    },
  ];

  const toggleToastSetting = (nextVal: boolean) => {
    setToastsEnabled(nextVal);
    // Contract: absent = enabled, '0' = disabled, '1' = enabled
    localStorage.setItem('nt.toasts.enabled', nextVal ? '1' : '0');
  };

  return (
    <>
      <div className="panel">
        <div className="panel-header">{t('Telegram Bot Settings')}</div>
        <p className="hint">
          {t('Configure Telegram bot for profile events and automation notifications.')}
        </p>

        <div className="setting-row">
          <span className="setting-label">{t('Enable Telegram Bot')}</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={busy}
          />
        </div>

        <div className="setting-row">
          <span className="setting-label">{t('Bot Token')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, maxWidth: 400 }}>
            <input
              type={tokenVisible ? 'text' : 'password'}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={hasToken ? t('Token is set and securely stored.') : t('Enter bot token')}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn-icon"
              onClick={() => setTokenVisible((v) => !v)}
              title={tokenVisible ? t('Hide') : t('Show')}
            >
              {tokenVisible ? '🙈' : '👁'}
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={copyToken}
              disabled={!tokenInput}
              title={t('Copy')}
            >
              {tokenCopied ? <CheckIcon size={13} style={{ color: 'var(--text)' }} /> : <CopyIcon size={13} />}
            </button>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 2, marginBottom: 12 }}>
          {hasToken ? t('Token is set and securely stored.') : t('Token not configured.')}
        </p>

        <div className="setting-row">
          <span className="setting-label">{t('Chat IDs (comma-separated)')}</span>
          <input
            type="text"
            value={chatIdsInput}
            onChange={(e) => setChatIdsInput(e.target.value)}
            placeholder={t('e.g. 12345678, -100123456789')}
            disabled={busy}
            style={{ maxWidth: 400, flex: 1 }}
          />
        </div>

        {/* Per-event Telegram switches */}
        <div style={{ marginTop: 'var(--space-4)', borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>
            {t('Event Notifications')}
          </div>
          <p className="hint" style={{ marginBottom: 12 }}>
            {t('Choose which events send alerts to Telegram:')}
          </p>
          {CANONICAL_EVENTS.map((ev) => (
            <div key={ev.key} style={{ marginBottom: 10 }}>
              <div className="setting-row" style={{ padding: '4px 0', borderBottom: 'none' }}>
                <span className="setting-label">{ev.label}</span>
                <input
                  type="checkbox"
                  checked={events[ev.key] ?? false}
                  onChange={(e) =>
                    setEvents((prev) => ({
                      ...prev,
                      [ev.key]: e.target.checked,
                    }))
                  }
                  disabled={busy}
                />
              </div>
              {ev.hint && (
                <p className="hint" style={{ margin: '2px 0 0 0', color: 'var(--text-muted)' }}>
                  {ev.hint}
                </p>
              )}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn primary" onClick={onSave} disabled={busy}>
            {busy ? t('Saving…') : t('Save Telegram Settings')}
          </button>
          {saveMsg && <span className="hint" style={{ color: 'var(--text-secondary)' }}>{saveMsg}</span>}
        </div>
      </div>

      {/* In-App Toast Switch Panel */}
      <div className="panel" style={{ marginTop: 'var(--space-4)' }}>
        <div className="panel-header">{t('In-App Notifications')}</div>
        <div className="setting-row">
          <span className="setting-label">{t('Show agent activity toasts')}</span>
          <input
            type="checkbox"
            checked={toastsEnabled}
            onChange={(e) => toggleToastSetting(e.target.checked)}
          />
        </div>
        <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
          {t('Silent popups shown in the corner of the app. Disabling them does not affect Telegram.')}
        </p>
      </div>
    </>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

type Section = 'general' | 'api' | 'data' | 'security' | 'telegram' | 'updates' | 'diagnostics' | 'android' | 'sync' | 'license';

export function Settings() {
  const { t, lang, setLang } = useI18n();
  const [section, setSection] = useState<Section>('general');
  const [apiKey, setApiKey] = useState('');
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dataDir, setDataDir] = useState('');
  const [dataDirMsg, setDataDirMsg] = useState('');
  const [logDir, setLogDir] = useState('');
  const [logFiles, setLogFiles] = useState<Array<{ name: string; size: number; modified: number }>>([]);
  const [kernelInfo, setKernelInfo] = useState<{ installed: string | null; latest: string | null; updateAvailable: boolean; releaseUrl?: string; error?: string } | null>(null);
  const [kernelChecking, setKernelChecking] = useState(false);
  const [kernelBusy, setKernelBusy] = useState(false);
  const [kernelInstallError, setKernelInstallError] = useState<string | null>(null);
  const [kernelProgress, setKernelProgress] = useState<{ received: number; total: number } | null>(null);
  const [backups, setBackups] = useState<Array<{ name: string; size: number; modified: number }>>([]);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreDone, setRestoreDone] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResults, setScanResults] = useState<Array<{ dir: string; profiles: number; modified: number; dbSize: number }>>([]);
  const [migrating, setMigrating] = useState(false);
  const [transferringDir, setTransferringDir] = useState<string | null>(null);
  const [transferAllBusy, setTransferAllBusy] = useState(false);
  const [deletingDir, setDeletingDir] = useState<string | null>(null);
  const [showCsv, setShowCsv] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvMsg, setCsvMsg] = useState('');
  /** Whether `csvMsg` reports a failure — the colour depends on this, not on the message text. */
  const [csvFailed, setCsvFailed] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);

  const importCsv = async () => {
    setCsvBusy(true);
    setCsvMsg('');
    setCsvFailed(false);
    try {
      const res = await api.importCsv(csvText);
      if (res.code === 0) {
        setShowCsv(false);
        setCsvText('');
        setCsvMsg(t('Profiles imported successfully'));
      } else {
        setCsvFailed(true);
        setCsvMsg(`Import failed: ${res.msg}`);
      }
    } catch (err) {
      setCsvFailed(true);
      setCsvMsg(`Import failed: ${(err as Error).message}`);
    } finally {
      setCsvBusy(false);
    }
  };

  const handleImportBundle = async (file: File) => {
    setBundleBusy(true);
    setCsvMsg('');
    setCsvFailed(false);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const res = await api.profileImportBundle(bundle);
      if (res.code === 0) {
        setCsvMsg(t('Profile bundle imported successfully'));
      } else {
        setCsvFailed(true);
        setCsvMsg(`Import failed: ${res.msg}`);
      }
    } catch (err) {
      setCsvFailed(true);
      setCsvMsg(`Import failed: ${(err as Error).message}`);
    } finally {
      setBundleBusy(false);
    }
  };


  const checkKernel = (): void => {
    setKernelChecking(true);
    void import('../api').then(({ api }) => {
      api.kernelCheckUpdate().then((res) => {
        if (res.code === 0) setKernelInfo(res.data);
        setKernelChecking(false);
      }).catch(() => setKernelChecking(false));
    });
  };

  /**
   * Download the kernel. 425 MB over a real network, so the button reports progress from
   * the server's own byte counters rather than a spinner that says nothing, and a failure
   * keeps the reason on screen instead of a button that silently does nothing.
   */
  const installKernel = (): void => {
    setKernelBusy(true);

    setKernelInstallError(null);
    setKernelProgress({ received: 0, total: 0 });
    // Poll the server's own counters; a 425 MB download with no feedback looks hung.
    const poll = window.setInterval(() => {
      void import('../api').then(({ api }) => {
        api
          .kernelStatus()
          .then((res) => {
            if (res.code !== 0) return;
            if (res.data.status === 'downloading') {
              setKernelProgress({ received: res.data.received, total: res.data.total });
            } else if (res.data.status === 'error') {
              setKernelInstallError(res.data.error ?? 'Kernel install failed');
            }
          })
          .catch(() => undefined);
      });
    }, 1000);

    void import('../api').then(({ api }) => {
      api
        .kernelInstall()
        .then((res) => {
          if (res.code !== 0) {
            setKernelInstallError(res.msg || 'Kernel install failed');
          } else {
            setKernelProgress(null);
            return api.kernelInfo().then((info) => {
              if (info.code === 0) setKernelInfo((prev) => ({ ...(prev ?? { latest: null, updateAvailable: false }), installed: info.data.installed }));
            });
          }
        })
        .catch((err: unknown) => setKernelInstallError(err instanceof Error ? err.message : 'Kernel install failed'))
        .finally(() => {
          window.clearInterval(poll);
          setKernelBusy(false);
          setKernelProgress(null);
        });
    });
  };

  useEffect(() => {
    if (window.antidetect?.getApiKey) {
      void window.antidetect.getApiKey().then(setApiKey).catch(() => undefined);
    }
    if (window.antidetect?.data?.getDir) {
      void window.antidetect.data.getDir().then(setDataDir).catch(() => undefined);
    }
    void import('../api').then(({ api }) => {
      api.logsList().then((res) => {
        if (res.code === 0) {
          setLogDir(res.data.dir);
          setLogFiles(res.data.list.slice(0, 5));
        }
      }).catch(() => undefined);
      api.kernelInfo().then((res) => {
        if (res.code === 0) setKernelInfo({ installed: res.data.installed, latest: null, updateAvailable: false });
      }).catch(() => undefined);
      api.backupsList().then((res) => {
        if (res.code === 0) setBackups(res.data.list);
      }).catch(() => undefined);
    });
    if (window.antidetect?.update?.onStatus) {
      // Go through the same translation the footer uses. This panel used to subscribe to the
      // shell's raw payload but switch on the UI's vocabulary — `'available'`, `'downloading'` —
      // which the shell never sends (it says `update-available`, `download-progress`), so every
      // state fell through to no branch, the panel rendered nothing, and the Download and
      // Restart buttons were unreachable.
      const off = window.antidetect.update.onStatus((s) => setStatus(normalizeUpdateStatus(s)));
      return off;
    }
  }, []);

  const busy = status?.state === 'checking' || status?.state === 'downloading';
  const updaterAvailable = Boolean(window.antidetect?.update);
  const dataApiAvailable = Boolean(window.antidetect?.data);

  const onChangeDataDir = (): void => {
    void window.antidetect?.data.prepareDir?.().then(async (picked) => {
      if (!picked.ok) return;
      const target = picked.dir;
      // Ask what to do with the existing data.
      const migrate = window.confirm(
        `${t('Move profiles and ALL data to')}:\n${target}\n\n${t('OK = migrate everything (recommended). Cancel = switch to an empty folder.')}`
      );
      setMigrating(true);
      setDataDirMsg('');
      try {
        const r = await window.antidetect?.data.migrateDir?.(target, migrate);
        if (r?.ok) {
          setDataDir(target);
          setDataDirMsg(
            migrate
              ? `${t('Data migrated to the new folder.')} ${t('Restart the app to apply.')}`
              : t('Folder changed. Restart the app to apply.')
          );
        } else {
          setDataDirMsg(`${t('Migration failed')}: ${r?.error ?? 'unknown'}`);
        }
      } finally {
        setMigrating(false);
      }
    });
  };

  const onOpenDataDir = (): void => {
    void window.antidetect?.data.openDir();
  };

  /**
   * Transfer profiles out of a folder the operator picks, into the folder in use, without
   * switching directories. The scan section below does the same thing per discovered row;
   * this is the direct path when the folder is already known.
   */
  const onTransferFromFolder = (): void => {
    void window.antidetect?.data.prepareDir?.().then(async (picked) => {
      if (!picked.ok || !picked.dir) return;
      setTransferringDir(picked.dir);
      setDataDirMsg('');
      try {
        const res = await api.dataTransfer(picked.dir);
        if (res.code === 0 && res.data) {
          const { created, skipped, workspaces } = res.data;
          const transferredPart = `${t('Transferred')} ${created} ${created === 1 ? 'profile' : 'profiles'}`;
          const skippedPart = skipped > 0 ? `, ${skipped} ${t('already present')}` : '';
          const sessionsPart = `, ${workspaces ?? 0} ${t('browser workspaces copied')}`;
          setDataDirMsg(`${transferredPart}${skippedPart}${sessionsPart} (${t('open Profiles to see them')})`);
        } else {
          setDataDirMsg(res.msg || res.data?.error || t('Transfer failed'));
        }
      } catch (err) {
        setDataDirMsg(err instanceof Error ? err.message : t('Transfer failed'));
      } finally {
        setTransferringDir(null);
      }
    });
  };

  /**
   * Walk every discovered folder and transfer its profiles into the folder in use.
   * Sequential, not parallel: /data/transfer opens the source with sql.js and writes the
   * destination, and several concurrent writers to one SQLite file is how a database gets
   * corrupted. One folder's failure is recorded and the rest continue.
   */
  const onTransferAll = async (): Promise<void> => {
    if (transferAllBusy || transferringDir !== null) return;
    setTransferAllBusy(true);
    setDataDirMsg('');
    const aggregate = {
      folders: 0,
      created: 0,
      skipped: 0,
      workspaces: 0,
      failures: [] as Array<{ dir: string; error: string }>
    };

    try {
      // Sequential walk: concurrent writers to one SQLite file corrupt it.
      for (const f of scanResults) {
        if (f.profiles <= 0) continue;
        aggregate.folders++;
        try {
          const res = await api.dataTransfer(f.dir);
          if (res.code === 0 && res.data) {
            aggregate.created += res.data.created;
            aggregate.skipped += res.data.skipped;
            aggregate.workspaces += res.data.workspaces ?? 0;
          } else {
            const errMsg = res.msg || res.data?.error || t('Transfer failed');
            aggregate.failures.push({ dir: f.dir, error: errMsg });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : t('Transfer failed');
          aggregate.failures.push({ dir: f.dir, error: errMsg });
        }
      }

      // The workspace count is part of the report, not decoration: it is the number of
      // profiles whose logins and cookies came across. Reporting only the row count is how a
      // transfer that moved metadata and no sessions read as a success.
      let msg = `${t('Transferred')} ${aggregate.created} profiles, ${aggregate.skipped} ${t('already present')} (${aggregate.folders} ${t('folders')}), ${aggregate.workspaces} ${t('browser workspaces copied')}`;
      if (aggregate.failures.length > 0) {
        const failSuffix = aggregate.failures.map((fail) => ` — ${t('failed')}: ${fail.dir}`).join('');
        msg += failSuffix;
      }
      setDataDirMsg(msg);
    } finally {
      setTransferAllBusy(false);
    }
  };

  /**
   * Scan for data folders, on demand and after a deletion.
   *
   * Extracted from the button so the delete control can re-run it: the operator asked for a
   * working re-scan after removal, and a deleted row that stays on screen until a manual
   * refresh looks like the deletion failed.
   */
  const runScan = (): void => {
    setScanBusy(true);
    setScanResults([]);
    void import('../api').then(({ api }) =>
      api.dataScan()
        .then((r) => {
          setScanBusy(false);
          if (r.code === 0) setScanResults(r.data.found.filter((f) => !f.isCurrent));
        })
        .catch(() => setScanBusy(false))
    );
  };

  /**
   * Move an old data folder to the Recycle Bin, then re-scan.
   *
   * The confirmation names the folder and says it goes to the Recycle Bin, because the two
   * facts the operator needs before agreeing are *which* folder and whether it is recoverable.
   * The server refuses when the folder still holds profiles that are not in the one in use;
   * that refusal arrives as a message and is shown unchanged rather than paraphrased.
   */
  const onDeleteFolder = (dir: string, profiles: number): void => {
    const ok = window.confirm(
      `${t('Move this folder to the Recycle Bin?')}\n\n${dir}\n\n` +
        `${profiles} ${profiles === 1 ? 'profile' : 'profiles'} — ${t('it can be restored from the Recycle Bin.')}`
    );
    if (!ok) return;
    setDeletingDir(dir);
    setDataDirMsg('');
    void import('../api').then(({ api }) => {
      api
        .dataDelete(dir)
        .then((res) => {
          if (res.code === 0 && res.data?.ok) {
            setDataDirMsg(`${t('Folder moved to the Recycle Bin')}: ${dir}`);
            // Re-scan so the removed folder disappears; that is the visible proof it worked.
            runScan();
          } else {
            const reason = res.data?.reason;
            if (reason === 'not-transferred') {
              setDataDirMsg(
                `${t('This folder still holds profiles that are not in the folder in use')}: ${res.data?.missing ?? 0}. ${t('Transfer it first.')}`
              );
            } else {
              setDataDirMsg(res.msg || t('Could not delete the folder'));
            }
          }
        })
        .catch((err: unknown) => setDataDirMsg(err instanceof Error ? err.message : t('Could not delete the folder')))
        .finally(() => setDeletingDir(null));
    });
  };

  const onOpenLogsDir = (): void => {
    if (window.antidetect?.logs?.openDir) {
      void window.antidetect.logs.openDir();
    } else {
      void window.open(`file:///${logDir.replace(/\\/g, '/')}`);
    }
  };

  const onCheck = (): void => {
    setStatus({ state: 'checking' });
    void window.antidetect?.update.check();
  };

  const onDownload = (): void => {
    if (status?.state !== 'available') return;
    setStatus({ state: 'checking' });
    void window.antidetect?.update.download();
  };

  const onRestart = (): void => {
    void window.antidetect?.update.quitAndInstall();
  };

  const copyKey = (): void => {
    void navigator.clipboard.writeText(apiKey);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 1500);
  };

  const renderUpdateStatus = (): React.ReactNode => {
    if (!status) return null;
    switch (status.state) {
      case 'checking':
        return <p className="hint">{t('Checking for updates…')}</p>;
      case 'not-available':
        return <p className="hint" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>✓ {t('You are on the latest version.')}</p>;
      case 'available':
        return (
          <div className="setting-row">
            <span className="setting-label">
              {t('New version available')}: <strong>{status.info.version ? `v${status.info.version}` : t('New build')}</strong>
            </span>
            <button className="btn primary" onClick={onDownload} disabled={busy}>
              {t('Download Update')}
            </button>
          </div>
        );
      case 'downloading':
        return (
          <div className="setting-row">
            <span className="setting-label">
              {t('Downloading…')} {Math.round(status.percent)}% ({formatBytes(status.transferred)} / {formatBytes(status.total)})
            </span>
          </div>
        );
      case 'installing':
        // The portable swap and the installer both run after this state arrives; on Windows the
        // installed build exits to run the NSIS setup, and the portable build exits so its
        // launcher unlocks. Say what is happening, because the window is about to disappear.
        return (
          <div className="setting-row">
            <span className="setting-label">{t('Installing…')}</span>
            <span className="hint" style={{ margin: 0 }}>{t('Applying the update...')}</span>
          </div>
        );
      case 'downloaded':
        return (
          <div className="setting-row">
            <span className="setting-label">
              {t('Update ready')}: <strong>{status.info.version ? `v${status.info.version}` : t('Ready to install')}</strong>
            </span>
            <button className="btn primary" onClick={onRestart}>
              {t('Restart & install')}
            </button>
          </div>
        );
      case 'error': {
        if (isUpdatesUnconfigured(status)) {
          return (
            <div>
              <p className="hint" style={{ color: 'var(--text-secondary)' }}>
                {t('Automatic updates are not configured for this build yet.')}
              </p>
              <p className="hint" style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }} title={status.message}>
                {t('Diagnostics: Remote release metadata not found')}
              </p>
            </div>
          );
        }
        return (
          <div>
            <p className="hint" style={{ color: 'var(--text-secondary)' }}>
              {t('Update check could not complete.')}
            </p>
            <p className="hint" style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              {status.message}
            </p>
          </div>
        );
      }
    }
  };

  const SECTIONS: Array<{ key: Section; label: string }> = [
    { key: 'general', label: t('General') },
    { key: 'api', label: t('Automation API') },
    { key: 'data', label: t('Data Folder') },
    { key: 'security', label: t('Security') },
    { key: 'telegram', label: t('Notifications') },
    { key: 'sync', label: t('Sync') },
    { key: 'license', label: t('License') },
    { key: 'updates', label: t('Updates') },
    { key: 'diagnostics', label: t('Diagnostics') },
    { key: 'android', label: t('Android') },
  ];

  const renderSection = (): React.ReactNode => {
    if (section === 'sync') return <SyncSettings />;
    if (section === 'license') return <LicenseSettings />;
    return null;
  };

  const renderSectionContent = (): React.ReactNode => {
    if (section === 'sync' || section === 'license') return renderSection();
    return null;
  };

  void renderSectionContent;

  return (
    <div>
      <div className="page-header-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <SettingsIcon size={20} style={{ color: 'var(--text-secondary)' }} />
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>{t('Settings & Automation')}</h2>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Section nav */}
        <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              className={`settings-nav-item ${section === s.key ? 'active' : ''}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Section content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {section === 'sync' ? (
            <SyncSettings />
          ) : section === 'license' ? (
            <LicenseSettings />
          ) : section === 'general' ? (
            <div className="panel">
              <div className="panel-header">{t('General')}</div>
              <div className="setting-row">
                <span className="setting-label">{t('Language')}</span>
                <select
                  className="select-input"
                  value={lang}
                  onChange={(e) => setLang(e.target.value as Lang)}
                  style={{ minWidth: 160 }}
                >
                  <option value="en">English</option>
                  <option value="ru">Русский</option>
                </select>
              </div>
              <p className="hint">
                {t('Interface language. Applies immediately.')}
              </p>
            </div>
          ) : null}

          {section === 'api' ? (
            <div className="panel">
              <div className="panel-header">{t('Automation API (for your scripts)')}</div>
              <div className="setting-row">
                <span className="setting-label">{t('Endpoint URL')}</span>
                <code>{getApiBase()}</code>
              </div>
              <div className="setting-row">
                <span className="setting-label">{t('Bearer API Key')}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <code style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {apiKey ? (keyVisible ? apiKey : `${apiKey.slice(0, 8)}${'•'.repeat(24)}`) : '—'}
                  </code>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setKeyVisible((v) => !v)}
                    title={keyVisible ? t('Hide') : t('Show')}
                  >
                    {keyVisible ? '🙈' : '👁'}
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={copyKey}
                    disabled={!apiKey}
                    title={t('Copy')}
                  >
                    {keyCopied ? <CheckIcon size={13} style={{ color: 'var(--text)' }} /> : <CopyIcon size={13} />}
                  </button>
                </div>
              </div>
              <p className="hint">
                {t('Use this key to connect your own bots and scripts (Puppeteer, Playwright, Selenium, Python) to the local API. Pass it in the HTTP header:')} <code>Authorization: Bearer &lt;key&gt;</code>.
              </p>
            </div>
          ) : null}

          {section === 'security' && <SecuritySettings />}
          {section === 'telegram' && <TelegramSettings />}
          {section === 'android' && <AndroidEngineSettings />}

          {section === 'data' && dataApiAvailable ? (
            <div className="panel">
              <div className="panel-header">{t('Data Folder (Profiles, Cache, Kernel)')}</div>
              <div className="setting-row">
                <span className="setting-label">{t('Current folder')}</span>
                <code style={{ wordBreak: 'break-all', maxWidth: '55%' }}>{dataDir || '—'}</code>
              </div>
              <div className="setting-row">
                <span className="setting-label">{t('Actions')}</span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={onChangeDataDir} disabled={migrating}>
                    {migrating ? t('Migrating data…') : t('Change Folder…')}
                  </button>
                  {/* Transfer sits with Change Folder because both act on the folder in use:
                      one moves the whole installation, the other brings profiles into it. */}
                  <button
                    className="btn"
                    onClick={onTransferFromFolder}
                    disabled={migrating || transferringDir !== null}
                  >
                    {transferringDir ? t('Transferring…') : t('Transfer profiles…')}
                  </button>
                  <button className="btn" onClick={onOpenDataDir} disabled={migrating}>
                    {t('Open in Explorer')}
                  </button>
                  <button className="btn" onClick={() => setShowCsv(true)}>
                    {t('Import CSV')}
                  </button>
                  <button className="btn" onClick={() => window.open(api.exportCsvUrl(), '_blank')} title={t('Export all profiles to CSV')}>
                    {t('Export CSV')}
                  </button>
                  <button className="btn" onClick={() => document.getElementById('settings-import-bundle-input')?.click()} disabled={bundleBusy} title={t('Import a profile bundle (.json) exported from this or another machine')}>
                    {bundleBusy ? t('Importing…') : t('Import Bundle')}
                  </button>
                  <input
                    id="settings-import-bundle-input"
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleImportBundle(f);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
              {dataDirMsg ? <p className="hint" style={{ color: 'var(--warn)' }}>{dataDirMsg}</p> : null}
              {csvMsg ? <p className="hint" style={{ color: csvFailed ? 'var(--danger)' : 'var(--accent)' }}>{csvMsg}</p> : null}
              <p className="hint">
                {t('All browser profiles, cookies, extensions, the Chromium kernel and the database are stored here. Changing the folder takes effect after restarting the app.')}
              </p>

              <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0', paddingTop: 14 }}>
                <div className="panel-header" style={{ padding: 0, marginBottom: 8 }}>{t('Recover old data')}</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  {t('Profiles/groups disappeared after an update? Scan the system for existing antidetect databases and switch to the one that contains your profiles.')}
                </p>
                <button
                  type="button"
                  className="btn"
                  disabled={scanBusy}
                  onClick={runScan}
                >
                  <RefreshIcon size={14} />
                  <span>{scanBusy ? t('Scanning…') : t('Scan for existing data folders')}</span>
                </button>
                {scanResults.length > 0 ? (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {scanResults.some((f) => f.profiles > 0) ? (
                      <div style={{ marginBottom: 4 }}>
                        <button
                          type="button"
                          className="btn btn-sm primary"
                          disabled={transferringDir !== null || transferAllBusy}
                          onClick={() => void onTransferAll()}
                        >
                          {transferAllBusy ? t('Transferring all…') : t('Transfer all to current folder')}
                        </button>
                      </div>
                    ) : null}
                    {scanResults.map((f) => (
                      <div key={f.dir} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
                        <span style={{ color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                          <code style={{ fontSize: 11 }}>{f.dir}</code>{' '}
                          <strong style={{ color: f.profiles > 0 ? 'var(--text)' : 'var(--text-muted)' }}>
                            ({f.profiles >= 0 ? `${f.profiles} ${f.profiles === 1 ? 'profile' : 'profiles'}` : t('unreadable')})
                          </strong>{' '}
                          <span style={{ color: 'var(--text-muted)' }}>{new Date(f.modified).toLocaleString()}</span>
                        </span>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                          {/* Transfer profiles into current folder without switching directories (decision D1). */}
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={f.profiles <= 0 || transferringDir !== null || transferAllBusy}
                            onClick={() => {
                              setTransferringDir(f.dir);
                              setDataDirMsg('');
                              void import('../api').then(({ api }) => {
                                api.dataTransfer(f.dir)
                                  .then((res) => {
                                    setTransferringDir(null);
                                    if (res.code === 0 && res.data) {
                                      const { created, skipped } = res.data;
                                      const transferredPart = `${t('Transferred')} ${created} ${created === 1 ? 'profile' : 'profiles'}`;
                                      const skippedPart = skipped > 0 ? `, ${skipped} ${t('already present')}` : '';
                                      const hintPart = ` (${t('open Profiles to see them')})`;
                                      setDataDirMsg(`${transferredPart}${skippedPart}${hintPart}`);
                                    } else {
                                      setDataDirMsg(res.msg || res.data?.error || t('Transfer failed'));
                                    }
                                  })
                                  .catch((err: unknown) => {
                                    setTransferringDir(null);
                                    setDataDirMsg(err instanceof Error ? err.message : t('Transfer failed'));
                                  });
                              });
                            }}
                          >
                            {transferringDir === f.dir ? t('Transferring…') : t('Transfer profiles here')}
                          </button>
                          {/* Keep original switch behavior intact for operators who really want to point to the other folder. */}
                          <button
                            type="button"
                            className="btn btn-sm primary"
                            disabled={f.profiles <= 0}
                            onClick={() => {
                              void window.antidetect?.data.setDirPath?.(f.dir).then((r) => {
                                if (r.ok) {
                                  setDataDir(r.dir);
                                  setDataDirMsg(t('Folder changed. Restart the app to apply.'));
                                } else {
                                  setDataDirMsg(t('Could not switch to this folder.'));
                                }
                              });
                            }}
                          >
                            {t('Use this folder')}
                          </button>
                          {/* Delete the leftover folder once its profiles are here. The server
                              refuses while any profile in it is missing from the folder in use,
                              so the guard cannot be bypassed from this button. */}
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={deletingDir !== null || transferringDir !== null || transferAllBusy}
                            onClick={() => onDeleteFolder(f.dir, f.profiles)}
                          >
                            {deletingDir === f.dir ? t('Deleting…') : t('Delete folder')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {section === 'updates' ? (
            <>
              <div className="panel">
                <div className="panel-header">{t('Software Updates')}</div>
                {updaterAvailable ? (
                  <>
                    <div className="setting-row">
                      <span className="setting-label">{t('Release Channel (GitHub Releases)')}</span>
                      <button className="btn" onClick={onCheck} disabled={busy}>
                        <RefreshIcon size={14} />
                        <span>{t('Check for updates')}</span>
                      </button>
                    </div>
                    {renderUpdateStatus()}
                  </>
                ) : (
                  <p className="hint">{t('Updates are available in the installed app.')}</p>
                )}
              </div>

              <div className="panel">
                <div className="panel-header">{t('Browser Kernel (fingerprint-chromium)')}</div>
                <div className="setting-row">
                  <span className="setting-label">{t('Installed version')}</span>
                  <code>{kernelInfo?.installed ?? '—'}</code>
                </div>
                <div className="setting-row">
                  <span className="setting-label">{t('Upstream check')}</span>
                  <button className="btn" onClick={checkKernel} disabled={kernelChecking}>
                    <RefreshIcon size={14} />
                    <span>{kernelChecking ? t('Checking…') : t('Check for kernel update')}</span>
                  </button>
                </div>

                {/* Installing the kernel from the app, because a shipped artefact does not
                    contain it: the kernel is ~425 MB of patched Chromium, so bundling it
                    would dwarf the app. Before this, a fresh install had no kernel and
                    every profile launch failed with no in-app way to fix it. */}
                <div className="setting-row">
                  <span className="setting-label">{t('Kernel')}</span>
                  {kernelProgress ? (
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                      {kernelProgress.total > 0
                        ? `${t('Downloading…')} ${Math.round((kernelProgress.received / kernelProgress.total) * 100)}%`
                        : t('Downloading…')}
                    </span>
                  ) : (
                    <button className="btn" onClick={installKernel} disabled={kernelBusy}>
                      <span>{kernelBusy ? t('Installing…') : t('Download and install kernel')}</span>
                    </button>
                  )}
                </div>
                {kernelInstallError ? (
                  <p className="hint" style={{ color: 'var(--danger)' }} role="alert">
                    {kernelInstallError}
                  </p>
                ) : null}
                {kernelInfo?.latest ? (
                  <p className="hint" style={{ color: kernelInfo.updateAvailable ? 'var(--warn)' : 'var(--text-secondary)', fontWeight: 500 }}>
                    {kernelInfo.updateAvailable
                      ? `⚠ ${t('Update available')}: v${kernelInfo.latest} (v${kernelInfo.installed})`
                      : `✓ ${t('You are on the latest kernel')} (v${kernelInfo.latest})`}
                    {kernelInfo.releaseUrl ? (
                      <>
                        {' '}
                        <a href={kernelInfo.releaseUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--text)', textDecoration: 'underline' }}>
                          {t('Open releases')} ↗
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : null}
                <p className="hint">
                  {t('The kernel is intentionally pinned (stealth patches are version-specific). Updating is manual: download the new Windows build, replace the folder under')} <code>data/chromium/fingerprint-chromium</code>.
                </p>
              </div>
            </>
          ) : null}

          {section === 'diagnostics' ? (
            <div className="panel">
              <div className="panel-header">{t('Diagnostics & Logs')}</div>
              <div className="setting-row">
                <span className="setting-label">{t('Log folder')}</span>
                <code style={{ wordBreak: 'break-all', maxWidth: '55%' }}>{logDir || '—'}</code>
              </div>
              <div className="setting-row">
                <span className="setting-label">{t('Actions')}</span>
                <button className="btn" onClick={onOpenLogsDir}>
                  {t('Open Logs Folder')}
                </button>
              </div>
              {logFiles.length > 0 ? (
                <div style={{ padding: '4px 0' }}>
                  <p className="hint" style={{ marginBottom: 6 }}>{t('Recent log files (kept 14 days):')}</p>
                  {logFiles.map((f) => (
                    <div key={f.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', color: 'var(--text-secondary)' }}>
                      <code>{f.name}</code>
                      <span style={{ color: 'var(--text-muted)' }}>{formatBytes(f.size)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="hint">
                {t('Logs include service lifecycle, profile start/stop errors, backups and crash recovery events. Send the newest')} <code>app-*.log</code> {t('when reporting an issue.')}
              </p>

              <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0', paddingTop: 14 }}>
                <div className="panel-header" style={{ padding: 0, marginBottom: 8 }}>{t('Database Backups (restore)')}</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  {t('If profiles/groups suddenly disappeared, restore the database from an automatic daily backup. The current (broken) database is snapshotted before restoring — the operation is reversible. Restart the app after restoring.')}
                </p>
                {backups.length === 0 ? (
                  <p className="hint" style={{ color: 'var(--text-secondary)' }}>{t('No backups found yet (they are created daily after the first run).')}</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {backups.map((b) => (
                      <div key={b.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          <code>{b.name}</code>{' '}
                          <span style={{ color: 'var(--text-muted)' }}>({formatBytes(b.size)}, {new Date(b.modified).toLocaleString()})</span>
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={restoreBusy}
                          onClick={() => {
                            if (!window.confirm(t('Restore database from this backup? The app must be restarted afterwards.'))) return;
                            setRestoreBusy(true);
                            void import('../api').then(({ api }) =>
                              api.backupRestore(b.name).then((r) => {
                                setRestoreBusy(false);
                                if (r.code === 0) setRestoreDone(true);
                                else setRestoreMsg(r.msg);
                              }).catch(() => setRestoreBusy(false))
                            );
                          }}
                        >
                          {t('Restore')}
                        </button>
                      </div>
                    ))}
                    {restoreDone ? (
                      <p className="hint" style={{ color: 'var(--warn)', fontWeight: 600 }}>
                        ✓ {t('Database restored. Restart the app to see your profiles.')}
                      </p>
                    ) : null}
                    {restoreMsg ? <p className="hint" style={{ color: 'var(--text-secondary)' }}>{restoreMsg}</p> : null}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {/* CSV Import Modal */}
      {showCsv ? (
        <div className="modal-overlay" onClick={() => setShowCsv(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('Import Profiles via CSV')}</h3>
              <button className="btn-icon" onClick={() => setShowCsv(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="hint" style={{ margin: 0 }}>
                CSV format: <code>name,proxy_type,proxy_host,proxy_port,proxy_user,proxy_pass</code>
              </p>
              <textarea
                placeholder="acc1,http,1.2.3.4,8080,usr,pass&#10;acc2,socks5,5.6.7.8,1080"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                rows={6}
                style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowCsv(false)}>{t('Cancel')}</button>
              <button className="btn primary" onClick={() => void importCsv()} disabled={csvBusy || !csvText.trim()}>
                {csvBusy ? t('Importing…') : t('Import Profiles')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
