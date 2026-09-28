import { useEffect, useRef, useState, useCallback } from 'react';
import { initApiKey, api, setApiKey } from './api';
import { FirstRunDataDir } from './FirstRunDataDir';
import { useI18n } from './i18n';
import { PRODUCT_NAME, TAGLINE_PRIMARY } from './brand';
import {
  normalizeUpdateStatus,
  nextUpdateAction,
  presentUpdate,
  updateActionKey,
} from './updateStatus';
import type { UpdateStatus, UpdateStatusEventPayload } from './global';
import {
  computeRunningCount,
} from './sidebarLogic';
import { Profiles } from './pages/Profiles';
import { Proxies } from './pages/Proxies';
import { Devices } from './pages/Devices';
import { Extensions } from './pages/Extensions';
import { Settings } from './pages/Settings';
import { CloudSync } from './pages/CloudSync';
import { Teams } from './pages/Teams';
import { Diagnostics } from './pages/Diagnostics';
import { Trash } from './pages/Trash';
import { Scripts } from './pages/Scripts';
import { FlowCanvas } from './pages/FlowCanvas';
import { Email } from './pages/Email';
import { AndroidPage } from './pages/Android';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { AutomationPanel } from './components/AutomationPanel';
import { ToastStack } from './components/Toasts';
import {
  ProfilesIcon,
  ProxiesIcon,
  DevicesIcon,
  ExtensionsIcon,
  SettingsIcon,
  BrandMark,
  CloudIcon,
  TrashIcon,
  MailIcon,
  FlowIcon,
} from './icons';
type Page =
  | 'profiles'
  | 'proxies'
  | 'devices'
  | 'extensions'
  | 'email'
  | 'teams'
  | 'cloud'
  | 'diagnostics'
  | 'trash'
  | 'scripts'
  | 'flows'
  | 'settings'
  | 'android';
export interface SubTab {
  key: Page;
  label: string;
}

export interface NavDestination {
  key: Page;
  label: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  group?: 'WORKSPACE' | 'LIBRARY' | 'SYSTEM';
  subTabs?: SubTab[];
}

/**
 * Sidebar grouping, mirroring the ShardX reference: one flat list divided by small
 * all-caps labels rather than nested collapsible sections. Order here is the render order.
 */
export const NAV_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'WORKSPACE', label: 'WORKSPACE' },
  { id: 'LIBRARY', label: 'LIBRARY' },
  { id: 'SYSTEM', label: 'SYSTEM' },
];

