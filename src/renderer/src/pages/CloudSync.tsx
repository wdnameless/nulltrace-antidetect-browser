import React, { useState, useEffect, useRef } from 'react';
import { api, GDriveStatusData, SyncLogEntry, GDriveScope } from '../api';
import { useI18n } from '../i18n';
import { openExternalUrl, PRIVACY_POLICY_URL } from '../externalUrl';
import { GoogleGIcon } from '../icons';
import { Modal } from '../components/Modal';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatRelativeTime(
  timestamp: number | null | undefined,
  t: (s: string) => string
): string {
  if (!timestamp || timestamp <= 0) return t('Never');
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 15) return t('Just now');
  if (diffSec < 60) return `${diffSec} ${t('seconds ago')}`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} ${t('minutes ago')}`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} ${t('hours ago')}`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ${t('days ago')}`;
}

interface InspectConflictItem {
  table?: string;
  key?: string;
  localHash?: string;
  remoteHash?: string;
  type?: string;
  id?: string;
  name?: string;
}

interface InspectPullResult {
  remoteTimestamp: number;
  profileCount?: number;
  scriptCount?: number;
  vaultCount?: number;
  groupCount?: number;
  newProfiles?: number;
  newScripts?: number;
  newRows?: number;
  deletedRows?: number;
  conflicts: InspectConflictItem[];
  unchanged: boolean;
}

const LOCAL_I18N_RU: Record<string, string> = {
  'Verify': 'Проверить',
  'Verifying…': 'Проверка…',
  'Verification successful': 'Проверка успешна',
  'remote state is valid': 'удаленное состояние корректно',
  'Verification failed': 'Проверка не удалась',
  'Change Passphrase': 'Сменить парольную фразу',
  'Re-encrypt your Google Drive backup with a new passphrase.': 'Перешифровать резервную копию Google Drive новой парольной фразой.',
  'Current Passphrase': 'Текущая парольная фраза',
  'Enter current passphrase': 'Введите текущую парольную фразу',
  'New Passphrase (minimum 8 characters)': 'Новая парольная фраза (минимум 8 символов)',
  'Enter new passphrase': 'Введите новую парольную фразу',
  'Please enter your current passphrase': 'Пожалуйста, введите текущую парольную фразу',
  'New passphrase must be at least 8 characters long': 'Новая парольная фраза должна содержать не менее 8 символов',
  'New passphrase must be different from current passphrase': 'Новая парольная фраза должна отличаться от текущей',
  'Continue': 'Продолжить',
  'Confirm Passphrase Change': 'Подтверждение смены парольной фразы',
  'Your Google Drive backup will be re-encrypted under the new passphrase. You will need this new passphrase on all other devices. If you lose it, cloud data cannot be restored.': 'Резервная копия в Google Drive будет перешифрована новой парольной фразой. Эта новая фраза потребуется на всех остальных устройствах. При её утере данные восстановить невозможно.',
  'Confirm & Change Passphrase': 'Подтвердить и сменить',
  'Updating Passphrase…': 'Обновление парольной фразы…',
  'Back': 'Назад',
  'Passphrase changed successfully. Backup re-encrypted.': 'Парольная фраза успешно изменена. Резервная копия перешифрована.',
  'Current passphrase is incorrect. Please check your current passphrase and try again.': 'Текущая парольная фраза неверна. Проверьте правильность и попробуйте снова.',
  'Failed to change passphrase': 'Не удалось изменить парольную фразу',
  'Sync Log': 'Журнал синхронизации',
  'Hide Sync Log': 'Скрыть журнал',
  'Loading log…': 'Загрузка журнала…',
  'Google Drive Sync Log': 'Журнал синхронизации Google Drive',
  'No sync log entries recorded yet.': 'Записей в журнале синхронизации пока нет.',
  'Time': 'Время',
  'Direction': 'Направление',
  'Outcome': 'Результат',
  'Conflicts': 'Конфликты',
  'Error': 'Ошибка',
  'Sync Conflicts': 'Конфликты синхронизации',
  'conflicts': 'конфликтов',
  'None': 'Нет',
  'conflicts detected in sync data.': 'конфликтов обнаружено в данных синхронизации.',
  'push': 'выгрузка',
  'pull': 'загрузка',
  'merge': 'слияние',
  'mirror': 'зеркало',
  'ok': 'успешно',
  'failed': 'ошибка',
  'Refreshing…': 'Обновление…',
  'Refresh': 'Обновить',
  'Close': 'Закрыть',
  'Last Verified': 'Последняя проверка',
  'Hash details': 'Сведения о хешах',
  'Local': 'Локально',
  'Remote': 'В облаке',
  'Entry': 'Запись',
  'Session locked — unlock above to sync': 'Сессия заблокирована — разблокируйте выше для синхронизации',
  'Google Drive session is locked. Enter your passphrase to unlock.': 'Сессия Google Drive заблокирована. Введите парольную фразу для разблокировки.',
  'Actions disabled: Google Drive session is locked. Enter your passphrase above to unlock.': 'Действия недоступны: сессия Google Drive заблокирована. Введите парольную фразу выше для разблокировки.',
  'Actions disabled: sync is currently in progress.': 'Действия недоступны: в данный момент выполняется синхронизация.',
};
function getHumanSyncErrorMessage(rawError: string, t: (s: string) => string): string {
  const lower = (rawError || '').toLowerCase();
  if (lower.includes('column') || lower.includes('no such column')) {
    return t('Database schema mismatch detected. Please restart the app or sync again.');
  }
  if (lower.includes('locked')) {
    return t('Sync session is locked. Enter your passphrase to unlock synchronization.');
  }
  if (
    lower.includes('not connected') ||
    lower.includes('not_connected') ||
    lower.includes('invalid_grant') ||
    lower.includes('unauthenticated') ||
    lower.includes('unauthorized')
  ) {
    return t('Cloud storage is not connected or authorization expired. Please reconnect.');
  }
  if (
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('enotfound') ||
    lower.includes('offline')
  ) {
    return t('Network connection error. Check your internet connection and try again.');
  }
  return t('Synchronization failed. Please try again.');
}

export const CloudSync: React.FC = () => {
  const { t: rootT, lang } = useI18n();
  const t = (key: string): string => {
    if (lang === 'ru' && LOCAL_I18N_RU[key]) {
      return LOCAL_I18N_RU[key];
    }
    return rootT(key);
  };

  // Google Drive state
  const [gdriveStatus, setGdriveStatus] = useState<GDriveStatusData | null>(null);
  const [gdriveClientId, setGdriveClientId] = useState('');
  const [gdriveClientSecret, setGdriveClientSecret] = useState('');
  const [gdriveBusy, setGdriveBusy] = useState(false);
  /**
   * Poll handle for an authorization in flight.
   *
   * Held in a ref rather than state: it is a handle, not renderable data, and storing it in state
   * would re-render the whole panel on every tick. Cleaned up on unmount below so a connect that is
   * abandoned mid-wait cannot keep polling after the page is gone.
   */
  const pendingAuthPoll = useRef<number | null>(null);
  const [gdriveNotice, setGdriveNotice] = useState('');
  const [gdriveError, setGdriveError] = useState('');

  // One-click Connect flow (R1, R5)
  const [connectStep, setConnectStep] = useState<'idle' | 'passphrase' | 'progress'>('idle');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [passphraseError, setPassphraseError] = useState('');

  // Session unlock flow
  const [unlockPassphrase, setUnlockPassphrase] = useState('');
  const [unlockError, setUnlockError] = useState('');

  // Verify state
  const [verifying, setVerifying] = useState(false);

  // Change passphrase dialog state
  const [changePassphraseOpen, setChangePassphraseOpen] = useState(false);
  const [changePassphraseStep, setChangePassphraseStep] = useState<'input' | 'confirm'>('input');
  const [currentPassphrase, setCurrentPassphrase] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [changePassphraseError, setChangePassphraseError] = useState('');

  // Sync log panel state
  const [gdriveSyncLog, setGdriveSyncLog] = useState<SyncLogEntry[] | null>(null);
  const [gdriveLogLoading, setGdriveLogLoading] = useState(false);
  const [showGdriveLog, setShowGdriveLog] = useState(false);
  // Full Chromium mirror switch (R4 opt-in)
  const [mirrorEnabled, setMirrorEnabled] = useState(false);
  const [mirrorNotice, setMirrorNotice] = useState('');

  const [gdriveScope, setGdriveScope] = useState<GDriveScope>({
    profiles: true,
    proxies: true,
    vault: true,
    scripts: true,
    library: true,
    settings: true,
  });
  const [deviceAuthData, setDeviceAuthData] = useState<{
    userCode: string;
    verificationUrl: string;
    deviceCode: string;
    interval: number;
  } | null>(null);
  const [inspection, setInspection] = useState<InspectPullResult | null>(null);
  // Local confirmation state for destructive actions (R04)
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    consequences: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const refreshGDriveStatus = (): void => {
    api.cloudGdriveGetScope().then((r) => {
      if (r.code === 0 && r.data) {
        setGdriveScope(r.data);
      }
    }).catch(() => undefined);
    api.cloudGdriveStatus().then((r) => {
      if (r.code === 0) {
        setGdriveStatus(r.data);
        if (typeof r.data.mirrorEnabled === 'boolean') {
          setMirrorEnabled(r.data.mirrorEnabled);
        }
      }
    }).catch(() => undefined);
  };

  const handleToggleScope = (category: keyof GDriveScope, on: boolean): void => {
    api.cloudGdriveSetScope({ category, on }).then((r) => {
      if (r.code === 0 && r.data) {
        setGdriveScope(r.data);
      }
    }).catch((err) => {
      setGdriveError((err as Error).message || 'Failed to update sync scope');
    });
  };

  const clearAuthPoll = (): void => {
    if (pendingAuthPoll.current !== null) {
      window.clearInterval(pendingAuthPoll.current);
      pendingAuthPoll.current = null;
    }
  };

  useEffect(() => {
    refreshGDriveStatus();
    return () => {
      clearAuthPoll();
    };
  }, []);

  // Polling device auth
  useEffect(() => {
    if (!deviceAuthData) return;
    const intervalSec = Math.max(deviceAuthData.interval || 5, 5);
    const timer = setInterval(() => {
      api.gdrivePollDeviceAuth(deviceAuthData.deviceCode).then((r) => {
        if (r.code === 0 && r.data.status === 'success') {
          setDeviceAuthData(null);
          setGdriveNotice(t('Google Drive synced successfully'));
          refreshGDriveStatus();
        }
      }).catch((err) => {
        setDeviceAuthData(null);
        setGdriveError((err as Error).message || 'Authentication error');
      });
    }, intervalSec * 1000);

    return () => clearInterval(timer);
  }, [deviceAuthData]);

  const handleConnectSubmit = (): void => {
    setPassphraseError('');
    if (passphrase.length < 8) {
      setPassphraseError(t('Passphrase must be at least 8 characters long'));
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setPassphraseError(t('Passphrases do not match'));
      return;
    }

    setGdriveBusy(true);
    setGdriveNotice('');
    setGdriveError('');
    setConnectStep('progress');

    /*
     * One button, one browser window.
     *
     * The request returns as soon as the browser is open, because the operator finishes the consent
     * in another window and that can take minutes — holding the request open would time out their own
     * HTTP client. So the panel switches to a waiting state and polls status; the engine records the
     * outcome, success or failure, in `lastError` where the poll picks it up.
     */
    const initialLastError = gdriveStatus?.lastError ?? null;
    clearAuthPoll();
    setConnectStep('progress');
    pendingAuthPoll.current = window.setInterval(() => {
      api
        .cloudGdriveStatus()
        .then((r) => {
          const status = r.data;
          setGdriveStatus(status);
          if (status.connected && status.unlocked) {
            clearAuthPoll();
            setConnectStep('idle');
            setPassphrase('');
            setConfirmPassphrase('');
            setGdriveNotice(t('Google Drive connected successfully'));
          } else if (status.lastError && status.lastError !== initialLastError) {
            clearAuthPoll();
            setConnectStep('passphrase');
            setGdriveError(status.lastError);
          }
        })
        .catch(() => {
          /* transient: the next tick retries */
        });
    }, 1500);

    api.cloudGdriveAuthorize(passphrase)
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          // Only set when the browser could not be opened automatically, so the operator can finish
          // by hand. The panel renders it next to the waiting state.
          if (r.data?.url) setDeviceAuthData({
            userCode: '',
            verificationUrl: r.data.url,
            deviceCode: '',
            interval: 0,
          });
        } else {
          clearAuthPoll();
          setConnectStep('passphrase');
          setGdriveError(r.msg || t('Connection failed'));
        }
      })
      .catch((err) => {
        clearAuthPoll();
        setGdriveBusy(false);
        setConnectStep('passphrase');
        setGdriveError((err as Error).message || t('Connection failed'));
      });
  };

  const handleConnectCancel = (): void => {
    clearAuthPoll();
    setGdriveBusy(false);
    setConnectStep('passphrase');
    api.cloudGdriveAuthorizeCancel().catch(() => {
      /* ignore cancel error */
    });
  };

  const handleSyncNow = (): void => {
    setGdriveBusy(true);
    setGdriveNotice('');
    setGdriveError('');
    api.cloudGdriveSyncNow()
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setGdriveStatus(r.data);
          setGdriveNotice(t('Sync completed successfully'));
        } else {
          setGdriveError(r.msg || t('Sync failed'));
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveError((err as Error).message || t('Sync failed'));
      });
  };

  const handleUnlockSession = (): void => {
    if (!unlockPassphrase) return;
    setGdriveBusy(true);
    setUnlockError('');
    api.cloudGdriveUnlock(unlockPassphrase)
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setUnlockPassphrase('');
          setGdriveNotice(t('Google Drive sync unlocked for this session'));
          refreshGDriveStatus();
        } else {
          setUnlockError(r.msg || t('Incorrect passphrase'));
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setUnlockError((err as Error).message || t('Incorrect passphrase'));
      });
  };
  const handleVerifyRemote = (): void => {
    setVerifying(true);
    setGdriveBusy(true);
    setGdriveNotice('');
    setGdriveError('');
    api.cloudGdriveVerify()
      .then((r) => {
        setVerifying(false);
        setGdriveBusy(false);
        if (r.code === 0 && r.data?.ok) {
          const rev = r.data.revision ? ` (${r.data.revision})` : '';
          setGdriveNotice(`${t('Verification successful')}: ${t('remote state is valid')}${rev}`);
          refreshGDriveStatus();
        } else {
          const reason = r.data?.reason || r.msg || t('Verification failed');
          setGdriveError(`${t('Verification failed')}: ${reason}`);
        }
      })
      .catch((err: Error) => {
        setVerifying(false);
        setGdriveBusy(false);
        setGdriveError(err.message || t('Verification failed'));
      });
  };

  const closeChangePassphrase = (): void => {
    setChangePassphraseOpen(false);
    setCurrentPassphrase('');
    setNewPassphrase('');
    setChangePassphraseError('');
    setChangePassphraseStep('input');
  };

  const handleChangePassphraseSubmit = (): void => {
    setGdriveBusy(true);
    setChangePassphraseError('');
    setGdriveNotice('');
    setGdriveError('');

    api.cloudGdriveChangePassphrase(currentPassphrase, newPassphrase)
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0 && r.data?.changed) {
          closeChangePassphrase();
          setGdriveNotice(t('Passphrase changed successfully. Backup re-encrypted.'));
          refreshGDriveStatus();
        } else {
          const rawErr = r.data?.reason || r.msg || '';
          if (rawErr.includes('BAD_PASSPHRASE') || (r.code === 400 && rawErr.toLowerCase().includes('passphrase'))) {
            setChangePassphraseStep('input');
            setChangePassphraseError(t('Current passphrase is incorrect. Please check your current passphrase and try again.'));
          } else {
            setChangePassphraseError(rawErr || t('Failed to change passphrase'));
          }
        }
      })
      .catch((err: Error) => {
        setGdriveBusy(false);
        const msg = err.message || '';
        if (msg.includes('BAD_PASSPHRASE')) {
          setChangePassphraseStep('input');
          setChangePassphraseError(t('Current passphrase is incorrect. Please check your current passphrase and try again.'));
        } else {
          setChangePassphraseError(msg || t('Failed to change passphrase'));
        }
      });
  };

  const handleLoadGdriveLog = (): void => {
    setGdriveLogLoading(true);
    api.cloudGdriveLog()
      .then((r) => {
        setGdriveLogLoading(false);
        if (r.code === 0 && r.data?.entries) {
          setGdriveSyncLog(r.data.entries);
          setShowGdriveLog(true);
        } else {
          setGdriveError(r.msg || t('Failed to load sync log'));
        }
      })
      .catch((err: Error) => {
        setGdriveLogLoading(false);
        setGdriveError(err.message || t('Failed to load sync log'));
      });
  };

  const handleToggleMirror = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const enabled = e.target.checked;
    setMirrorEnabled(enabled);
    setGdriveBusy(true);
    setMirrorNotice('');
    api.cloudGdriveMirrorEnable(enabled)
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setMirrorNotice(
            enabled
              ? t('Full Chromium mirror enabled')
              : t('Full Chromium mirror disabled')
          );
          refreshGDriveStatus();
        } else {
          setMirrorEnabled(!enabled);
          setGdriveError(r.msg || t('Failed to update mirror setting'));
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setMirrorEnabled(!enabled);
        setGdriveError((err as Error).message || t('Failed to update mirror setting'));
      });
  };

  const handleRunMirror = (): void => {
    setGdriveBusy(true);
    setMirrorNotice('');
    api.cloudGdriveMirrorRun()
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setMirrorNotice(
            `${t('Chromium mirror backup completed:')} ${formatBytes(r.data.bytes)}`
          );
        } else {
          setGdriveError(r.msg || t('Mirror backup failed'));
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveError((err as Error).message || t('Mirror backup failed'));
      });
  };

  const handleSaveCredentials = (): void => {
    if (!gdriveClientId.trim()) {
      setGdriveError('Client ID cannot be empty');
      return;
    }
    setGdriveBusy(true);
    setGdriveNotice('');
    setGdriveError('');
    api.gdriveSaveCredentials(gdriveClientId.trim(), gdriveClientSecret.trim() || undefined)
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setGdriveNotice(t('Drive credentials saved securely'));
          refreshGDriveStatus();
        } else {
          setGdriveError(r.msg);
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveError((err as Error).message);
      });
  };

  const handleStartDeviceAuth = (): void => {
    setGdriveBusy(true);
    setGdriveNotice('');
    setGdriveError('');
    api.gdriveStartDeviceAuth()
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setDeviceAuthData(r.data);
        } else {
          setGdriveError(r.msg);
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveError((err as Error).message);
      });
  };

  const handleDisconnectGDrive = (): void => {
    setGdriveBusy(true);
    api.gdriveDisconnect()
      .then(() => {
        setGdriveBusy(false);
        setInspection(null);
        refreshGDriveStatus();
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveError((err as Error).message);
      });
  };

  const handleGDrivePush = (): void => {
    setGdriveBusy(true);
    setGdriveNotice('');
    api.gdrivePush()
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setGdriveNotice(
            `${t('Pushed')}: ${r.data.pushedProfiles} ${t('Profiles')}, ${r.data.pushedScripts} scripts`
          );
          refreshGDriveStatus();
        } else {
          setGdriveNotice(r.msg);
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveNotice((err as Error).message);
      });
  };

  const handleInspectPull = (): void => {
    setGdriveBusy(true);
    setGdriveNotice('');
    api.gdriveInspectPull()
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          // SAFETY: inspect-pull response payload conforms to InspectPullResult
          setInspection(r.data as unknown as InspectPullResult);
          if (r.data.unchanged) {
            setGdriveNotice(t('No remote updates detected (local and remote data are identical).'));
          }
        } else {
          setGdriveNotice(r.msg);
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveNotice((err as Error).message);
      });
  };

  const handleExecutePull = (resolution?: 'keep_local' | 'overwrite_remote' | 'cancel'): void => {
    setGdriveBusy(true);
    setGdriveNotice('');
    api.gdrivePull(resolution)
      .then((r) => {
        setGdriveBusy(false);
        if (r.code === 0) {
          setInspection(null);
          setGdriveNotice(
            `${t('Pulled')}: ${r.data.pulledProfiles} ${t('Profiles')}, ${r.data.pulledScripts} scripts`
          );
          refreshGDriveStatus();
        } else {
          setGdriveNotice(r.msg);
        }
      })
      .catch((err) => {
        setGdriveBusy(false);
        setGdriveNotice((err as Error).message);
      });
  };
  const openConfirm = (type: 'disconnect' | 'pull' | 'push'): void => {
    if (type === 'disconnect') {
      setConfirmAction({
        title: t('Disconnect Google Drive'),
        consequences: t(
          'Disconnecting will remove local authorization tokens and pause automatic cloud backups. Your remote files will remain intact on Google Drive.'
        ),
        confirmLabel: t('Disconnect'),
        danger: true,
        onConfirm: () => {
          setConfirmAction(null);
          handleDisconnectGDrive();
        },
      });
    } else if (type === 'pull') {
      setConfirmAction({
        title: t('Pull from Google Drive'),
        consequences: t(
          'This will download remote data and update your local database. Conflicting local changes may be overwritten.'
        ),
        confirmLabel: t('Pull'),
        danger: false,
        onConfirm: () => {
          setConfirmAction(null);
          handleExecutePull();
        },
      });
    } else if (type === 'push') {
      setConfirmAction({
        title: t('Push to Google Drive'),
        consequences: t(
          'This will upload your local database and profile state to Google Drive, updating the remote cloud backup.'
        ),
        confirmLabel: t('Push'),
        danger: false,
        onConfirm: () => {
          setConfirmAction(null);
          handleGDrivePush();
        },
      });
    }
  };

  return (
    <div className="page cloud-sync-page">
      <div className="page-header">
        <h2>{t('Cloud Synchronization')}</h2>
        <span className="page-subtitle">
          {t('Sync browser profiles across machines via Google Drive')}
        </span>
      </div>

      {/* =================================================================== */}
      {/* GOOGLE DRIVE SYNC SECTION (nulltrace-gdrive)                         */}
      {/* =================================================================== */}
      <div className="card" style={{ marginBottom: '20px', borderLeft: '4px solid var(--border-color)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <h3 style={{ margin: 0 }}>{t('Google Drive Sync')}</h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {t('Store profiles, scripts, and settings securely in your personal Google Drive')}
            </span>
          </div>
          {/* Status text badge: Accessible without color alone (has text: [CONFIGURED] / [CONNECTED] / [DISCONNECTED]) */}
          <span className="badge" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {gdriveStatus?.connected
              ? `[CONNECTED] ${gdriveStatus.account || gdriveStatus.userEmail || ''}`
              : gdriveStatus?.configured
              ? '[CONFIGURED / DISCONNECTED]'
              : '[NOT CONNECTED]'}
          </span>
        </div>

        {gdriveNotice && (
          <div className="notice-banner" style={{ marginBottom: '12px', padding: '8px 12px' }}>
            {gdriveNotice}
          </div>
        )}

        {gdriveError && (
          <div
            className="notice-banner"
            style={{
              marginBottom: '12px',
              padding: '8px 12px',
              borderColor: 'var(--danger)',
              color: 'var(--danger)',
            }}
          >
            {gdriveError}
          </div>
        )}

        {/* NOT CONNECTED STATE */}
        {!gdriveStatus?.connected && (
          <div>
            {/* 1. Default View: Exactly ONE prominent button, no Client ID field (R1) */}
            {connectStep === 'idle' && !deviceAuthData && (
              <div>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: '1.5' }}>
                  {t('Sync all your browser profiles, proxies, tags, notes, vault credentials, scripts, and settings automatically to your personal Google Drive.')}
                </p>

                {/* In-product privacy notice. Google requires it prominently displayed here, not
                    buried in settings: it states exactly what Google data the app touches. The
                    policy text behind "Learn more" is the same document linked on the OAuth consent
                    screen, which is also a verification requirement. */}
                <div
                  style={{
                    marginBottom: '16px',
                    padding: '10px 14px',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    background: 'var(--bg-secondary)',
                    fontSize: '12.5px',
                    lineHeight: '1.55',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <strong style={{ display: 'block', marginBottom: '4px', color: 'var(--text)' }}>
                    {t('How Nulltrace uses your Google data')}
                  </strong>
                  {t('Nulltrace stores your encrypted sync data — never your other Drive files — in a folder named "nulltrace data" that only you can read. Google hosts it; it cannot decrypt it.')}
                  {' '}
                  {t('You can revoke access at any time from your Google account; local data stays untouched.')}
                  {' '}
                  <button
                    type="button"
                    onClick={() => openExternalUrl(PRIVACY_POLICY_URL)}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 'inherit', textDecoration: 'underline' }}
                  >
                    {t('Learn more')}
                  </button>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn primary btn-primary"
                    style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '10px' }}
                    onClick={() => {
                      setGdriveError('');
                      setGdriveNotice('');
                      setPassphraseError('');
                      setConnectStep('passphrase');
                    }}
                    disabled={gdriveBusy}
                  >
                    <GoogleGIcon size={18} />
                    {t('Connect Google Drive')}
                  </button>
                </div>

                {/* Collapsed Advanced Disclosure (R1, R6 fallback) */}
                <details
                  style={{
                    marginTop: '24px',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '10px 14px',
                    background: 'var(--bg-secondary)',
                  }}
                >
                  <summary
                    style={{
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '13px',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {t('Advanced: Custom Google OAuth Credentials')}
                  </summary>
                  <div style={{ marginTop: '14px' }}>
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: '1.5' }}>
                      {t('Fallback for development builds or custom Google Cloud projects without a preconfigured client.')}
                    </p>

                    {/* Step-by-step Setup Instructions (R1/2d: ONLY inside advanced disclosure) */}
                    <div
                      style={{
                        background: 'var(--surface-1)',
                        border: '1px solid var(--border)',
                        padding: '12px',
                        borderRadius: '4px',
                        marginBottom: '16px',
                       }}
                    >
                      <strong style={{ display: 'block', marginBottom: '6px', fontSize: '12.5px' }}>
                        {t('Setup Instructions')}:
                      </strong>
                      <ol style={{ margin: 0, paddingLeft: '18px', fontSize: '12.5px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
                        <li>{t('1. Create a Google Cloud project or use an existing one in the Google Cloud Console.')}</li>
                        <li>{t('2. Enable the Google Drive API for your project.')}</li>
                        <li>{t('3. Configure an OAuth consent screen (External, add drive.file scope).')}</li>
                        <li>{t('4. Create OAuth 2.0 credentials (Desktop Application or TV/Limited Input Device).')}</li>
                        <li>{t('5. Create a client of type DESKTOP app (not TV/Limited Input) in Google Cloud Console, then paste the Client ID below. No secret is needed: this app proves itself with PKCE.')}</li>
                      </ol>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <label style={{ width: '160px', fontSize: '13px' }}>{t('OAuth Client ID')}:</label>
                        <input
                          type="text"
                          value={gdriveClientId}
                          onChange={(e) => setGdriveClientId(e.target.value)}
                          placeholder="xxxx.apps.googleusercontent.com"
                          style={{ flex: 1 }}
                          disabled={gdriveBusy}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <label style={{ width: '160px', fontSize: '13px' }}>{t('Client Secret (only for a TVs and Limited Input devices client)')}:</label>
                        <input
                          type="password"
                          value={gdriveClientSecret}
                          onChange={(e) => setGdriveClientSecret(e.target.value)}
                          placeholder="(Optional for Desktop Client)"
                          style={{ flex: 1 }}
                          disabled={gdriveBusy}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={handleSaveCredentials}
                          disabled={gdriveBusy || !gdriveClientId.trim()}
                        >
                          {t('Save Credentials')}
                        </button>
                        {gdriveStatus?.configured && !deviceAuthData && (
                          <button
                            type="button"
                            className="btn"
                            onClick={handleStartDeviceAuth}
                            disabled={gdriveBusy}
                          >
                            {t('Start Device Authorization')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            )}

            {/* 2. Passphrase Step (min 8 chars, entered twice, data loss warning per 2a & 2e) */}
            {connectStep === 'passphrase' && (
              <div
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '16px',
                  marginBottom: '16px',
                }}
              >
                <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>
                  {t('Set Encryption Passphrase')}
                </h4>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 12px 0', lineHeight: '1.5' }}>
                  {t('Your sync data is encrypted client-side with AES-256-GCM before being sent to Google Drive. Google never sees your passwords, cookies, or profile data.')}
                </p>

                {/* Crucial Data-loss Warning Box (Requirement 2e & Acceptance) */}
                <div
                  style={{
                    background: 'var(--danger-bg)',
                    border: '1px solid var(--danger)',
                    borderRadius: '6px',
                    padding: '12px 14px',
                    marginBottom: '16px',
                  }}
                >
                  <strong style={{ color: 'var(--danger)', display: 'block', marginBottom: '6px', fontSize: '13.5px' }}>
                    ⚠️ {t('Important: Non-Recoverable Passphrase')}
                  </strong>
                  <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
                    {t('The passphrase is not stored anywhere. It is required on every machine to decrypt your data. If you forget this passphrase, your Google Drive backup cannot be restored and data will be permanently lost.')}
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '440px', marginBottom: '16px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>
                      {t('Passphrase (minimum 8 characters)')}:
                    </label>
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder={t('Enter passphrase')}
                      disabled={gdriveBusy}
                      style={{ width: '100%' }}
                      autoFocus
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>
                      {t('Confirm Passphrase')}:
                    </label>
                    <input
                      type="password"
                      value={confirmPassphrase}
                      onChange={(e) => setConfirmPassphrase(e.target.value)}
                      placeholder={t('Repeat passphrase')}
                      disabled={gdriveBusy}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>

                {passphraseError && (
                  <div style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '14px', fontWeight: 500 }}>
                    {passphraseError}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn primary btn-primary"
                    onClick={handleConnectSubmit}
                    disabled={gdriveBusy || passphrase.length < 8 || passphrase !== confirmPassphrase}
                  >
                    {gdriveBusy ? t('Connecting…') : t('Confirm & Connect')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setConnectStep('idle');
                      setPassphrase('');
                      setConfirmPassphrase('');
                      setPassphraseError('');
                    }}
                    disabled={gdriveBusy}
                  >
                    {t('Cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* 3. Connecting progress state */}
            {connectStep === 'progress' && (
              <div
                style={{
                  padding: '24px 16px',
                  textAlign: 'center',
                  background: 'var(--bg-secondary)',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                }}
              >
                <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>
                  {t('Connecting to Google Drive...')}
                </h4>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                  {t('Please wait while your connection is established. If a browser window opened, follow the instructions to grant access.')}
                </p>
                <div style={{ marginTop: '16px' }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={handleConnectCancel}
                  >
                    {t('Cancel')}
                  </button>
                </div>
              </div>
            )}

            {/* 4. Active Device Auth flow dialog (if initiated) */}
            {deviceAuthData && (
              <div style={{ border: '1px solid var(--border-color)', padding: '16px', borderRadius: '4px', marginBottom: '16px', background: 'var(--bg-secondary)' }}>
                <h4>{t('Authorizing Google Drive...')}</h4>
                <p style={{ margin: '8px 0', fontSize: '13px' }}>
                  {t('To authorize, open the following URL in any browser:')}
                </p>
                <div style={{ margin: '8px 0', wordBreak: 'break-all' }}>
                  <a href={deviceAuthData.verificationUrl} target="_blank" rel="noreferrer">
                    {deviceAuthData.verificationUrl}
                  </a>
                </div>
                <p style={{ margin: '8px 0', fontSize: '14px' }}>
                  <strong>{t('Enter Code:')}</strong>{' '}
                  <span style={{ fontSize: '18px', letterSpacing: '0.1em', fontWeight: 'bold' }}>
                    {deviceAuthData.userCode}
                  </span>
                </p>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {t('Waiting for approval in browser...')}
                </p>
                <button type="button" className="btn" onClick={() => setDeviceAuthData(null)}>
                  {t('Cancel Authorization')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* CONNECTED STATE (Requirement 2c) */}
        {gdriveStatus?.connected && (
          <div>
            {/* Session locked warning / unlock form */}
            {gdriveStatus.unlocked === false && (
              <div
                style={{
                  background: 'var(--warn-bg))',
                  border: '1px solid var(--warn)',
                  borderRadius: '6px',
                  padding: '12px 14px',
                  marginBottom: '16px',
                }}
              >
                <strong style={{ display: 'block', color: 'var(--warn)', marginBottom: '6px', fontSize: '13.5px' }}>
                  🔒 {t('Unlock Sync')}
                </strong>
                <p style={{ margin: '0 0 10px 0', fontSize: '13px', color: 'var(--text)' }}>
                  {t('Enter your passphrase to unlock synchronization for this session:')}
                </p>
                <div style={{ display: 'flex', gap: '8px', maxWidth: '400px' }}>
                  <input
                    type="password"
                    value={unlockPassphrase}
                    onChange={(e) => setUnlockPassphrase(e.target.value)}
                    placeholder={t('Enter passphrase')}
                    disabled={gdriveBusy}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="btn primary btn-primary"
                    onClick={handleUnlockSession}
                    disabled={gdriveBusy || !unlockPassphrase}
                  >
                    {gdriveBusy ? t('Syncing…') : t('Unlock Sync')}
                  </button>
                </div>
                {unlockError && (
                  <div style={{ color: 'var(--danger)', fontSize: '12px', marginTop: '6px' }}>
                    {unlockError}
                  </div>
                )}
              </div>
            )}

            {/* R02: one status card — connection, account, last sync, conflicts at a glance */}
            <div
              style={{
                padding: '14px 16px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                marginBottom: '16px',
              }}
            >
              <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'baseline', marginBottom: '12px' }}>
                <span style={{ fontSize: '13px' }}>
                  <span style={{ color: 'var(--ok)', fontWeight: 700 }}>● {t('Connected')}</span>
                  {' · '}
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {gdriveStatus.account || gdriveStatus.userEmail || t('OAuth Connected')}
                  </span>
                </span>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                  {t('Last Synced')}:{' '}
                  <strong style={{ color: 'var(--text)', fontWeight: 600 }}>
                    {formatRelativeTime(
                      gdriveStatus.lastSyncAt || gdriveStatus.lastPushTimestamp || gdriveStatus.lastPullTimestamp,
                      t
                    )}
                  </strong>
                </span>
                {typeof gdriveStatus.conflicts === 'number' && gdriveStatus.conflicts > 0 && (
                  <span style={{ fontSize: '13px', color: 'var(--warn)', fontWeight: 600 }}>
                    ⚠️ {gdriveStatus.conflicts} {t('conflicts')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn primary btn-primary"
                  onClick={handleSyncNow}
                  disabled={gdriveBusy || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
                  style={{ padding: '10px 28px', fontSize: '14px', fontWeight: 600 }}
                  title={
                    !gdriveStatus.unlocked
                      ? t('Google Drive session is locked. Enter your passphrase to unlock.')
                      : gdriveStatus.syncing
                      ? t('Sync in progress...')
                      : undefined
                  }
                >
                  {gdriveBusy || gdriveStatus.syncing ? t('Syncing…') : t('Sync now')}
                </button>
                {!gdriveStatus.unlocked && (
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    🔒 {t('Session locked — unlock above to sync')}
                  </span>
                )}
                {Boolean(gdriveStatus.syncing) && !gdriveBusy && (
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    ⏳ {t('Sync in progress...')}
                  </span>
                )}
              </div>
            </div>

            {gdriveStatus.syncing && (
              <div className="notice-banner" style={{ marginBottom: '12px' }}>
                {t('Sync in progress...')}
              </div>
            )}

            {/* R05: human sentence + Details disclosure + Retry, never a bare technical message */}
            {gdriveStatus.lastError && (
              <div
                className="notice-banner"
                style={{ marginBottom: '12px', borderColor: 'var(--danger)', color: 'var(--danger)' }}
              >
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>
                    <strong>{t('Sync Error')}:</strong> {getHumanSyncErrorMessage(gdriveStatus.lastError, t)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={handleSyncNow}
                    disabled={gdriveBusy || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
                  >
                    {t('Retry')}
                  </button>
                </div>
                <details style={{ marginTop: '8px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--text-muted)' }}>
                    {t('Details')}
                  </summary>
                  <code
                    style={{
                      display: 'block',
                      marginTop: '6px',
                      padding: '8px 10px',
                      background: 'var(--bg-secondary)',
                      borderRadius: '4px',
                      fontSize: '11.5px',
                      wordBreak: 'break-all',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {gdriveStatus.lastError}
                  </code>
                </details>
              </div>
            )}

            {Boolean(gdriveStatus.pendingRemoteChanges && gdriveStatus.pendingRemoteChanges > 0) && (
              <div className="notice-banner" style={{ marginBottom: '12px' }}>
                {gdriveStatus.pendingRemoteChanges} {t('pending remote updates waiting to be pulled.')}
              </div>
            )}
            {Boolean(gdriveStatus.conflicts && gdriveStatus.conflicts > 0) && (
              <div
                className="notice-banner"
                style={{ marginBottom: '12px', borderColor: 'var(--warn)', color: 'var(--warn)' }}
              >
                ⚠️ {gdriveStatus.conflicts} {t('conflicts detected in sync data.')}
              </div>
            )}

            {/* Sync Scope */}
            <div
              style={{
                padding: '14px 16px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                marginBottom: '16px',
              }}
            >
              <div style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--text)' }}>
                  {t('Sync Scope')}
                </h4>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {t('Choose which data categories synchronize with Google Drive on this machine')}
                </div>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                  gap: '8px',
                }}
              >
                {[
                  { key: 'profiles' as const, label: 'Profiles', desc: 'Browser profiles and launch bundles' },
                  { key: 'proxies' as const, label: 'Proxies', desc: 'Proxy configurations and credentials' },
                  { key: 'vault' as const, label: 'Vault credentials', desc: 'Saved account logins and passwords' },
                  { key: 'scripts' as const, label: 'Scripts', desc: 'Automation scripts and scheduled triggers' },
                  { key: 'library' as const, label: 'Tags/Groups/Extensions', desc: 'Tags, groups, and browser extensions' },
                  { key: 'settings' as const, label: 'App settings', desc: 'Syncable application preferences' },
                ].map(({ key, label, desc }) => (
                  <label
                    key={key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      background: 'var(--surface-1)',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      cursor: gdriveBusy ? 'default' : 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <div style={{ marginRight: '12px', minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>{t(label)}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{t(desc)}</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={gdriveScope[key]}
                      disabled={gdriveBusy}
                      onChange={(e) => handleToggleScope(key, e.target.checked)}
                      style={{ width: '16px', height: '16px', cursor: gdriveBusy ? 'default' : 'pointer', flexShrink: 0 }}
                    />
                  </label>
                ))}
              </div>
            </div>

            {/* R03: secondary operations behind a collapsed Advanced disclosure. Sync now lives
                in the status card above; panels (passphrase/log/inspection/mirror) stay outside
                so they render wherever their toggle lives. */}
            <details
              style={{
                marginBottom: '16px',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '10px 14px',
                background: 'var(--bg-secondary)',
              }}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '13px', color: 'var(--text-muted)' }}>
                {t('Advanced')}
              </summary>
              {!gdriveStatus.unlocked && (
                <div
                  className="notice-banner"
                  style={{ marginTop: '10px', marginBottom: '8px', borderColor: 'var(--warn)', color: 'var(--warn)' }}
                >
                  🔒 {t('Actions disabled: Google Drive session is locked. Enter your passphrase above to unlock.')}
                </div>
              )}
              {Boolean(gdriveStatus.syncing) && (
                <div
                  className="notice-banner"
                  style={{ marginTop: '10px', marginBottom: '8px' }}
                >
                  ⏳ {t('Actions disabled: sync is currently in progress.')}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleVerifyRemote}
                  disabled={gdriveBusy || verifying || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
                >
                  {verifying ? t('Verifying…') : t('Verify')}
                </button>
              <button
                type="button"
                className="btn"
                onClick={handleInspectPull}
                disabled={gdriveBusy || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
              >
                {t('Check for Remote Updates')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => openConfirm('pull')}
                disabled={gdriveBusy || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
              >
                {t('Pull from Google Drive')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => openConfirm('push')}
                disabled={gdriveBusy || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
              >
                {t('Push to Google Drive')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={showGdriveLog ? () => setShowGdriveLog(false) : handleLoadGdriveLog}
                disabled={gdriveLogLoading}
              >
                {gdriveLogLoading ? t('Loading log…') : showGdriveLog ? t('Hide Sync Log') : t('Sync Log')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (changePassphraseOpen) {
                    closeChangePassphrase();
                  } else {
                    setChangePassphraseOpen(true);
                    setChangePassphraseStep('input');
                    setChangePassphraseError('');
                  }
                }}
                disabled={gdriveBusy || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
              >
                {t('Change Passphrase')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => openConfirm('disconnect')}
                disabled={gdriveBusy || Boolean(gdriveStatus.syncing)}
              >
                {t('Disconnect Google Drive')}
              </button>
              </div>

              {/* R06: mirror lives inside Advanced, collapsed by default with it */}

            {/* Full Chromium Mirror section (Requirement 2f & R4 deviation) */}
            <div
              style={{
                marginTop: '20px',
                padding: '16px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
                    {t('Full Chromium Directory Mirror (Experimental)')}
                  </h4>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {t('Optional full backup of profile directories in addition to standard portable sync')}
                  </span>
                </div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={mirrorEnabled}
                    onChange={handleToggleMirror}
                    disabled={gdriveBusy}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>
                    {mirrorEnabled ? t('Enabled') : t('Disabled (Default)')}
                  </span>
                </label>
              </div>

              {/* Measured cost comparison breakdown (304 KB vs 795 MB) */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '10px',
                  margin: '12px 0',
                }}
              >
                <div style={{ padding: '10px', background: 'var(--surface-1)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    {t('Standard Portable Sync (Active)')}
                  </div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--ok)' }}>
                    ~304 KB
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px', lineHeight: '1.4' }}>
                    {t('Database, profiles, proxies, fingerprints, groups, tags, notes, vault credentials, scripts, settings, and session cookies.')}
                  </div>
                </div>

                <div style={{ padding: '10px', background: 'var(--surface-1)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    {t('Chromium Directory Mirror')}
                  </div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: mirrorEnabled ? 'var(--warn)' : 'var(--text-muted)' }}>
                    ~795 MB
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '4px', lineHeight: '1.4' }}>
                    {t('Full profile directories including HTTP/code caches and internal runtime files.')}
                  </div>
                </div>
              </div>

              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 10px 0', lineHeight: '1.5' }}>
                ℹ️ {t('Note: Chromium caches (~400 MB) are automatically regenerated on the target machine anyway and are not needed to restore profiles.')}
              </p>

              {mirrorEnabled && (
                <div
                  style={{
                    background: 'var(--warn-bg))',
                    border: '1px solid var(--warn)',
                    borderRadius: '4px',
                    padding: '12px',
                    marginTop: '10px',
                  }}
                >
                  <strong style={{ display: 'block', color: 'var(--warn)', marginBottom: '4px', fontSize: '13px' }}>
                    ⚠️ {t('Warning: High Storage & Machine Binding Restrictions')}
                  </strong>
                  <p style={{ margin: 0, fontSize: '12.5px', lineHeight: '1.5', color: 'var(--text)' }}>
                    {t('Full Chromium mirroring is significantly slower (~795 MB) and consumes cloud quota. Furthermore, raw Chromium cookies are encrypted via Windows DPAPI (tied to the local machine), and Device Bound Sessions are machine-bound, so cookies from Chromium directories may still not transfer to another computer. Standard portable sync (~304 KB) already transfers active sessions safely.')}
                  </p>
                  <div style={{ marginTop: '10px' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={handleRunMirror}
                      disabled={gdriveBusy || !gdriveStatus.unlocked || Boolean(gdriveStatus.syncing)}
                    >
                      {t('Run Chromium Mirror Backup Now')}
                    </button>
                  </div>
                </div>
              )}

              {mirrorNotice && (
                <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--ok)' }}>
                  {mirrorNotice}
                </div>
              )}
            </div>
            </details>

            {/* R04: confirmation dialog for destructive/directional actions */}
            {confirmAction && (
              <Modal
                title={confirmAction.title}
                onClose={() => setConfirmAction(null)}
                footer={
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
                    <button type="button" className="btn" onClick={() => setConfirmAction(null)}>
                      {t('Cancel')}
                    </button>
                    <button type="button" className="btn primary" onClick={confirmAction.onConfirm}>
                      {confirmAction.confirmLabel}
                    </button>
                  </div>
                }
              >
                <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.55', color: 'var(--text-secondary)' }}>
                  {confirmAction.consequences}
                </p>
              </Modal>
            )}

            {/* Change Passphrase Dialog */}
            {changePassphraseOpen && (
              <div
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '16px',
                  marginBottom: '16px',
                }}
              >
                <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>
                  {t('Change Passphrase')}
                </h4>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 12px 0', lineHeight: '1.5' }}>
                  {t('Re-encrypt your Google Drive backup with a new passphrase.')}
                </p>

                {changePassphraseStep === 'input' && (
                  <div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '440px', marginBottom: '16px' }}>
                      <div>
                        <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>
                          {t('Current Passphrase')}:
                        </label>
                        <input
                          type="password"
                          value={currentPassphrase}
                          onChange={(e) => setCurrentPassphrase(e.target.value)}
                          placeholder={t('Enter current passphrase')}
                          disabled={gdriveBusy}
                          style={{ width: '100%' }}
                          autoFocus
                        />
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>
                          {t('New Passphrase (minimum 8 characters)')}:
                        </label>
                        <input
                          type="password"
                          value={newPassphrase}
                          onChange={(e) => setNewPassphrase(e.target.value)}
                          placeholder={t('Enter new passphrase')}
                          disabled={gdriveBusy}
                          style={{ width: '100%' }}
                        />
                      </div>
                    </div>

                    {changePassphraseError && (
                      <div style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '14px', fontWeight: 500 }}>
                        {changePassphraseError}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        className="btn primary btn-primary"
                        onClick={() => {
                          if (!currentPassphrase) {
                            setChangePassphraseError(t('Please enter your current passphrase'));
                            return;
                          }
                          if (newPassphrase.length < 8) {
                            setChangePassphraseError(t('New passphrase must be at least 8 characters long'));
                            return;
                          }
                          if (newPassphrase === currentPassphrase) {
                            setChangePassphraseError(t('New passphrase must be different from current passphrase'));
                            return;
                          }
                          setChangePassphraseError('');
                          setChangePassphraseStep('confirm');
                        }}
                        disabled={gdriveBusy || !currentPassphrase || newPassphrase.length < 8}
                      >
                        {t('Continue')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={closeChangePassphrase}
                        disabled={gdriveBusy}
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  </div>
                )}

                {changePassphraseStep === 'confirm' && (
                  <div>
                    <div
                      style={{
                        background: 'var(--danger-bg)',
                        border: '1px solid var(--danger)',
                        borderRadius: '6px',
                        padding: '12px 14px',
                        marginBottom: '16px',
                      }}
                    >
                      <strong style={{ color: 'var(--danger)', display: 'block', marginBottom: '6px', fontSize: '13.5px' }}>
                        ⚠️ {t('Confirm Passphrase Change')}
                      </strong>
                      <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--text)' }}>
                        {t('Your Google Drive backup will be re-encrypted under the new passphrase. You will need this new passphrase on all other devices. If you lose it, cloud data cannot be restored.')}
                      </p>
                    </div>

                    {changePassphraseError && (
                      <div style={{ color: 'var(--danger)', fontSize: '13px', marginBottom: '14px', fontWeight: 500 }}>
                        {changePassphraseError}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        className="btn primary btn-primary"
                        onClick={handleChangePassphraseSubmit}
                        disabled={gdriveBusy}
                      >
                        {gdriveBusy ? t('Updating Passphrase…') : t('Confirm & Change Passphrase')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setChangePassphraseError('');
                          setChangePassphraseStep('input');
                        }}
                        disabled={gdriveBusy}
                      >
                        {t('Back')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={closeChangePassphrase}
                        disabled={gdriveBusy}
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Google Drive Sync Log Panel */}
            {showGdriveLog && (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '14px',
                  marginBottom: '16px',
                  background: 'var(--bg-secondary)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
                    {t('Google Drive Sync Log')}
                  </h4>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={handleLoadGdriveLog}
                      disabled={gdriveLogLoading}
                    >
                      {gdriveLogLoading ? t('Refreshing…') : t('Refresh')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setShowGdriveLog(false)}
                    >
                      {t('Close')}
                    </button>
                  </div>
                </div>

                {gdriveSyncLog && gdriveSyncLog.length === 0 ? (
                  <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                    {t('No sync log entries recorded yet.')}
                  </div>
                ) : gdriveSyncLog ? (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                          <th style={{ padding: '6px 8px' }}>{t('Time')}</th>
                          <th style={{ padding: '6px 8px' }}>{t('Direction')}</th>
                          <th style={{ padding: '6px 8px' }}>{t('Outcome')}</th>
                          <th style={{ padding: '6px 8px' }}>{t('Pushed')}</th>
                          <th style={{ padding: '6px 8px' }}>{t('Pulled')}</th>
                          <th style={{ padding: '6px 8px' }}>{t('Conflicts')}</th>
                          <th style={{ padding: '6px 8px' }}>{t('Error')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gdriveSyncLog.map((entry) => (
                          <tr key={entry.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }} title={new Date(entry.at).toLocaleString()}>
                              {formatRelativeTime(entry.at, t)}
                            </td>
                            <td style={{ padding: '6px 8px', textTransform: 'capitalize' }}>
                              {t(entry.direction)}
                            </td>
                            <td style={{ padding: '6px 8px' }}>
                              <span
                                style={{
                                  display: 'inline-block',
                                  padding: '2px 6px',
                                  borderRadius: '3px',
                                  fontSize: '11px',
                                  fontWeight: 600,
                                  background: entry.outcome === 'ok' ? 'var(--ok-bg)' : 'var(--danger-bg)',
                                  color: entry.outcome === 'ok' ? 'var(--ok)' : 'var(--danger)',
                                }}
                              >
                                {t(entry.outcome)}
                              </span>
                            </td>
                            <td style={{ padding: '6px 8px' }}>{entry.rowsPushed}</td>
                            <td style={{ padding: '6px 8px' }}>{entry.rowsPulled}</td>
                            <td style={{ padding: '6px 8px', color: entry.conflicts > 0 ? 'var(--warn)' : 'inherit' }}>
                              {entry.conflicts}
                            </td>
                            <td
                              style={{
                                padding: '6px 8px',
                                color: 'var(--danger)',
                                maxWidth: '200px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={entry.error || ''}
                            >
                              {entry.error || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            )}

            {/* Inspection details / Conflict Resolution Dialog */}
            {inspection && (
              <div style={{ border: '1px solid var(--border-color)', padding: '16px', borderRadius: '4px', marginBottom: '16px' }}>
                <h4 style={{ margin: '0 0 8px 0' }}>{t('Remote Data Inspection')}</h4>
                <div style={{ fontSize: '13px', lineHeight: '1.6' }}>
                  <div>{t('Remote Timestamp:')} {inspection.remoteTimestamp ? new Date(inspection.remoteTimestamp).toLocaleString() : '—'}</div>
                  <div>{t('Remote Profiles:')} {inspection.profileCount ?? 0} ({t('New Profiles to add:')} {inspection.newProfiles ?? 0})</div>
                  <div>{t('Remote Scripts:')} {inspection.scriptCount ?? 0} ({t('New Scripts to add:')} {inspection.newScripts ?? 0})</div>
                </div>

                {Array.isArray(inspection.conflicts) && inspection.conflicts.length > 0 && (
                  <div style={{ marginTop: '12px', padding: '12px', background: 'var(--bg-secondary)', borderRadius: '4px' }}>
                    <strong style={{ color: 'var(--text)', display: 'block', marginBottom: '6px' }}>
                      {t('Local changes detected that conflict with remote data:')}
                    </strong>
                    <ul style={{ margin: '0 0 12px 0', paddingLeft: '18px', fontSize: '12px' }}>
                      {inspection.conflicts.map((c, idx) => {
                        const tableLabel = c.table || (c.type ? String(c.type) : t('Entry'));
                        const keyLabel = c.key || c.name || c.id || `#${idx + 1}`;
                        const localHash = c.localHash || '';
                        const remoteHash = c.remoteHash || '';
                        const hasHashes = Boolean(localHash || remoteHash);

                        return (
                          <li key={`${tableLabel}-${keyLabel}-${idx}`} style={{ marginBottom: '6px' }}>
                            <div>
                              <strong>{tableLabel}</strong>: <code>{keyLabel}</code>
                            </div>
                            {hasHashes && (
                              <details style={{ marginTop: '2px', color: 'var(--text-secondary)' }}>
                                <summary style={{ cursor: 'pointer', fontSize: '11px' }}>
                                  {t('Hash details')}
                                </summary>
                                <div style={{ fontSize: '11px', fontFamily: 'monospace', paddingLeft: '8px', marginTop: '4px' }}>
                                  <div>{t('Local')}: {localHash || '—'}</div>
                                  <div>{t('Remote')}: {remoteHash || '—'}</div>
                                </div>
                              </details>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => handleExecutePull('overwrite_remote')}
                        disabled={gdriveBusy}
                      >
                        {t('Overwrite Local Data')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => handleExecutePull('keep_local')}
                        disabled={gdriveBusy}
                      >
                        {t('Keep Local (Skip Conflicts)')}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setInspection(null)}
                        disabled={gdriveBusy}
                      >
                        {t('Cancel Pull')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
};

export default CloudSync;
