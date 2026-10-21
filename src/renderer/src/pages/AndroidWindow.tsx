import { useEffect, useState } from 'react';
import { api, initApiKey, type AndroidInstanceStatus, type AndroidStreamTicket } from '../api';
import { useI18n } from '../i18n';
import { AndroidCanvas } from '../components/AndroidCanvas';
import type { AndroidStreamStatus } from '../androidStream';

/**
 * Standalone per-profile Android window (`#/android-window?profile=<id>`).
 *
 * The Tauri shell opens one OS window per profile for multi-profile work; each window renders
 * only its own stream. Same backend origin as the main window, so auth is the same API key —
 * no new surface. Outside Tauri (plain browser) the same URL works as a focused view.
 */
export function AndroidWindowPage(props: { profileId: string }): JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<AndroidInstanceStatus | null>(null);
  const [ticket, setTicket] = useState<AndroidStreamTicket | null>(null);
  const [streamStatus, setStreamStatus] = useState<AndroidStreamStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    initApiKey()
      .then(() => api.androidStatus(props.profileId))
      .then((res) => {
        if (cancelled) return;
        if (res.code === 0 && res.data) {
          setStatus(res.data);
          if (res.data.state === 'running') {
            void api.androidStreamTicket(props.profileId).then((tr) => {
              if (!cancelled && tr.code === 0 && tr.data) setTicket(tr.data);
            });
          }
        } else {
          setError(res.msg || 'Failed to load profile status');
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    const timer = setInterval(() => {
      if (cancelled) return;
      void api.androidStatus(props.profileId).then((res) => {
        if (cancelled || res.code !== 0 || !res.data) return;
        setStatus(res.data);
        if (res.data.state === 'running' && !ticket) {
          void api.androidStreamTicket(props.profileId).then((tr) => {
            if (!cancelled && tr.code === 0 && tr.data) setTicket(tr.data);
          });
        } else if (res.data.state !== 'running' && ticket) {
          setTicket(null);
        }
      });
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `ticket` in deps would restart the poller on every ticket change; the ref-free read is
    // intentional — the interval always sees the latest render's value via re-creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.profileId]);

  useEffect(() => {
    document.title = `NullTrace Android — ${props.profileId}`;
  }, [props.profileId]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          fontSize: 12,
          color: 'var(--text-secondary)',
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {props.profileId}
        </span>
        <span
          className={`badge ${status?.state === 'running' ? 'running' : status?.state === 'error' ? 'fail' : 'badge-gray'}`}
          style={{ fontSize: 11, textTransform: 'uppercase' }}
        >
          {status ? t(status.state) : t('loading')}
          {streamStatus ? ` · ${streamStatus}` : ''}
        </span>
      </div>
      {error ? (
        <div className="error-banner" style={{ margin: 12, fontSize: 12 }}>
          {error}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {ticket ? (
          <AndroidCanvas
            wsUrl={ticket.wsUrl}
            screen={{ width: ticket.width, height: ticket.height }}
            onRetry={() => {
              setTicket(null);
              void api.androidStreamTicket(props.profileId).then((tr) => {
                if (tr.code === 0 && tr.data) setTicket(tr.data);
              });
            }}
            onStatus={(s) => {
              setStreamStatus(s);
              if (s === 'closed') setTicket(null);
            }}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: 13,
              padding: 24,
              textAlign: 'center',
            }}
          >
            {status?.state === 'running'
              ? t('Acquiring stream…')
              : status
                ? t('Profile is not running — start it from the main window.')
                : t('Loading…')}
          </div>
        )}
      </div>
    </div>
  );
}

export default AndroidWindowPage;
