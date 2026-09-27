import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ProxyItem, type GeoFillStatus } from '../api';
import { ProxiesIcon, PlusIcon, TrashIcon, RefreshIcon } from '../icons';
import { EmptyState } from '../components/EmptyState';
import { useColumnResize } from '../useColumnResize';
import { useI18n } from '../i18n';
import { CountryFlag } from '../countryFlag';
import { parseProxyInput } from '../proxyParse';
import { subscribeToEvents } from '../eventsStream';

export function Proxies() {
  const { t } = useI18n();
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [type, setType] = useState('http');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const applyParsedProxy = useCallback((parsed: NonNullable<ReturnType<typeof parseProxyInput>>) => {
    setHost(parsed.host);
    if (parsed.port) setPort(String(parsed.port));
    if (parsed.type) setType(parsed.type);
    if (parsed.username) setUser(parsed.username);
    if (parsed.password) setPass(parsed.password);
  }, []);
  const [checkResult, setCheckResult] = useState<Record<string, { ok: boolean; ip?: string; latencyMs?: number; error?: string }>>({});
  const [geoFill, setGeoFill] = useState<GeoFillStatus | null>(null);

  /**
   * Resizable columns, same contract as the profiles table: shares of the container rather than
   * pixels, and the trailing Actions column takes the remainder so the table can never outgrow
   * its container and bring back a horizontal scrollbar.
   */
  const columns = useMemo(
    () => [
      { key: 'type', defaultFraction: 0.12, minWidth: 90 },
      { key: 'host', defaultFraction: 0.3, minWidth: 160 },
      { key: 'username', defaultFraction: 0.22, minWidth: 120 },
      { key: 'location', defaultFraction: 0.2, minWidth: 130 },
    ],
    [],
  );
  const { containerRef: tableRef, colWidths, beginResize, resetColumn, dragging } = useColumnResize('proxies', columns);

  const load = useCallback(async () => {
    try {
      const res = await api.proxyList();
      if (res.code === 0) setProxies(res.data.list);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The geo pass is long by design: 142 proxies at 1500ms pacing is ~4 minutes, so the UI tracks it
  // instead of blocking on it. Polling stops as soon as the pass reports itself finished.
  useEffect(() => {
    let cancelled = false;
    // `wasRunning` is local, not a read of `geoFill`. Reading the state would freeze whatever value
    // the effect first saw, and putting it in the dependency list made the interval tear down and
    // restart on every flip — so the effect depended on churn to observe its own state.
    let wasRunning = false;
    const tick = async () => {
      try {
        const res = await api.proxyGeoFillStatus();
        if (cancelled || res.code !== 0) return;
        setGeoFill(res.data);
        // Reload ONCE, on the running -> finished edge. Rows are pushed individually by
        // `proxy-geo`, so this only covers a dropped stream; it must never be a per-tick refresh,
        // which would reload the whole table every 2 seconds for the length of the pass.
        if (wasRunning && !res.data.running) await load();
        wasRunning = res.data.running;
      } catch {
        // A status poll failing is not worth surfacing; the next tick retries.
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  // A finished check refreshes exactly what it changed, the moment it changed.
  useEffect(() => {
    return subscribeToEvents((event) => {
      if (event.type !== 'proxy-geo') return;
      void load();
    });
  }, [load]);

  const startGeoFill = async () => {
    setError('');
    try {
      const res = await api.proxyGeoFillStart();
      if (res.code === 0) setGeoFill(res.data);
      else setError(res.msg);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const stopGeoFill = async () => {
    try {
      const res = await api.proxyGeoFillStop();
      if (res.code === 0) setGeoFill(res.data);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        type,
        host: host.trim(),
        port: Number(port) || 0,
      };
      if (user.trim()) body.username = user.trim();
      if (pass.trim()) body.password = pass.trim();
      if (type === 'ssh' && privateKey.trim()) body.privateKey = privateKey.trim();

      const res = await api.proxyCreate(body);
      if (res.code === 0) {
        setShowModal(false);
        setHost('');
        setPort('');
        setUser('');
        setPass('');
        setPrivateKey('');
        await load();
        // No explicit check here. The backend queues a lookup for every proxy it creates, paced to
        // stay inside the free service's rate limit, and pushes the result over SSE — so the row
        // fills itself. Firing one from here as well was two concurrent checks of the same proxy,
        // and on a rotating gateway those can exit through DIFFERENT countries: the second answer
        // overwrites the first, and the row ends up claiming a location the check never confirmed.
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Are you sure you want to delete this proxy?')) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.proxyDelete(id);
      if (res.code === 0) await load();
      else setError(res.msg);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const check = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.proxyCheck(id);
      if (res.code === 0) {
        setCheckResult((prev) => ({ ...prev, [id]: res.data }));
        await load();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- Bulk list import (v0.2.26) ----
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importProto, setImportProto] = useState<'http' | 'https' | 'socks5'>('socks5');
  const [importBusy, setImportBusy] = useState(false);
  const [importSummary, setImportSummary] = useState<string>('');

  const previewCount = importText
    ? importText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')).length
    : 0;

  const runImport = async (): Promise<void> => {
    if (!importText.trim()) return;
    setImportBusy(true);
    setError('');
    setImportSummary('');
    try {
      const res = await api.proxyImportList(importText, importProto);
      if (res.code === 0) {
        setImportSummary(
          t('Imported') + `: ${res.data.created}, ` + t('duplicates') + `: ${res.data.duplicates}, ` + t('invalid lines') + `: ${res.data.invalid}`
        );
        setImportText('');
        await load();
        // The backend queues geo for every proxy the import creates and paces the lookups; the
        // header already renders that queue's progress. The sequential loop that used to live here
        // was the same work done twice, unpaced, and racing the queue for the same proxies.
        if (res.data.created > 0) {
          setImportSummary((s) => s + ` — ${t('detecting geo…')}`);
        }
        setTimeout(() => {
          setShowImport(false);
          setImportSummary('');
        }, 1500);
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImportBusy(false);
    }
  };

  return (
    <div>
      <div className="page-header-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProxiesIcon size={20} style={{ color: 'var(--text-secondary)' }} />
          <span className="hint" style={{ margin: 0 }}>({t('proxies configured')}: {proxies.length})</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Geo is filled in the background because the free lookup service allows 45 requests a
              minute and this library holds 142 proxies — the pass is paced, and this shows where it
              is rather than pretending it is instant. */}
          {geoFill?.running ? (
            <>
              <span className="hint" style={{ margin: 0 }}>
                {t('Auto-detecting geo…')} {geoFill.completed}/{geoFill.total}
              </span>
              <button className="btn" onClick={() => void stopGeoFill()}>
                {t('Stop Auto-detect')}
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => void startGeoFill()} title={t('Auto-detect Geo')}>
              <RefreshIcon size={14} />
              <span>{t('Auto-detect Geo')}</span>
            </button>
          )}
          <button className="btn" onClick={() => setShowImport(true)}>
            {t('Import List')}
          </button>
          <button className="btn primary" onClick={() => setShowModal(true)}>
            <PlusIcon size={15} />
            <span>{t('Add Proxy')}</span>
          </button>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {/* Import List Modal */}
      {showImport ? (
        <div className="modal-overlay" onClick={() => !importBusy && setShowImport(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('Import Proxy List')}</h3>
              <button className="btn-icon" onClick={() => setShowImport(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="hint" style={{ margin: 0 }}>
                {t('One proxy per line. Supported formats:')} <code>ip:port</code>, <code>ip:port:user:pass</code>, <code>user:pass@ip:port</code>, <code>socks5://user:pass@ip:port</code>.
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '10px 0' }}>
                <label style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{t('Protocol for lines without prefix')}:</label>
                <select
                  className="select-input"
                  style={{ width: 140 }}
                  value={importProto}
                  onChange={(e) => setImportProto(e.target.value as 'http' | 'https' | 'socks5')}
                >
                  <option value="socks5">SOCKS5</option>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                </select>
                <label style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input
                    type="file"
                    accept=".txt,.csv,text/plain"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setImportText(await f.text());
                      e.target.value = '';
                    }}
                  />
                  <span className="btn btn-sm" onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement)?.click()}>
                    {t('Upload .txt file')}
                  </span>
                </label>
              </div>
              <textarea
                placeholder={'145.223.59.161:6195:zpmigfas:xcn562htzyka\n195.40.122.162:6846:zpmigfas:xcn562htzyka\nsocks5://user:pass@1.2.3.4:1080'}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={10}
                style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  {t('Lines detected')}: <strong>{previewCount}</strong> — {t('geo will be detected automatically after import')}
                </span>
                {importSummary ? <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{importSummary}</span> : null}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowImport(false)} disabled={importBusy}>
                {t('Cancel')}
              </button>
              <button className="btn primary" onClick={() => void runImport()} disabled={importBusy || !importText.trim()}>
                {importBusy ? t('Importing…') : `${t('Import')} ${previewCount > 0 ? `(${previewCount})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Add Proxy Modal */}
      {showModal ? (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Add Proxy Server</h3>
              <button className="btn-icon" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Protocol</label>
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                  <option value="ssh">SSH Tunnel</option>
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 4 }}>
                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{t('Quick Proxy String / Быстрый ввод одной строкой')}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ip:port:user:pass | user:pass@host:port</span>
                </label>
                <input
                  placeholder={t('Вставьте прокси (любой формат: ip:port:login:pass, user:pass@host:port, socks5://...)')}
                  onChange={(e) => {
                    const parsed = parseProxyInput(e.target.value);
                    if (parsed) applyParsedProxy(parsed);
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Host / IP</label>
                  <input
                    placeholder="ip:port:user:pass, user:pass@host:port, or proxy.example.com"
                    value={host}
                    onChange={(e) => {
                      const parsed = parseProxyInput(e.target.value);
                      if (!parsed) {
                        setHost(e.target.value);
                        return;
                      }
                      applyParsedProxy(parsed);
                    }}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData('text');
                      const parsed = parseProxyInput(text);
                      if (parsed) {
                        e.preventDefault();
                        applyParsedProxy(parsed);
                      }
                    }}
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label>Port</label>
                  <input placeholder="8080" value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Username (optional)</label>
                  <input placeholder="Username" value={user} onChange={(e) => setUser(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Password (optional)</label>
                  <input type="password" placeholder="Password" value={pass} onChange={(e) => setPass(e.target.value)} />
                </div>
              </div>

              {type === 'ssh' ? (
                <div className="form-group">
                  <label>SSH Private Key (OpenSSH PEM format)</label>
                  <textarea
                    rows={4}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  />
                </div>
              ) : null}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn primary" onClick={() => void create()} disabled={busy || !host.trim() || !port.trim()}>
                Save Proxy
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="table-container" ref={tableRef}>
        <table className="table">
          <colgroup>
            {colWidths.map((col) => (
              <col key={col.key} style={{ width: `${col.percent}%` }} />
            ))}
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>
                {t('Type')}
                <button
                  type="button"
                  className={`col-resize-handle ${dragging === 'type' ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginResize('type', e)}
                  onDoubleClick={() => resetColumn('type')}
                  title={t('Drag to resize. Double-click to reset.')}
                  aria-label={t('Resize column')}
                  tabIndex={-1}
                />
              </th>
              <th>
                {t('Host : Port')}
                <button
                  type="button"
                  className={`col-resize-handle ${dragging === 'host' ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginResize('host', e)}
                  onDoubleClick={() => resetColumn('host')}
                  title={t('Drag to resize. Double-click to reset.')}
                  aria-label={t('Resize column')}
                  tabIndex={-1}
                />
              </th>
              <th>
                {t('Username')}
                <button
                  type="button"
                  className={`col-resize-handle ${dragging === 'username' ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginResize('username', e)}
                  onDoubleClick={() => resetColumn('username')}
                  title={t('Drag to resize. Double-click to reset.')}
                  aria-label={t('Resize column')}
                  tabIndex={-1}
                />
              </th>
              <th>
                {t('Location / IP')}
                <button
                  type="button"
                  className={`col-resize-handle ${dragging === 'location' ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginResize('location', e)}
                  onDoubleClick={() => resetColumn('location')}
                  title={t('Drag to resize. Double-click to reset.')}
                  aria-label={t('Resize column')}
                  tabIndex={-1}
                />
              </th>
              <th style={{ textAlign: 'right' }}>{t('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {proxies.length === 0 ? (
              <EmptyState
                colSpan={5}
                icon={<ProxiesIcon size={32} />}
                title={t('No proxies configured yet')}
                description={t('Proxies give each profile its own IP address — essential for running many accounts safely.')}
                action={
                  <button className="btn btn-sm primary" onClick={() => setShowModal(true)}>
                    <PlusIcon size={13} />
                    <span>{t('Add Proxy')}</span>
                  </button>
                }
              />
            ) : (
              proxies.map((p) => {
                const res = checkResult[p.proxy_id];
                return (
                  <tr key={p.proxy_id} className="row-dense">
                    <td>
                      <span className="proxy-type-badge">{p.type.toUpperCase()}</span>
                    </td>
                    <td>
                      <div className="row-dense__lead">
                        <code style={{ fontSize: 13, color: 'var(--text)' }}>{p.host}:{p.port}</code>
                      </div>
                    </td>
                    <td>
                      <div className="row-dense__meta">
                        <span style={{ color: p.username ? 'var(--text-secondary)' : 'var(--text-muted)', fontSize: 13 }}>
                          {p.username || '—'}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="row-dense__meta">
                        {res ? (
                          <span className="row-dense__status" style={{ fontSize: 12, color: res.ok ? 'var(--ok)' : 'var(--danger)' }}>
                            {res.ok ? `✓ ${res.ip} (${res.latencyMs}ms)` : `✕ ${res.error || 'Failed'}`}
                          </span>
                        ) : p.country || p.city ? (
                          <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            {/* Flag ICON, country, city and timezone — the operator needs to see where
                                the proxy actually exits, not just that something was stored. The flag
                                comes from the ISO code, which is a separate column: a name has no
                                derivable flag, and passing one here produced none at all.

                                Drawn rather than emoji: Windows has no flag glyph, so the emoji form
                                rendered as two letters. The icon shows nothing for an uncovered
                                code, and the country name and code still carry the meaning. */}
                            <CountryFlag code={p.country_code} height={11} />
                            {[p.country, p.city].filter(Boolean).join(' · ')}
                            {p.timezone ? ` · ${p.timezone}` : ''}
                          </span>
                        ) : p.status === 'fail' ? (
                          /* The stored verdict survives a reload, unlike a session check result.
                             A failed proxy has no exit location, so it must not fall through to
                             "Not detected yet" — that reads as "never tried", the opposite of what
                             happened. */
                          <span
                            data-testid="proxy-failed"
                            style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}
                            title={t('Proxy check failed — no exit location')}
                          >
                            ✕ {t('Failed')}
                          </span>
                        ) : (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {geoFill?.running ? t('Detecting…') : t('Not detected yet')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="row-dense__actions" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="btn-icon"
                          onClick={() => void check(p.proxy_id)}
                          disabled={busy}
                          title={t('Test Connection')}
                        >
                          <RefreshIcon size={14} />
                        </button>
                        <button
                          className="btn-icon"
                          style={{ color: 'var(--danger)' }}
                          onClick={() => void remove(p.proxy_id)}
                          disabled={busy}
                          title={t('Delete Proxy')}
                        >
                          <TrashIcon size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Proxy Type Guide */}
      <div
        className="panel"
        style={{
          marginTop: 20,
          padding: '14px 16px',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>HTTP / HTTPS</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            {t('Best for most tasks (browsing, social networks). Easy to set up, widely supported.')}
          </p>
        </div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>SOCKS5</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            {t('Handles all traffic types (TCP/UDP). Recommended for banking, crypto and heavy anti-detection.')}
          </p>
        </div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>SSH Tunnel</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            {t('Routes traffic through a Linux server you own — free and stable if you have one.')}
          </p>
        </div>
      </div>
    </div>
  );
}