export const NAV_DESTINATIONS: NavDestination[] = [
  // WORKSPACE
  {
    key: 'profiles',
    label: 'Profiles',
    icon: ProfilesIcon,
    group: 'WORKSPACE',
  },
  // Trash is a sibling of Profiles in the WORKSPACE section.
  // Groups was removed from the sidebar per user request because groups are managed
  // directly inside the Profiles page via the Groups modal button and filter dropdown.
  {
    key: 'trash',
    label: 'Trash',
    icon: TrashIcon,
    group: 'WORKSPACE',
  },
  {
    key: 'proxies',
    label: 'Proxies',
    icon: ProxiesIcon,
    group: 'WORKSPACE',
  },
  {
    key: 'flows',
    label: 'Automation',
    icon: FlowIcon,
    group: 'WORKSPACE',
    subTabs: [
      { key: 'flows', label: 'Flow Canvas' },
      { key: 'scripts', label: 'Scripts' },
    ],
  },
  {
    key: 'android',
    label: 'Android',
    icon: DevicesIcon,
    group: 'WORKSPACE',
  },
  // LIBRARY
  // Devices and Extensions are separate destinations rather than sub-tabs of one entry. They used
  // to be sub-tabs under a "Fingerprints" heading, which meant the only way to reach either was a
  // pair of pills inside the content area — the operator asked for them in the left menu instead,
  // where every other destination lives. Nothing is lost by the split: the parent's key was
  // `devices`, so its label was only ever a heading for these two pages.
  {
    key: 'devices',
    label: 'Devices',
    icon: DevicesIcon,
    group: 'LIBRARY',
  },
  {
    key: 'extensions',
    label: 'Extensions',
    icon: ExtensionsIcon,
    group: 'LIBRARY',
  },
  {
    key: 'email',
    // Named for what it IS. The page is the IMAP mail manager (`pages/Email.tsx`, `/api/v1/email`),
    // and "Library" described a grouping the sidebar already expresses with its LIBRARY heading —
    // so the label told the operator nothing about the destination and read as a second, empty
    // Library section. The icon was a cookie, which belongs to the cookie farm, not to mail.
    label: 'IMAP',
    icon: MailIcon,
    group: 'LIBRARY',
  },
  // SYSTEM
  {
    key: 'cloud',
    label: 'Cloud',
    icon: CloudIcon,
    group: 'SYSTEM',
    subTabs: [
      { key: 'cloud', label: 'Cloud Sync' },
      { key: 'teams', label: 'Teams' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: SettingsIcon,
    group: 'SYSTEM',
    subTabs: [
      { key: 'settings', label: 'Settings' },
      { key: 'diagnostics', label: 'Diagnostics' },
    ],
  },
];

function getActiveDestination(currentPage: Page): NavDestination {
  const dest = NAV_DESTINATIONS.find(
    (d) => d.key === currentPage || d.subTabs?.some((st) => st.key === currentPage)
  );
  return dest || NAV_DESTINATIONS[0];
}

export function App() {
  const { t } = useI18n();
  // The frameless window controls belong to the Electron shell. A browser client
  // has no bridge, so we detect it once rather than rendering dead buttons.
  const hasNativeWindow = typeof window !== 'undefined' && Boolean(window.antidetect?.window);
  const [ready, setReady] = useState(false);
  const [firstRunDir, setFirstRunDir] = useState<string | null>(null);
  const [page, setPage] = useState<Page>('profiles');
  const [androidProfileId, setAndroidProfileId] = useState<string>('');
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('personal');
  const [runningCount, setRunningCount] = useState<number>(0);
  const [syncConnected, setSyncConnected] = useState<boolean>(false);
  const activeDest = getActiveDestination(page);
  const [kernelUpdateState, setKernelUpdateState] = useState<UpdateStatus | null>(null);
  /**
   * Whether the operator has asked for the update, which is what authorises the flow to run to
   * completion without further clicks. Set by the footer control; never set by an automatic
   * check, so a background check can never start a download behind the operator's back.
   */
  const [updateFlowActive, setUpdateFlowActive] = useState<boolean>(false);
  // Seeded from package.json via __APP_VERSION__ so a real number always renders even if
  // the backend answers "unknown". Upgraded when /status answers a real value.
  const [appVersion, setAppVersion] = useState<string>(() => (typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== 'unknown' ? __APP_VERSION__ : ''));
  const [hasRunUpdateCheck, setHasRunUpdateCheck] = useState<boolean>(false);

  useEffect(() => {
    api.status()
      .then((res) => {
        const v = res.data?.version;
        if (typeof v === 'string' && v.length > 0 && v !== 'unknown') setAppVersion(v);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // The shell emits `update:status` with a payload shaped { state, message, info, progress }
    // (see UpdateStatusEvent in src-tauri/src/updater.rs). The translation to the UI's own
    // vocabulary lives in `updateStatus.ts` because `Settings.tsx` renders the same states and
    // the two had drifted: this listener dropped `download-progress`, so progress could never
    // appear, and Settings switched on strings the shell never sends at all.
    const apiObj = window.antidetect as (typeof window.antidetect & {
      onUpdateStatus?: (cb: (s: UpdateStatusEventPayload) => void) => () => void;
    }) | undefined;
    const unsub = apiObj?.onUpdateStatus?.((s) => {
      setHasRunUpdateCheck(true);
      setKernelUpdateState(normalizeUpdateStatus(s));
    });
    return () => unsub?.();
  }, []);

  /**
   * Drive the whole update from the footer control: check → download → install.
   *
   * The pill used to call only `update.check()`, so it reported "Update available" and stopped —
   * `download()` and `quitAndInstall()` existed only behind buttons in Settings, which is not
   * where an operator looks when they wonder whether they are current. Clicking the control is
   * the consent; from there the flow runs to completion on its own.
   *
   * Only the most recent dispatch is remembered: StrictMode re-runs effects on the same state,
   * and the shell re-emits `download-progress` many times per second, so an unguarded effect
   * would fetch the artefact twice and then try to install it twice. A new offer carries a new
   * version, which changes the key and makes the flow actionable again.
   */
  const lastDispatchRef = useRef<string>('');
  useEffect(() => {
    if (!updateFlowActive) return;
    const action = nextUpdateAction(kernelUpdateState);
    if (!action) return;
    const key = updateActionKey(action, kernelUpdateState);
    if (lastDispatchRef.current === key) return;
    lastDispatchRef.current = key;

    const apiObj = window.antidetect as (typeof window.antidetect & {
      update?: { download?: () => Promise<void>; quitAndInstall?: () => Promise<void> };
    }) | undefined;
    if (action === 'download') {
      void apiObj?.update?.download?.();
    } else {
      void apiObj?.update?.quitAndInstall?.();
    }
  }, [updateFlowActive, kernelUpdateState]);

  const initSession = useCallback((token: string) => {
    setApiKey(token);
    api.teamsList()
      .then((res) => {
        if (res.code === 0 && res.data.active_workspace) setWorkspace(res.data.active_workspace);
      })
      .catch(() => undefined);
    setReady(true);
  }, []);

  useEffect(() => {
    // There is no panel password. Startup is: resolve the key, then either ask where data
    // should live (first run) or open the app. Nothing here can block behind a credential
    // prompt — the old gate keyed off a `/ui/auth-state` probe that no longer exists.
    let mounted = true;
    async function startupAuth() {
      const token = await initApiKey();
      if (!mounted) return;

      /**
       * Ask whether the data location has ever been chosen, before anything else runs.
       *
       * This sits ahead of the rest of startup on purpose: the folder decides where the
       * profiles, kernel and database live, so asking it after the app has opened would be
       * asking about data that already exists. A failed check must NOT block startup — an
       * unreachable endpoint is not a reason to hide the app; the operator can still set the
       * folder later in Settings.
       */
      try {
        const fr = await api.firstRunData();
        if (!mounted) return;
        if (fr.data?.needed) {
          setFirstRunDir(fr.data.defaultDir ?? '');
          setReady(true);
          return;
        }
      } catch {
        // Endpoint unavailable or key not yet accepted: fall through to normal startup.
      }

      initSession(token);
    }
    void startupAuth();
    return () => {
      mounted = false;
    };
  }, [initSession]);

  // Fetch running profiles count & sync status
  useEffect(() => {
    if (!ready) return;
    api.list()
      .then((res) => {
        const list = res.data?.list;
        if (Array.isArray(list)) {
          setRunningCount(computeRunningCount(list));
        }
      })
      .catch(() => undefined);

    api.syncStatus()
      .then((res) => {
        if (res.data?.connected) setSyncConnected(true);
      })
      .catch(() => undefined);
  }, [ready, page]);

  const changeWorkspace = (ws: string) => {
    setWorkspace(ws);
    void api.workspaceSetActive(ws).catch(() => undefined);
  };

  // Footer version line. The state → text mapping lives in `updateStatus.ts` so the footer and
  // Settings cannot drift apart again (they had: the footer dropped `download-progress`, and
  // Settings switched on strings the shell never sent, leaving its panel empty).
  const updateView = presentUpdate(kernelUpdateState, hasRunUpdateCheck);
  const updateTitle = t(updateView.titleKey);
  const updateLabel =
    updateView.percent !== null
      ? `${t(updateView.labelKey)} ${updateView.percent}%`
      : t(updateView.labelKey);

  if (!ready) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '8px', color: 'var(--text-muted)' }}>
        <div>Loading {PRODUCT_NAME}...</div>
        <div style={{ fontSize: '12px', opacity: 0.7 }}>{TAGLINE_PRIMARY}</div>
      </div>
    );
  }

  if (firstRunDir !== null) {
    return (
      <FirstRunDataDir
        defaultDir={firstRunDir}
        onDone={() => {
          /**
           * The location is recorded, but the backend resolved `DATA_DIR` when it started,
           * so it only takes effect on the next launch. Restart rather than leaving the
           * operator in an app whose data still lives in the folder they just moved away
           * from — the shell re-executes and the sidecar is torn down through the normal
           * exit path (graceful shutdown, then kill), so nothing is orphaned.
           */
          void window.antidetect?.data?.restart?.();
          setFirstRunDir(null);
        }}
      />
    );
  }

  const activeNav = NAV_DESTINATIONS.find((n) => n.key === page);

  return (
    <div className="app">
      <aside
        className="sidebar"
        aria-label="Navigation sidebar"
      >
        <div className="sidebar-content">
          <div className="brand" title={`${PRODUCT_NAME} PRO`}>
            <div className="brand-icon">
              <BrandMark size={20} />
            </div>
            <div className="brand-title">{PRODUCT_NAME}</div>
            <span className="brand-version">PRO</span>
          </div>

          <nav className="nav" aria-label="Main navigation">
            {NAV_GROUPS.map((group) => {
              const groupItems = NAV_DESTINATIONS.filter((d) => d.group === group.id);
              if (groupItems.length === 0) return null;
              return (
                <div key={group.id} className="nav-group">
                  <div className="nav-group-label">{t(group.label)}</div>
                  <div className="nav-group-items">
                    {groupItems.map((dest) => {
                      const Icon = dest.icon;
                      const isDestActive =
                        page === dest.key || dest.subTabs?.some((st) => st.key === page);
                      const isProfiles = dest.key === 'profiles';
                      const isCloud = dest.key === 'cloud';
                      const itemLabel = t(dest.label);

                      return (
                        <button
                          key={dest.key}
                          type="button"
                          className={`nav-item ${isDestActive ? 'active' : ''}`}
                          aria-label={itemLabel}
                          onClick={() => {
                            if (dest.key !== 'profiles') setSelectedGroupId(null);
                            setPage(dest.key);
                          }}
                        >
                          <div className="nav-item-icon-wrapper">
                            <Icon size={16} />
                            {isCloud && syncConnected && <span className="sync-dot" title="Cloud connected" />}
                          </div>
                          <span className="nav-label">{itemLabel}</span>
                          {isProfiles && runningCount > 0 && (
                            <span className="nav-badge">{runningCount}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>

          <div className="workspace-switcher-wrapper">
            <WorkspaceSwitcher active={workspace} onChange={changeWorkspace} />
          </div>
        </div>

        <div className="sidebar-footer">
          {/*
            * The Automation API block: the address the API is reachable at, the MCP badge and
            * control, and the bundle download. It belongs in the footer and is NOT optional.
            *
            * It was dropped here by the commit that removed the sidebar collapse, which removed
            * the whole element along with the `{!sidebarCollapsed && ...}` guard it was wrapped
            * in. The import stayed, so nothing failed to build and nothing warned: the app
            * simply lost the only control that starts the MCP server. On the operator's machine
            * that read as «МСП не включается» — there was no longer any button to press.
            */}
          <AutomationPanel />
          {/*
           * The version line is the update control, and it shows its own state.
           *
           * Clicking it authorises the whole flow — check → download → install → relaunch — and
           * the effect above advances each step as the shell reports it. A state that cannot
           * proceed (up to date, error) stops there and says so.
           *
           * Styled as a card rather than three lines of loose text: the state is carried by
           * `data-state`, so the appearance and the behaviour cannot drift apart, and the
           * progress bar appears only while there is progress to show. The animation is
           * suppressed under `prefers-reduced-motion`.
           *
           * Rendered as a button, not a div with onClick, so it is keyboard reachable and
           * announced as interactive.
           */}
          <button
            type="button"
            className="sidebar-version"
            data-testid="check-updates"
            data-state={updateView.state}
            title={updateTitle}
            aria-label={t('Check for updates')}
            aria-busy={updateView.state === 'checking' || updateView.state === 'downloading' || updateView.state === 'installing'}
            onClick={() => {
              const apiObj = window.antidetect as (typeof window.antidetect & {
                update?: { check?: () => Promise<void> };
              }) | undefined;
              if (!apiObj?.update?.check) {
                // No shell bridge (a browser-served client): say so rather than appearing
                // to do nothing.
                setHasRunUpdateCheck(true);
                setUpdateFlowActive(false);
                setKernelUpdateState({
                  state: 'error',
                  message: 'Updates are only available in the desktop application.',
                });
                return;
              }
              setHasRunUpdateCheck(true);
              setUpdateFlowActive(true);
              setKernelUpdateState({ state: 'checking' });
              void apiObj.update.check();
            }}
          >
            <span className="sidebar-version__row">
              <span className="sidebar-version__name">{PRODUCT_NAME}</span>
              <span className="sidebar-version__badge">{appVersion ? `v${appVersion}` : '—'}</span>
            </span>
            <span className="sidebar-version__status">
              <span className="sidebar-version__dot" aria-hidden="true" />
              {updateLabel}
            </span>
            {/* A determinate bar only while bytes are actually moving; otherwise a thin
                indeterminate sweep, which is what "checking" honestly represents. */}
            <span className="sidebar-version__progress" aria-hidden="true">
              {updateView.percent !== null ? (
                <span className="sidebar-version__progress-fill" style={{ width: `${updateView.percent}%` }} />
              ) : null}
            </span>
          </button>
        </div>
      </aside>

      <div className="main">
        {/* The page name is NOT here. It lives in the content area as a breadcrumb
            (`Workspace / <Page>`), which is where the reference product puts it and where
            the operator's eye already is. This bar carries only the drag region and the
            window controls, which is all a frameless titlebar should own. */}
        <header className="topbar" data-tauri-drag-region="">
          <div className="topbar-drag-region" data-tauri-drag-region="" />
          {hasNativeWindow ? (
            <div className="window-controls">
              <button
                type="button"
                className="window-control"
                onClick={() => window.antidetect?.window?.minimize()}
                aria-label={t('Minimize')}
                title={t('Minimize')}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
              <button
                type="button"
                className="window-control"
                onClick={() => window.antidetect?.window?.toggleMaximize()}
                aria-label={t('Maximize')}
                title={t('Maximize')}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
              <button
                type="button"
                className="window-control window-control-close"
                onClick={() => window.antidetect?.window?.close()}
                aria-label={t('Close')}
                title={t('Close')}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
            </div>
          ) : null}
        </header>

        <main className="content">
          {/* Breadcrumb: the reference names the page here, beside that page's own search,
              rather than in the window chrome. `Workspace` is the shell's top-level scope,
              matching the navigation's first group. */}
          <div className="page-breadcrumb-row">
            <nav className="breadcrumb" aria-label={t('Breadcrumb')}>
              <span className="breadcrumb-item">
                {/* The first segment names the SIDEBAR GROUP the page lives in, so the crumb
                    matches what the operator clicked. It used to be a literal `Workspace`, which
                    contradicted the menu: Devices sits under LIBRARY and the breadcrumb still
                    read "Workspace". Title-cased from the group id; a destination without a
                    group (the Dashboard) falls back to the workspace name. */}
                {t(
                  activeDest.group
                    ? activeDest.group.charAt(0).toUpperCase() + activeDest.group.slice(1).toLowerCase()
                    : 'Workspace'
                )}
              </span>
              <span className="breadcrumb-sep" aria-hidden="true">/</span>
              <span className="breadcrumb-current">{activeNav ? t(activeNav.label) : 'Dashboard'}</span>
            </nav>
          </div>
          {activeDest.subTabs && activeDest.subTabs.length > 0 ? (
            <nav
              className="subtabs"
              aria-label="Sub navigation"
              style={{
                display: 'flex',
                gap: 'var(--space-1)',
                borderBottom: '1px solid var(--border)',
                paddingBottom: 'var(--space-2)',
                marginBottom: 'var(--space-4)',
              }}
            >
              {activeDest.subTabs.map((st) => {
                const isTabActive = page === st.key;
                return (
                  <button
                    key={st.key}
                    type="button"
                    className={`btn ${isTabActive ? 'btn-primary' : 'btn-ghost'}`}
                    style={{
                      height: 'var(--control-h-sm)',
                      fontSize: 'var(--text-sm)',
                      padding: '0 var(--space-3)',
                    }}
                    onClick={() => {
                      if (st.key !== 'profiles') setSelectedGroupId(null);
                      setPage(st.key);
                    }}
                  >
                    {t(st.label)}
                  </button>
                );
              })}
            </nav>
          ) : null}
          {page === 'profiles' ? (
            <Profiles
              initialGroupId={selectedGroupId}
              onNavigate={(target, profileId) => {
                if (profileId) setAndroidProfileId(profileId);
                setPage(target as Page);
              }}
            />
          ) : page === 'proxies' ? (
            <Proxies />
          ) : page === 'devices' ? (
            <Devices />
          ) : page === 'extensions' ? (
            <Extensions />
          ) : page === 'email' ? (
            <Email />
          ) : page === 'diagnostics' ? (
            <Diagnostics />
          ) : page === 'trash' ? (
            <Trash />
          ) : page === 'scripts' ? (
            <Scripts />
          ) : page === 'teams' ? (
            <Teams />
          ) : page === 'cloud' ? (
            <CloudSync />
          ) : page === 'flows' ? (
            <FlowCanvas />
          ) : page === 'android' ? (
            <AndroidPage profileId={androidProfileId} />
          ) : (
            <Settings />
          )}
        </main>
      </div>
      <ToastStack />
    </div>
  );
}
