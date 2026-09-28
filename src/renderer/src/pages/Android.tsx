import { useEffect, useState, useCallback, useRef } from 'react';
import {
  api,
  type AndroidEngineStatus,
  type AndroidInstanceStatus,
  type AndroidStreamTicket,
  type ProfileListItem,
} from '../api';
import { useI18n } from '../i18n';
import { DevicesIcon, PlayIcon, StopIcon, RefreshIcon } from '../icons';
import { AndroidCanvas } from '../components/AndroidCanvas';
import type { AndroidStreamStatus } from '../androidStream';

export interface AndroidPageProps {
  profileId: string;
  profileName?: string | null;
}

export function AndroidPage(props: AndroidPageProps): JSX.Element {
  const { t } = useI18n();

  const [activeProfileId, setActiveProfileId] = useState<string>(props.profileId || '');
  const [activeProfileName, setActiveProfileName] = useState<string | null>(props.profileName || null);
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);

  const [engineStatus, setEngineStatus] = useState<AndroidEngineStatus | null>(null);
  const [loadingEngine, setLoadingEngine] = useState<boolean>(false);
  const [installingEngine, setInstallingEngine] = useState<boolean>(false);

  const [instanceStatus, setInstanceStatus] = useState<AndroidInstanceStatus | null>(null);
  const [startingInstance, setStartingInstance] = useState<boolean>(false);
  const [stoppingInstance, setStoppingInstance] = useState<boolean>(false);

  const [streamTicket, setStreamTicket] = useState<AndroidStreamTicket | null>(null);
  const [streamStatus, setStreamStatus] = useState<AndroidStreamStatus | null>(null);
  const [streamMessage, setStreamMessage] = useState<string>('');

  const [error, setError] = useState<string>('');

  // Synchronize when parent passes a new profileId
  useEffect(() => {
    if (props.profileId) {
      setActiveProfileId(props.profileId);
      if (props.profileName !== undefined) {
        setActiveProfileName(props.profileName);
      }
    }
  }, [props.profileId, props.profileName]);

  // Load profiles list when profileId was not supplied by parent
  useEffect(() => {
    if (!props.profileId) {
      api.list({ page: 1, pageSize: 500 })
        .then((res) => {
          if (res.code === 0 && res.data?.list) {
            const androidList = res.data.list.filter((p) => p.browser_type === 'android');
            setProfiles(androidList);
            setActiveProfileId((prev) => {
              if (prev) return prev;
              const androidProfile = androidList[0];
              return androidProfile ? androidProfile.user_id : '';
            });
          }
        })
        .catch(() => undefined);
    }
  }, [props.profileId]);

  // Update profile name when active profile changes
  useEffect(() => {
    if (activeProfileId && !props.profileName && profiles.length > 0) {
      const match = profiles.find((p) => p.user_id === activeProfileId);
      if (match) {
        setActiveProfileName(match.name);
      }
    }
  }, [activeProfileId, props.profileName, profiles]);

  // Load Android engine status
  const loadEngine = useCallback(async () => {
    setLoadingEngine(true);
    try {
      const res = await api.androidEngine();
      if (res.code === 0 && res.data) {
        setEngineStatus(res.data);
      } else if (res.msg) {
        setError(res.msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoadingEngine(false);
    }
  }, []);

  useEffect(() => {
    void loadEngine();
  }, [loadEngine]);

  // Acquire stream ticket for running instance
  const acquireTicket = useCallback(async (profileId: string) => {
    if (!profileId) return;
    try {
      const res = await api.androidStreamTicket(profileId);
      if (res.code === 0 && res.data) {
        setStreamTicket(res.data);
        setError('');
      } else {
        const isNotReady =
          (res as { code?: unknown }).code === 'NOT_READY' ||
          (res as { code?: unknown }).code === 409 ||
          (res.data as { code?: unknown })?.code === 'NOT_READY' ||
          (typeof res.msg === 'string' && res.msg.toLowerCase().includes('not_ready'));
        if (isNotReady) {
          setError('engine not installed');
        } else if (res.msg) {
          setError(res.msg);
        }
      }
    } catch (err: unknown) {
      const errObj = err as { code?: string; status?: number; message?: string };
      const msg = errObj?.message || String(err);
      if (
        errObj?.code === 'NOT_READY' ||
        errObj?.status === 409 ||
        msg.includes('NOT_READY') ||
        msg.toLowerCase().includes('not_ready')
      ) {
        setError('engine not installed');
      } else {
        setError(msg);
      }
    }
  }, []);

  // Poll instance status
  const checkStatus = useCallback(
    async (profileId: string) => {
      if (!profileId) return;
      try {
        const res = await api.androidStatus(profileId);
        if (res.code === 0 && res.data) {
          setInstanceStatus(res.data);
          if (res.data.state === 'running' && !streamTicket) {
            void acquireTicket(profileId);
          } else if (res.data.state === 'stopped') {
            setStreamTicket(null);
          } else if (res.data.state === 'error') {
            setStreamTicket(null);
            if (res.data.error) {
              if (res.data.error.code === 'NOT_READY') {
                setError('engine not installed');
              } else {
                setError(res.data.error.message || res.data.error.code);
              }
            }
          }
        } else if ((res as { code?: unknown }).code === 404 || (res as { code?: unknown }).code === 'NOT_FOUND') {
          setInstanceStatus(null);
          setStreamTicket(null);
        }
      } catch {
        // Instance not found or not running
      }
    },
    [streamTicket, acquireTicket]
  );

  // Check initial instance status on activeProfileId change
  useEffect(() => {
    if (activeProfileId) {
      void checkStatus(activeProfileId);
    }
  }, [activeProfileId, checkStatus]);

  // Polling while starting or booting
  useEffect(() => {
    if (!activeProfileId) return;
    if (instanceStatus?.state === 'starting' || instanceStatus?.state === 'booting') {
      const timer = setInterval(() => {
        void checkStatus(activeProfileId);
      }, 2000);
      return () => clearInterval(timer);
    }
  }, [activeProfileId, instanceStatus?.state, checkStatus]);

  // Install engine handler
  const handleEngineInstall = async () => {
    setInstallingEngine(true);
    setError('');
    try {
      const res = await api.androidEngineInstall();
      if (res.code !== 0) {
        // Must surface the exact backend error message text verbatim (e.g. ERR_ANDROID_DIGEST_UNPINNED)
        setError(res.msg || 'Engine installation failed');
      } else {
        await loadEngine();
      }
    } catch (err: unknown) {
      // Must surface the exact backend error message text verbatim
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setInstallingEngine(false);
    }
  };

  // Start instance handler
  const handleStart = async () => {
    if (!activeProfileId) return;
    setStartingInstance(true);
    setError('');
    try {
      const res = await api.androidStart(activeProfileId);
      const isNotReady =
        (res as { code?: unknown }).code === 'NOT_READY' ||
        (res as { code?: unknown }).code === 409 ||
        (res.data as { code?: unknown })?.code === 'NOT_READY' ||
        ((res as { error?: { code?: string } }).error?.code === 'NOT_READY') ||
        (typeof res.msg === 'string' && (
          res.msg === 'NOT_READY' ||
          res.msg.includes('NOT_READY') ||
          res.msg.toLowerCase().includes('not_ready')
        ));

      if (isNotReady) {
        setError('engine not installed');
        setStartingInstance(false);
        return;
      }

      if (res.code !== 0) {
        // Surface verbatim backend error text
        setError(res.msg || (res.data as { message?: string })?.message || 'Failed to start Android profile');
        setStartingInstance(false);
        return;
      }

      if (res.data) {
        setInstanceStatus(res.data);
        if (res.data.state === 'running') {
          void acquireTicket(activeProfileId);
        }
      }
    } catch (err: unknown) {
      const errObj = err as { code?: string; status?: number; message?: string };
      const msg = errObj?.message || (err instanceof Error ? err.message : String(err));
      if (
        errObj?.code === 'NOT_READY' ||
        errObj?.status === 409 ||
        msg.includes('NOT_READY') ||
        msg.toLowerCase().includes('not_ready')
      ) {
        setError('engine not installed');
      } else {
        // Surface verbatim backend error text
        setError(msg);
      }
    } finally {
      setStartingInstance(false);
    }
  };

  // Stop instance handler
  const handleStop = async () => {
    if (!activeProfileId) return;
    setStoppingInstance(true);
    setError('');
    try {
      const res = await api.androidStop(activeProfileId);
      if (res.code === 0) {
        setStreamTicket(null);
        setInstanceStatus(null);
        setStreamStatus(null);
        setStreamMessage('');
      } else {
        setError(res.msg || 'Failed to stop Android profile');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setStoppingInstance(false);
    }
  };

  const isRunning = instanceStatus?.state === 'running';
  const isTransitioning =
    startingInstance ||
    stoppingInstance ||
    instanceStatus?.state === 'starting' ||
    instanceStatus?.state === 'booting';

  return (
    <div>
      {/* Header */}
      <div className="page-header-actions" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DevicesIcon size={22} style={{ color: 'var(--text-secondary)' }} />
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>{t('Android Emulator')}</h2>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              {t('Isolated headless Android guest streamed via WebCodecs & scrcpy.')}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void loadEngine();
              if (activeProfileId) void checkStatus(activeProfileId);
            }}
            disabled={loadingEngine}
            title={t('Refresh')}
          >
            <RefreshIcon size={14} />
          </button>
        </div>
      </div>

      {/* Verbatim Backend Error Banner */}
      {error ? (
        <div
          className="error-banner"
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.5,
            padding: '12px 14px',
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Control Panel: Engine status, profile picker, Start/Stop controls */}
      <div
        className="panel"
        style={{
          padding: '14px 16px',
          marginBottom: 16,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          {/* Profile selector or display */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {t('Profile')}:
            </span>
            {props.profileId ? (
              <span className="badge badge-gray" style={{ fontSize: 12, padding: '4px 8px' }}>
                {activeProfileName || props.profileId}
              </span>
            ) : profiles.length > 0 ? (
              <select
                className="select-input"
                style={{ minWidth: 200 }}
                value={activeProfileId}
                onChange={(e) => {
                  setActiveProfileId(e.target.value);
                  setStreamTicket(null);
                  setInstanceStatus(null);
                  setError('');
                }}
                disabled={isRunning || isTransitioning}
              >
                {profiles.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {p.name} ({p.user_id.slice(0, 8)}) {p.platform === 'android' ? '· Android' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {activeProfileId || t('No profiles available')}
              </span>
            )}

            {/* Instance state badge */}
            {instanceStatus ? (
              <span
                className={`badge ${
                  instanceStatus.state === 'running'
                    ? 'running'
                    : instanceStatus.state === 'error'
                      ? 'fail'
                      : 'badge-gray'
                }`}
                style={{ fontSize: 11, textTransform: 'uppercase' }}
              >
                {t(instanceStatus.state)}
              </span>
            ) : null}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Install Engine Button when engine is absent */}
            {engineStatus && !engineStatus.installed ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleEngineInstall}
                disabled={installingEngine}
              >
                {installingEngine ? t('Installing...') : t('Install Engine')}
              </button>
            ) : null}

            {/* Start / Stop Control */}
            {isRunning || instanceStatus?.state === 'booting' || instanceStatus?.state === 'starting' ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleStop}
                disabled={stoppingInstance}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <StopIcon size={13} />
                <span>{stoppingInstance ? t('Stopping...') : t('Stop Emulator')}</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleStart}
                disabled={!activeProfileId || isTransitioning}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <PlayIcon size={13} />
                <span>{startingInstance ? t('Starting...') : t('Start Emulator')}</span>
              </button>
            )}
          </div>
        </div>

        {/* Engine status & metadata strip */}
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            fontSize: 11.5,
            color: 'var(--text-secondary)',
          }}
        >
          <div>
            <span>{t('Engine')}: </span>
            <strong style={{ color: engineStatus?.installed ? 'var(--ok)' : 'var(--warn)' }}>
              {engineStatus?.installed ? t('Installed') : t('Not Installed')}
            </strong>
          </div>

          {engineStatus?.platform ? (
            <div>
              <span>{t('Platform')}: </span>
              <span>
                {engineStatus.platform.host} · {engineStatus.platform.abi} ({engineStatus.platform.backends.join(', ')})
              </span>
            </div>
          ) : null}

          {engineStatus?.installedApiLevels && engineStatus.installedApiLevels.length > 0 ? (
            <div>
              <span>{t('System Image')}: </span>
              <span>API {engineStatus.installedApiLevels.join(', ')}</span>
            </div>
          ) : null}

          {instanceStatus?.serial ? (
            <div>
              <span>{t('Serial')}: </span>
              <code>{instanceStatus.serial}</code>
            </div>
          ) : null}
        </div>
      </div>

      {/* Main Display: Canvas when ticket is available, or informative state panel */}
      {streamTicket ? (
        <div
          className="panel"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
              paddingBottom: 8,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: streamStatus === 'error' ? 'var(--danger)' : 'var(--ok)',
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {streamStatus ? t(streamStatus.toUpperCase()) : t('STREAMING')}
              </span>
              {streamMessage ? (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({streamMessage})</span>
              ) : null}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {streamTicket.width} × {streamTicket.height}
            </span>
          </div>

          <AndroidCanvas
            wsUrl={streamTicket.wsUrl}
            screen={{ width: streamTicket.width, height: streamTicket.height }}
            onStatus={(status: AndroidStreamStatus, msg?: string) => {
              setStreamStatus(status);
              if (msg) setStreamMessage(msg);
              if (status === 'closed') {
                setStreamTicket(null);
              }
            }}
          />
        </div>
      ) : (
        /* Empty/Loading/Standby State */
        <div
          className="panel"
          style={{
            padding: '48px 24px',
            textAlign: 'center',
            background: 'var(--panel)',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            minHeight: 360,
          }}
        >
          {instanceStatus?.state === 'booting' || instanceStatus?.state === 'starting' ? (
            <>
              <div
                style={{
                  width: 32,
                  height: 32,
                  border: '3px solid var(--border)',
                  borderTopColor: 'var(--accent)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  marginBottom: 8,
                }}
              />
              <strong style={{ fontSize: 15, color: 'var(--text)' }}>
                {t('Booting Android virtual device...')}
              </strong>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 440, margin: 0 }}>
                {t('Initializing headless QEMU instance and awaiting sys.boot_completed signal over ADB.')}
              </p>
            </>
          ) : engineStatus && !engineStatus.installed ? (
            <>
              <DevicesIcon size={40} style={{ color: 'var(--text-muted)', marginBottom: 4 }} />
              <strong style={{ fontSize: 15, color: 'var(--text)' }}>
                {t('Android Engine Not Installed')}
              </strong>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 480, margin: 0 }}>
                {t('The emulator binaries and system image are acquired on demand to keep the application lightweight. Click "Install Engine" above to download and verify the runtime.')}
              </p>
              {engineStatus.unpinnedAssets && engineStatus.unpinnedAssets.length > 0 ? (
                <div
                  style={{
                    marginTop: 8,
                    padding: '8px 12px',
                    background: 'var(--panel-2)',
                    borderRadius: 6,
                    fontSize: 11,
                    color: 'var(--warn)',
                    textAlign: 'left',
                    maxWidth: 520,
                  }}
                >
                  <span>{t('Unpinned asset verification pending')}: </span>
                  <code>{engineStatus.unpinnedAssets.join(', ')}</code>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <DevicesIcon size={40} style={{ color: 'var(--text-muted)', marginBottom: 4 }} />
              <strong style={{ fontSize: 15, color: 'var(--text)' }}>
                {t('Android Virtual Device Idle')}
              </strong>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 440, margin: 0 }}>
                {t('Select an Android profile and click "Start Emulator" to boot the headless instance with isolated storage and low-latency display streaming.')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AndroidPage;
