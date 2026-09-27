import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import {
  api,
  type ProfileListItem,
  type ExtensionItem,
  type GroupItem,
  type ProxyItem,
  type DeviceItem,
  type ProxyTestResult,
  type TagItem,
  type ProfileTagBinding,
  type SyncSessionInfo,
  type CookieFarmReport,
  type CookieFarmProgress,
} from '../api';
import { useI18n } from '../i18n';
import { geoLabel } from '../proxyGeo';
import { CountryFlag } from '../countryFlag';
import { parseProxyInput } from '../proxyParse';
import { computeRunningCount } from '../sidebarLogic';
import { Dropdown } from '../components/Dropdown';
import { useColumnResize } from '../useColumnResize';
import { subscribeToEvents } from '../eventsStream';
import { SyncPanel } from '../components/SyncPanel';
import { PreflightModal, PreflightBadge } from '../components/PreflightModal';
import { Modal } from '../components/Modal';
import { ProfileVault } from '../components/ProfileVault';
import type { PreflightVerdict, PreflightStatus } from '../preflight';
import {
  PlayIcon,
  StopIcon,
  SettingsIcon,
  DiceIcon,
  CookieIcon,
  FingerprintIcon,
  ExtensionsIcon,
  CopyIcon,
  CheckIcon,
  PlusIcon,
  SearchIcon,
  FolderIcon,
  TrashIcon,
  ProxiesIcon,
  RefreshIcon,
  ProfilesIcon,
  NoteIcon,
  UsersIcon,
  ShieldCheckIcon,
} from '../icons';
/**
 * Fallback browser languages, used until the API answers.
 *
 * The real list comes from `api.browserLanguages()` — the fingerprint catalog is the single
 * source of truth, and it lives on the backend. The list used to be hand-written here with seven
 * entries while the catalog derives twenty-one, and that is the reported defect: the select could
 * not represent a profile whose language was `es-MX`, so it rendered "Auto" and Save wrote that
 * empty value over the real one.
 *
 * This fallback is deliberately the catalog's CORE set rather than the old seven, so a failed
 * request cannot silently make a stored language unrepresentable.
 */
export const FALLBACK_BROWSER_LANGUAGES: readonly string[] = [
  'de-DE', 'en-AU', 'en-CA', 'en-GB', 'en-US', 'es-ES', 'es-MX', 'fr-FR', 'id-ID', 'it-IT',
  'ja-JP', 'ko-KR', 'nl-NL', 'pl-PL', 'pt-BR', 'ru-RU', 'sv-SE', 'th-TH', 'tr-TR', 'vi-VN', 'zh-CN',
];

/**
 * The common IANA zones offered in the Timezone select.
 *
 * A convenience list, NOT the set of valid values: a profile's timezone can also be filled from
 * the proxy's geo, so the select always renders the profile's own zone alongside these. See the
 * control itself for why that matters.
 */
export const COMMON_TIMEZONES: readonly string[] = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid',
  'Europe/Warsaw', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

export function Profiles({ initialGroupId }: { initialGroupId?: string | null } = {}) {
  const { t } = useI18n();
  const [browserLanguages, setBrowserLanguages] = useState<readonly string[]>(FALLBACK_BROWSER_LANGUAGES);
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  /**
   * Which datasets have actually answered. The metric cards must distinguish "the backend
   * says zero" from "we have not heard back yet" — rendering an unloaded value as `0` is a
   * claim the UI cannot support.
   */
  const [loaded, setLoaded] = useState<{ profiles: boolean; proxies: boolean; devices: boolean }>({
    profiles: false,
    proxies: false,
    devices: false,
  });
  const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
  const [mobilePresets, setMobilePresets] = useState<Array<{ id: string; name: string; model: string; androidVersion: string; gpu: string }>>([]);
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<string>(initialGroupId || '');
  const [selectedPlatformFilter, setSelectedPlatformFilter] = useState<string>('');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>('');
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<{ id: string; ws: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkTargetGroup, setBulkTargetGroup] = useState<string>('');
  const [error, setError] = useState('');

  // Note modal state
  const [noteModalProfile, setNoteModalProfile] = useState<ProfileListItem | null>(null);
  const [noteText, setNoteText] = useState<string>('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string>('');

  // Action Syncer (Sprint 3)
  const [syncSession, setSyncSession] = useState<SyncSessionInfo | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  // Modal Profile State (Create or Edit)
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [profileId, setProfileId] = useState('');
  const [name, setName] = useState('');
  const [profileColor, setProfileColor] = useState<string>('');
  const [groupId, setGroupId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [seed, setSeed] = useState<number>(0);
  const [mobileModelId, setMobileModelId] = useState('');
  const [userAgent, setUserAgent] = useState('');
  const [cores, setCores] = useState<number>(8);
  const [profileTimezone, setProfileTimezone] = useState<string>('');
  // Empty means "Auto": the language is then derived from the fingerprint seed. The default used
  // to be 'en-US', which made the Auto option indistinguishable from an explicit en-US choice —
  // the select renders Auto with an empty value, so a fresh form disagreed with its own dropdown.
  const [profileLang, setProfileLang] = useState<string>('');
  const [doNotTrack, setDoNotTrack] = useState<'off' | 'on' | 'auto'>('auto');
  const [blockedPorts, setBlockedPorts] = useState<number[]>([]);
  const [portInput, setPortInput] = useState<string>('');
  const [webrtcPolicy, setWebrtcPolicy] = useState<'default' | 'disable_non_proxied_udp' | 'proxy'>('default');
  // Display mode. Headless profiles launch without a window, which is what an agent-driven
  // profile wants and what a human operator never does by accident from this form.
  const [headlessMode, setHeadlessMode] = useState(false);
  /**
   * Per-surface noise, as the KERNEL sees it: a token present here is passed to
   * `--disable-spoofing=<token>`, which turns that surface's engine-level spoofing off.
   *
   * Stored in the fingerprint config blob as a comma-joined string, the same shape the
   * fingerprint route already reads (`disableSpoofing`). Tokens match the kernel's own
   * names, so this list is a control over a real switch and not a vocabulary of its own.
   *
   * "Auto" = the kernel spoofs it from the seed, which is what makes a profile unique.
   * "Real" = stand down and report the machine's own value.
   */
  const [noiseReal, setNoiseReal] = useState<string[]>([]);

  // Proxy state in modal: mode = 'none' | 'saved' | 'custom'
  const [proxyMode, setProxyMode] = useState<'none' | 'saved' | 'custom'>('none');
  const [savedProxyId, setSavedProxyId] = useState('');
  const [customProxyType, setCustomProxyType] = useState<'http' | 'https' | 'socks5' | 'ssh'>('socks5');
  const [customProxyHost, setCustomProxyHost] = useState('');
  const [customProxyPort, setCustomProxyPort] = useState('');
  const [customProxyUser, setCustomProxyUser] = useState('');
  const [customProxyPass, setCustomProxyPass] = useState('');
  const applyCustomProxy = useCallback((parsed: NonNullable<ReturnType<typeof parseProxyInput>>) => {
    setCustomProxyHost(parsed.host);
    if (parsed.port) setCustomProxyPort(String(parsed.port));
    if (parsed.type) setCustomProxyType(parsed.type);
    if (parsed.username) setCustomProxyUser(parsed.username);
    if (parsed.password) setCustomProxyPass(parsed.password);
  }, []);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);

  // Batch & CSV Modals
  const [showBatch, setShowBatch] = useState(false);
  const [batchCount, setBatchCount] = useState('5');
  const [batchPrefix, setBatchPrefix] = useState('profile');
  const [batchGroup, setBatchGroup] = useState('');


  // Groups Management Modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string } | null>(null);

  // Drawer (Cookies, Fingerprint Overrides, Extensions)
  const [manage, setManage] = useState<{ id: string; tab: 'cookies' | 'fingerprint' | 'extensions' } | null>(null);
  const [cookiesText, setCookiesText] = useState('');
  interface FpForm {
    platform?: string;
    brand?: string;
    brandVersion?: string;
    hardwareConcurrency?: number;
    deviceMemory?: number;
    lang?: string;
    screenWidth?: number;
    screenHeight?: number;
    disableSpoofing?: string[];
  }

/**
 * The noise surfaces the operator can switch between Auto and Real.
 *
 * `token` is the kernel's own `--disable-spoofing` value, not a label of our own: the switch
 * is matched by exact string, and an unknown token is accepted and ignored, so a rename here
 * would silently turn the control into decoration. `gpu` is the current spelling — the old
 * `--fingerprint-gpu-vendor` / `--disable-gpu-fingerprint` flags were retired in Chrome 144.
 *
 * `measured` records which of these a probe actually observed changing the browser. Canvas
 * and font were confirmed against the pinned kernel (distinct canvas hash / font count with
 * the token set). Audio, clientrects and gpu are offered because the kernel documents them,
 * but the probe used here could not resolve their effect, so they are labelled as documented
 * rather than presented as equally proven.
 */
const NOISE_SURFACES = [
  { label: 'Canvas', token: 'canvas', measured: true },
  { label: 'Fonts', token: 'font', measured: true },
  { label: 'Audio', token: 'audio', measured: false },
  { label: 'Client rects', token: 'clientrects', measured: false },
  { label: 'WebGL / GPU', token: 'gpu', measured: false },
] as const;
  const [fpForm, setFpForm] = useState<FpForm>({});
  const [extSel, setExtSel] = useState<string[]>([]);

  const loadGroups = useCallback(async () => {
    try {
      const res = await api.groupList();
      if (res.code === 0) setGroups(res.data.list);
    } catch { /* ignore */ }
  }, []);

  const loadProxies = useCallback(async () => {
    try {
      const res = await api.proxyList();
      if (res.code === 0) {
        setProxies(res.data.list);
        setLoaded((l) => ({ ...l, proxies: true }));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (initialGroupId !== undefined) {
      setSelectedGroupFilter(initialGroupId || '');
    }
  }, [initialGroupId]);

  const loadDevices = useCallback(async () => {
    try {
      const res = await api.deviceList();
      if (res.code === 0) {
        setDevices(res.data.list);
        setLoaded((l) => ({ ...l, devices: true }));
      }
    } catch { /* ignore */ }
  }, []);

  const loadMobilePresets = useCallback(async () => {
    try {
      const res = await api.mobilePresets();
      if (res.code === 0) setMobilePresets(res.data.list);
    } catch { /* ignore */ }
  }, []);

  /**
   * The selectable browser languages, from the fingerprint catalog.
   *
   * A failure leaves the fallback in place rather than emptying the list: an empty select would
   * make every stored language unrepresentable, which is the very defect being fixed here.
   */
  const loadBrowserLanguages = useCallback(async () => {
    try {
      const res = await api.browserLanguages();
      if (res.code === 0 && res.data.list.length > 0) setBrowserLanguages(res.data.list);
    } catch { /* keep the fallback */ }
  }, []);

  const loadExtensions = useCallback(async () => {
    try {
      const res = await api.extensionList();
      if (res.code === 0) setExtensions(res.data.list);
    } catch { /* ignore */ }
  }, []);

  // ---- Tags (Sprint 2.3) ----
  const [tags, setTags] = useState<TagItem[]>([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('');
  const [profileTagMap, setProfileTagMap] = useState<Record<string, ProfileTagBinding[]>>({});
  const [showTagModal, setShowTagModal] = useState(false);
  const [tagForm, setTagForm] = useState<{ id: string | null; name: string; color: string }>({ id: null, name: '', color: '#71717a' });

  const loadTags = useCallback(async () => {
    try {
      const res = await api.tagsList();
      if (res.code === 0) setTags(res.data.list);
    } catch { /* ignore */ }
  }, []);
  // ---- Preflight Inspection & Launch Guard (Task 3.1 & 3.2) ----
  const [preflightModal, setPreflightModal] = useState<{
    isOpen: boolean;
    profileId: string;
    profileName?: string;
    verdict: PreflightVerdict | null;
    loading: boolean;
    error: string | null;
    isBlockedLaunch?: boolean;
  }>({
    isOpen: false,
    profileId: '',
    profileName: '',
    verdict: null,
    loading: false,
    error: null,
    isBlockedLaunch: false,
  });
  const [transportError, setTransportError] = useState<{
    profileId: string;
    profileName?: string;
    message: string;
  } | null>(null);
  // ---- Cookie Farm / Profile Warm-up (Task 4) ----
  const [cookieFarmModal, setCookieFarmModal] = useState<{
    isOpen: boolean;
    profileId: string;
    profileName?: string;
    runId?: string;
    progress: CookieFarmProgress | null;
    report: CookieFarmReport | null;
    loading: boolean;
    stopping: boolean;
    error: string | null;
  }>({
    isOpen: false,
    profileId: '',
    profileName: '',
    runId: undefined,
    progress: null,
    report: null,
    loading: false,
    stopping: false,
    error: null,
  });
  const activeFarmRunsRef = useRef<Map<string, string>>(new Map());
  // Mirrors `cookieFarmModal` for the poll loop, which must read the CURRENT run/profile without
  // listing them as effect dependencies — depending on the run id made the effect tear itself down
  // the moment it learned that id. See the note on the polling effect.
  const farmModalRef = useRef(cookieFarmModal);
  useEffect(() => {
    farmModalRef.current = cookieFarmModal;
  }, [cookieFarmModal]);

  const [preflightCache, setPreflightCache] = useState<Record<string, { status: PreflightStatus | 'loading' | 'error'; verdict?: PreflightVerdict }>>({});
  const [blockOnFail, setBlockOnFail] = useState<boolean>(() => {
    try {
      return localStorage.getItem('preflight_block_on_fail') === 'true';
    } catch {
      return false;
    }
  });

  const toggleBlockOnFail = () => {
    setBlockOnFail((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('preflight_block_on_fail', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const runPreflight = async (profileId: string, profileName?: string, openModalAfter: boolean = false) => {
    setPreflightCache((prev) => ({
      ...prev,
      [profileId]: { status: 'loading' },
    }));
    if (openModalAfter) {
      setPreflightModal({
        isOpen: true,
        profileId,
        profileName: profileName || profileId,
        verdict: null,
        loading: true,
        error: null,
      });
    }
    try {
      const res = await api.preflightRun(profileId);
      if (res.code === 0 && res.data) {
        const verdict = res.data;
        setPreflightCache((prev) => ({
          ...prev,
          [profileId]: { status: verdict.overall, verdict },
        }));
        if (openModalAfter) {
          setPreflightModal((m) => ({
            ...m,
            loading: false,
            verdict,
            error: null,
          }));
        }
        return verdict;
      } else {
        const errMsg = res.msg || 'Preflight probe failed';
        setPreflightCache((prev) => ({
          ...prev,
          [profileId]: { status: 'error' },
        }));
        if (openModalAfter) {
          setPreflightModal((m) => ({
            ...m,
            loading: false,
            error: errMsg,
          }));
        }
        return null;
      }
    } catch (err) {
      const errMsg = (err as Error).message || 'Network error running preflight';
      setPreflightCache((prev) => ({
        ...prev,
        [profileId]: { status: 'error' },
      }));
      if (openModalAfter) {
        setPreflightModal((m) => ({
          ...m,
          loading: false,
          error: errMsg,
        }));
      }
      return null;
    }
  };

  const inspectPreflight = async (profileId: string, profileName?: string) => {
    const cached = preflightCache[profileId]?.verdict;
    if (cached) {
      setPreflightModal({
        isOpen: true,
        profileId,
        profileName: profileName || profileId,
        verdict: cached,
        loading: false,
        error: null,
      });
      return;
    }

    setPreflightModal({
      isOpen: true,
      profileId,
      profileName: profileName || profileId,
      verdict: null,
      loading: true,
      error: null,
    });

    try {
      const res = await api.preflightLast(profileId);
      if (res.code === 0 && res.data) {
        setPreflightCache((prev) => ({
          ...prev,
          [profileId]: { status: res.data.overall, verdict: res.data },
        }));
        setPreflightModal((m) => ({
          ...m,
          loading: false,
          verdict: res.data,
          error: null,
        }));
      } else {
        // Run fresh if no last verdict cached
        await runPreflight(profileId, profileName, true);
      }
    } catch {
      // Run fresh if 404 or missing
      await runPreflight(profileId, profileName, true);
    }
  };
  const handleRunCookieFarm = async (profileId: string, profileName?: string) => {
    const knownRunId = activeFarmRunsRef.current.get(profileId);
    setCookieFarmModal({
      isOpen: true,
      profileId,
      profileName: profileName || profileId,
      runId: knownRunId,
      progress: null,
      report: null,
      loading: true,
      stopping: false,
      error: null,
    });

    try {
      const checkRes = await api.cookieFarmProgress({ profileId, runId: knownRunId });
      if (checkRes.code === 0 && checkRes.data?.active) {
        const activeRunId = checkRes.data.runId || knownRunId;
        if (activeRunId) {
          activeFarmRunsRef.current.set(profileId, activeRunId);
        }
        setCookieFarmModal((prev) => ({
          ...prev,
          runId: activeRunId,
          progress: checkRes.data,
          loading: true,
          error: null,
        }));
        return;
      }

      const startRes = await api.startCookieFarm(profileId);
      if (startRes.code === 0 && startRes.data?.runId) {
        const newRunId = startRes.data.runId;
        activeFarmRunsRef.current.set(profileId, newRunId);
        setCookieFarmModal((prev) => ({
          ...prev,
          runId: newRunId,
          loading: true,
          error: null,
        }));
      } else {
        setCookieFarmModal((prev) => ({
          ...prev,
          loading: false,
          error: startRes.msg || t('Cookie farm failed'),
        }));
      }
    } catch (err) {
      setCookieFarmModal((prev) => ({
        ...prev,
        loading: false,
        error: (err as Error).message || t('Failed to run cookie farm'),
      }));
    }
  };

  const handleStopCookieFarm = async () => {
    const runId = cookieFarmModal.runId;
    const profileId = cookieFarmModal.profileId;
    if (!runId && !profileId) return;

    setCookieFarmModal((prev) => ({ ...prev, stopping: true }));
    try {
      await api.stopCookieFarm({ runId, profileId });
    } catch (err) {
      setCookieFarmModal((prev) => ({
        ...prev,
        stopping: false,
        error: (err as Error).message || t('Failed to stop cookie farm'),
      }));
    }
  };

  useEffect(() => {
    if (!cookieFarmModal.isOpen || !cookieFarmModal.loading || !cookieFarmModal.profileId) {
      return;
    }

    let isSubscribed = true;

    const poll = async () => {
      try {
        // Read the run id from the REF, not from state. While it came from `cookieFarmModal.runId`
        // it had to be a dependency of this effect — and the first poll is what LEARNS that id, so
        // every learn tore the effect down, cleared the interval, and dropped the in-flight result
        // via the cleanup's `isSubscribed = false`. The live view was therefore almost never
        // entered: the modal sat on the spinner and then jumped straight to a terminal state.
        // A ref keeps the id available without re-running the effect.
        const runId = activeFarmRunsRef.current.get(farmModalRef.current.profileId) ?? farmModalRef.current.runId;
        const res = await api.cookieFarmProgress({
          runId,
          profileId: farmModalRef.current.profileId,
        });

        if (!isSubscribed) return;

        if (res.code === 0 && res.data?.active) {
          const activeRunId = res.data.runId || runId;
          if (activeRunId) {
            activeFarmRunsRef.current.set(farmModalRef.current.profileId, activeRunId);
          }
          setCookieFarmModal((prev) => ({
            ...prev,
            runId: activeRunId || prev.runId,
            progress: res.data,
          }));
        } else if (res.code === 0 && !res.data?.active) {
          // No run id yet means the start request is still in flight — the modal opens and begins
          // polling BEFORE `startCookieFarm` has answered, so this tick legitimately sees nothing
          // running. Treating that as "finished" was the defect: the live view was killed on the
          // first tick and the operator got a terminal banner instead of progress. Keep waiting.
          if (!runId) return;

          activeFarmRunsRef.current.delete(farmModalRef.current.profileId);
          const targetRunId = runId || res.data?.runId;
          let finalReport: CookieFarmReport | null = null;

          if (targetRunId) {
            try {
              const repRes = await api.cookieFarmReport(targetRunId);
              if (repRes.code === 0 && repRes.data) {
                finalReport = repRes.data;
              }
            } catch {
              // ignore and fallback
            }
          }

          if (!finalReport) {
            try {
              const listRes = await api.cookieFarmReports(farmModalRef.current.profileId);
              if (listRes.code === 0 && Array.isArray(listRes.data) && listRes.data.length > 0) {
                finalReport = listRes.data[0];
              }
            } catch {
              // ignore
            }
          }

          if (finalReport) {
            setCookieFarmModal((prev) => ({
              ...prev,
              loading: false,
              stopping: false,
              progress: null,
              report: finalReport,
              error: null,
            }));
          } else {
            // No report came back for a run that is no longer active. That is NOT an error — the
            // crawl ran — but it is also not a success summary, so say what actually happened
            // rather than painting "completed" red in the error slot, which is what an operator
            // reads as a failure. A short retry covers the write-behind race.
            let retried: CookieFarmReport | null = null;
            if (targetRunId) {
              await new Promise((r) => setTimeout(r, 600));
              try {
                const again = await api.cookieFarmReport(targetRunId);
                if (again.code === 0 && again.data) retried = again.data;
              } catch {
                // fall through to the notice below
              }
            }
            setCookieFarmModal((prev) => ({
              ...prev,
              loading: false,
              stopping: false,
              progress: null,
              report: retried,
              error: retried ? null : t('Warm-up finished. The run report was not available yet.'),
            }));
          }
        }
      } catch {
        // network poll failure: keep modal open and retry on next tick
      }
    };

    void poll();
    const interval = setInterval(poll, 1000);
    return () => {
      isSubscribed = false;
      clearInterval(interval);
    };
  }, [cookieFarmModal.isOpen, cookieFarmModal.loading, cookieFarmModal.profileId, t]);


  // Debounce server-side search (300 ms after the last keystroke).
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Reset to the first page whenever filters/page size change.
  useEffect(() => {
    setPage(1);
  }, [selectedGroupFilter, selectedPlatformFilter, selectedStatusFilter, pageSize, selectedTagFilter]);

  const loadProfiles = useCallback(async () => {
    try {
      const res = await api.list({
        groupId: selectedGroupFilter || undefined,
        page,
        pageSize,
        search: debouncedSearch || undefined,
        platform: selectedPlatformFilter || undefined,
        status: selectedStatusFilter || undefined,
        tagId: selectedTagFilter || undefined,
      });
      if (res.code === 0) {
        setProfiles(res.data.list);
        setTotal(res.data.total);
        setLoaded((l) => ({ ...l, profiles: true }));
        // Tag chips for the visible rows (per-profile fetch, parallelized).
        const ids = res.data.list.map((p) => p.user_id);
        const maps = await Promise.all(
          ids.map(async (uid) => {
            const r = await api.profileTags(uid).catch(() => null);
            return [uid, r && r.code === 0 ? r.data.tags : []] as const;
          })
        );
        setProfileTagMap(Object.fromEntries(maps));
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedGroupFilter, page, pageSize, debouncedSearch, selectedPlatformFilter, selectedStatusFilter, selectedTagFilter]);

  useEffect(() => {
    void loadProfiles();
    void loadGroups();
    void loadProxies();
    void loadDevices();
    void loadMobilePresets();
    void loadExtensions();
    void loadTags();
    void loadBrowserLanguages();
  }, [loadProfiles, loadGroups, loadProxies, loadDevices, loadMobilePresets, loadExtensions, loadTags, loadBrowserLanguages]);

  /**
   * Status refresh.
   *
   * The old mechanism was a 5-second poll gated on `document.visibilityState === 'visible' && !busy`,
   * and that gate is why an agent-opened profile often did not appear: with the window in the
   * background — the normal case when an agent does the work — nothing refreshed at all, and any
   * one of the 17 `setBusy(true)` call sites failing to reach its `setBusy(false)` froze it while
   * the window was right in front of the operator. The report was «отображается, но не всегда».
   *
   * The backend now pushes profile status changes over SSE, so the table updates when something
   * actually happens instead of up to five seconds later, and no UI flag can suppress it. See
   * `eventsStream.ts` for the connection itself.
   */
  useEffect(() => {
    return subscribeToEvents((event) => {
      // `profile-status` is what this subscription originally carried, and it must stay: it is how
      // an agent-opened profile appears in the table.
      if (event.type === 'profile-status') {
        void loadProfiles();
        return;
      }
      // `proxy-geo` matters here too: the PROXY column belongs to this table, and a check queued by
      // any door can land at any moment. Without it the row keeps saying "Not checked yet" until
      // the 30s floor, which is exactly the window the operator reads as "it did not work".
      if (event.type !== 'proxy-geo') return;
      void loadProfiles();
      // And the proxy LIST too: the create/edit modal's "Choose Proxy from List" dropdown renders
      // `proxies`, so a proxy resolved a moment ago still reads as a bare host:port there — the
      // operator opens the modal to use the new geography and finds it missing.
      void loadProxies();
    });
  }, [loadProfiles, loadProxies]);

  /**
   * A slow reconciliation poll, kept as a floor rather than the mechanism.
   *
   * Push can be missed in ways a poll cannot: a stream that dropped while the machine slept, or a
   * status written by a path that never emitted an event. Thirty seconds is long enough that this
   * is not what drives the UI, and short enough that a missed push corrects itself without the
   * operator noticing.
   *
   * The `busy` gate is deliberately gone. It was there to avoid clobbering a list mid-mutation, but
   * a read-only refresh cannot corrupt state, and suppressing it entirely was the bug.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      void loadProfiles();
    }, 30_000);
    return () => clearInterval(timer);
  }, [loadProfiles]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const openCreateModal = () => {
    setModalMode('create');
    setProfileId('');
    setName('');
    // Pre-selected to the group the operator is looking at. Creating while filtered to a group
    // used to reset this to '', so the profile landed in ALL and immediately vanished from the
    // filtered list the operator was still standing in — the profile looked lost. The Group
    // Assignment select still overrides it, and with no group filter this is simply empty.
    setGroupId(selectedGroupFilter || '');
    setDeviceId('');
    setSeed(Math.floor(Math.random() * 2000000000) + 100000000);
    setMobileModelId('');
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');
    setCores(8);
    setProxyMode('none');
    setSavedProxyId('');
    setCustomProxyType('socks5');
    setCustomProxyHost('');
    setCustomProxyPort('');
    setCustomProxyUser('');
    setCustomProxyPass('');
    setProxyTestResult(null);
    setCores(8);
    setProfileTimezone('');
    setProfileLang('');
    setDoNotTrack('auto');
    setBlockedPorts([]);
    setPortInput('');
    setWebrtcPolicy('default');
  };

  /**
   * Persist the profile's browser language.
   *
   * The language is not a column on `profiles`: it lives at `fingerprint.config.lang`, and the
   * launcher turns it into `--lang` and `--accept-lang` (and the stealth layer reports it as
   * `navigator.language`). So it has to be written through the fingerprint route, which merges
   * the given keys into the existing config — untouched fields are preserved.
   *
   * An empty value means "Auto" and is written as an empty string, which the launcher treats as
   * "no explicit language" and lets the fingerprint's own seed-derived locale decide. Deleting
   * the key instead would be equally correct; writing the empty string keeps the shape stable.
   */
  const saveFingerprintConfig = async (
    userId: string,
    values: { lang?: string; disableSpoofing?: string },
  ) => {
    const res = await api.profileDetail(userId);
    if (res.code !== 0 || !res.data) return;
    const cfg = ((res.data.fingerprint?.config ?? {}) as Record<string, unknown>) || {};
    // Both values are written in ONE read-modify-write. Two calls would each re-read the blob
    // and the second would be writing back a copy taken before the first landed.
    await api.profileUpdateFingerprint(userId, { ...cfg, ...values });
  };

  const openEditModal = async (p: ProfileListItem) => {
    setModalMode('edit');
    setProfileId(p.user_id);
    setName(p.name || '');
    setGroupId(p.group_id || '');
    setProxyTestResult(null);
    try {
      const res = await api.profileDetail(p.user_id);
      if (res.code === 0 && res.data) {
        const d = res.data;
        setProfileColor(d.color || '');
        setProfileTimezone(d.timezone || '');
        // `lang` and `deviceMemory` live in the fingerprint's `config` blob, not on the
        // fingerprint object itself — reading them one level up silently yields undefined
        // and the form would show a default that disagrees with the profile. An absent `lang`
        // stays empty so the select renders "Auto" rather than claiming a concrete value.
        const fpCfg = (d.fingerprint?.config ?? {}) as { lang?: string; deviceMemory?: number; disableSpoofing?: string };
        setProfileLang(typeof fpCfg.lang === 'string' ? fpCfg.lang : '');
        setDoNotTrack((d.do_not_track as 'off' | 'on' | 'auto') || 'auto');
        setBlockedPorts(Array.isArray(d.blocked_ports) ? d.blocked_ports.map(Number).filter((n) => !isNaN(n) && n > 0 && n <= 65535) : []);
        setWebrtcPolicy((d.webrtc_policy as 'default' | 'disable_non_proxied_udp' | 'proxy') || 'default');
        setHeadlessMode(d.headless === true);
        setNoiseReal(
          typeof fpCfg.disableSpoofing === 'string' && fpCfg.disableSpoofing
            ? fpCfg.disableSpoofing.split(',').map((x) => x.trim()).filter(Boolean)
            : [],
        );
        if (typeof d.fingerprint?.hardwareConcurrency === 'number') setCores(d.fingerprint.hardwareConcurrency);
        setPortInput('');
        setName(d.name || '');
        setGroupId(d.group_id || '');
        setDeviceId(d.device_id || '');
        setSeed(d.fingerprint?.seed || p.fingerprint_seed || 123456789);
        setMobileModelId(d.mobile_model_id || '');
        setCores(d.fingerprint?.hardwareConcurrency || 8);
        setUserAgent(d.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');

        if (d.proxy) {
          setProxyMode('saved');
          setSavedProxyId(d.proxy.id);
          setCustomProxyType(d.proxy.type);
          setCustomProxyHost(d.proxy.host);
          setCustomProxyPort(String(d.proxy.port));
          setCustomProxyUser(d.proxy.username || '');
        } else {
          setProxyMode('none');
          setSavedProxyId('');
        }
      }
    } catch {
      setSeed(p.fingerprint_seed || 123456789);
    }
  };

  const testProxyLive = async () => {
    setProxyTesting(true);
    setProxyTestResult(null);
    try {
      let payload: { type: string; host: string; port: number; username?: string; password?: string };
      if (proxyMode === 'saved') {
        const px = proxies.find((x) => x.proxy_id === savedProxyId);
        if (!px) {
          setProxyTestResult({ ok: false, error: 'Please select a saved proxy first.' });
          setProxyTesting(false);
          return;
        }
        payload = { type: px.type, host: px.host, port: px.port, username: px.username || undefined };
      } else if (proxyMode === 'custom') {
        if (!customProxyHost.trim() || !customProxyPort.trim()) {
          setProxyTestResult({ ok: false, error: 'Host and Port are required.' });
          setProxyTesting(false);
          return;
        }
        payload = {
          type: customProxyType,
          host: customProxyHost.trim(),
          port: Number(customProxyPort.trim()) || 80,
          username: customProxyUser.trim() || undefined,
          password: customProxyPass.trim() || undefined,
        };
      } else {
        setProxyTestResult({ ok: false, error: 'Proxy mode is set to Direct (No Proxy).' });
        setProxyTesting(false);
        return;
      }

      const res = await api.proxyTest(payload);
      if (res.code === 0) {
        setProxyTestResult(res.data);
      } else {
        setProxyTestResult({ ok: false, error: res.msg });
      }
    } catch (err) {
      setProxyTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setProxyTesting(false);
    }
  };

  const saveProfileModal = async () => {
    setBusy(true);
    setError('');
    try {
      let proxyPayload: any = undefined;
      let proxyIdPayload: string | null | undefined = undefined;

      if (proxyMode === 'none') {
        proxyIdPayload = null;
      } else if (proxyMode === 'saved') {
        proxyIdPayload = savedProxyId || null;
      } else if (proxyMode === 'custom') {
        if (customProxyHost.trim() && customProxyPort.trim()) {
          proxyPayload = {
            type: customProxyType,
            host: customProxyHost.trim(),
            port: Number(customProxyPort.trim()) || 80,
            username: customProxyUser.trim() || undefined,
            password: customProxyPass.trim() || undefined,
          };
        }
      }

      if (modalMode === 'create') {
        const res = await api.create({
          name: name.trim() || undefined,
          group_id: groupId || undefined,
          device_id: deviceId || undefined,
          fingerprint_seed: seed,
          mobile_model_id: mobileModelId || undefined,
          user_agent: userAgent.trim() || undefined,
          proxy_id: proxyIdPayload || undefined,
          proxy: proxyPayload,
          color: profileColor.trim() || undefined,
          timezone: profileTimezone || undefined,
          do_not_track: doNotTrack,
          blocked_ports: blockedPorts,
          webrtc_policy: webrtcPolicy,
          headless: headlessMode,
        });
        if (res.code === 0) {
          // The chosen language lives in the fingerprint's config blob, not on the profile row,
          // so it is written through the fingerprint route. `create` derives a language from the
          // fingerprint seed; without this the operator's choice was discarded at creation too.
          const createdId = res.data?.user_id;
          if (createdId && (profileLang || noiseReal.length > 0)) {
            await saveFingerprintConfig(createdId, {
              lang: profileLang,
              disableSpoofing: noiseReal.join(','),
            });
          }
          setModalMode(null);
          await loadProfiles();
          await loadGroups();
          await loadProxies();
        } else {
          setError(res.msg);
        }
      } else if (modalMode === 'edit' && profileId) {
        const res = await api.profileUpdate({
          user_id: profileId,
          name: name.trim() || undefined,
          group_id: groupId || null,
          device_id: deviceId || null,
          mobile_model_id: mobileModelId || null,
          user_agent: userAgent.trim() || undefined,
          proxy_id: proxyIdPayload,
          proxy: proxyPayload,
          color: profileColor.trim() ? profileColor.trim() : null,
          timezone: profileTimezone || null,
          do_not_track: doNotTrack,
          blocked_ports: blockedPorts,
          webrtc_policy: webrtcPolicy,
          headless: headlessMode,
        });
        if (res.code === 0) {
          // Same reason as the create branch: the language is part of the fingerprint config, and
          // `profileUpdate` does not carry it. Omitting this is exactly the reported defect — the
          // select showed a value, Save reported success, and the value never left the form.
          await saveFingerprintConfig(profileId, {
            lang: profileLang,
            disableSpoofing: noiseReal.join(','),
          });
          setModalMode(null);
          await loadProfiles();
          await loadGroups();
          await loadProxies();
        } else {
          setError(res.msg);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteProfilePrompt = async (id: string) => {
    if (!confirm(`Are you sure you want to delete profile ${id}?`)) return;
    setBusy(true);
    try {
      const res = await api.profileDelete(id);
      if (res.code === 0) {
        await loadProfiles();
        await loadGroups();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDuplicateProfile = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.profileDuplicate(id);
      if (res.code === 0) {
        await loadProfiles();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleExportProfile = async (id: string, label: string) => {
    setError('');
    try {
      const res = await api.profileExport(id);
      if (res.code === 0) {
        const blob = new Blob([JSON.stringify(res.data.bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `antidetect-profile-${label.replace(/[^a-zA-Z0-9-_]/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRandomizeFingerprint = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.randomizeFingerprint(id);
      if (res.code === 0) {
        await loadProfiles();
        if (modalMode === 'edit' && profileId === id) {
          setSeed(res.data.seed);
        }
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.groupCreate(newGroupName.trim());
      if (res.code === 0) {
        setNewGroupName('');
        await loadGroups();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateGroup = async () => {
    if (!editingGroup || !editingGroup.name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.groupUpdate(editingGroup.id, editingGroup.name.trim());
      if (res.code === 0) {
        setEditingGroup(null);
        await loadGroups();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm('Are you sure you want to delete this group? Profiles in this group will be unassigned.')) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.groupDelete(groupId);
      if (res.code === 0) {
        if (selectedGroupFilter === groupId) setSelectedGroupFilter('');
        await loadGroups();
        await loadProfiles();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- Profile Note Modal ----
  const openNoteModal = useCallback(async (p: ProfileListItem) => {
    setNoteModalProfile(p);
    setNoteText('');
    setNoteError('');
    setNoteBusy(true);
    try {
      const res = await api.profileDetail(p.user_id);
      if (res.code === 0 && res.data) {
        setNoteText(res.data.notes || '');
      } else if (res.msg) {
        setNoteError(res.msg);
      }
    } catch (err) {
      setNoteError((err as Error).message);
    } finally {
      setNoteBusy(false);
    }
  }, []);

  const closeNoteModal = useCallback(() => {
    setNoteModalProfile(null);
    setNoteText('');
    setNoteError('');
  }, []);

  const saveNoteModal = async () => {
    if (!noteModalProfile) return;
    setNoteBusy(true);
    setNoteError('');
    try {
      const res = await api.profileUpdate({
        user_id: noteModalProfile.user_id,
        notes: noteText,
      });
      if (res.code === 0) {
        closeNoteModal();
      } else {
        setNoteError(res.msg || 'Failed to save note');
      }
    } catch (err) {
      setNoteError((err as Error).message);
    } finally {
      setNoteBusy(false);
    }
  };
  // ---- Tag management (Sprint 2.3) ----
  const saveTag = async () => {
    if (!tagForm.name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = tagForm.id
        ? await api.tagUpdate(tagForm.id, { name: tagForm.name.trim(), color: tagForm.color })
        : await api.tagCreate(tagForm.name.trim(), tagForm.color);
      if (res.code === 0) {
        setTagForm({ id: null, name: '', color: '#71717a' });
        await loadTags();
        await loadProfiles();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteTagById = async (tagId: string) => {
    if (!confirm('Delete this tag? It will be removed from all profiles.')) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.tagDelete(tagId);
      if (res.code === 0) {
        if (selectedTagFilter === tagId) setSelectedTagFilter('');
        await loadTags();
        await loadProfiles();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isProxyTransportError = (msg?: string): boolean => {
    if (!msg) return false;
    const lower = msg.toLowerCase();
    return (
      lower.includes('proxy transport probe failed') ||
      lower.includes('tcpconnect') ||
      lower.includes('probe failed at stage') ||
      lower.includes('proxy connection') ||
      lower.includes('econnrefused') ||
      lower.includes('etimedout')
    );
  };

  const start = async (id: string, profileName?: string, skipPreflightGuard = false) => {
    setBusy(true);
    setError('');
    setTransportError(null);
    try {
      // If blockOnFail is enabled, run startWithPreflight guard check unless overridden
      if (blockOnFail && !skipPreflightGuard) {
        const guardRes = await api.startWithPreflight(id, true);
        if (guardRes.code !== 0 || !guardRes.data?.allowed) {
          const errMsg = guardRes.msg || 'Launch blocked by preflight check failure';
          setError(errMsg);
          // Show the verdict the guard just produced. The blocked response puts the verdict in
          // `data` ITSELF (routes/preflight.ts returns `data: guard.verdict` with HTTP 412), not
          // under `data.verdict` — reading the nested key silently found nothing and fell through
          // to the cache, which is the stale-PASS defect this is meant to close.
          const blocked = guardRes.data as
            | (PreflightVerdict & { allowed?: boolean })
            | undefined;
          const freshVerdict: PreflightVerdict | undefined =
            blocked && typeof blocked.overall === 'string' ? blocked : undefined;
          if (freshVerdict) {
            setPreflightCache((prev) => ({
              ...prev,
              [id]: { status: freshVerdict.overall, verdict: freshVerdict },
            }));
            setPreflightModal({
              isOpen: true,
              profileId: id,
              profileName: profileName || id,
              verdict: freshVerdict,
              loading: false,
              error: null,
              isBlockedLaunch: true,
            });
          } else {
            await inspectPreflight(id, profileName);
          }
          return;
        }
      }
      const res = await api.start(id);
      if (res.code === 0) {
        setEndpoint({ id, ws: res.data.ws.puppeteer });
        await loadProfiles();
      } else {
        if (isProxyTransportError(res.msg)) {
          setTransportError({
            profileId: id,
            profileName: profileName || id,
            message: res.msg,
          });
        } else {
          setError(res.msg);
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (isProxyTransportError(msg)) {
        setTransportError({
          profileId: id,
          profileName: profileName || id,
          message: msg,
        });
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.stop(id);
      if (res.code === 0) {
        if (endpoint?.id === id) setEndpoint(null);
        await loadProfiles();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createBatch = async () => {
    setBusy(true);
    setError('');
    try {
      const count = Number(batchCount) || 5;
      const res = await api.batchCreate({
        count,
        name_prefix: batchPrefix || 'profile',
      });
      if (res.code === 0) {
        if (batchGroup && res.data.user_ids?.length) {
          for (const uid of res.data.user_ids) {
            await api.profileUpdate({ user_id: uid, group_id: batchGroup });
          }
        }
        setShowBatch(false);
        await loadProfiles();
        await loadGroups();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openManage = async (id: string, tab: 'cookies' | 'fingerprint' | 'extensions') => {
    setError('');
    setManage({ id, tab });
    setCookiesText('');
    setFpForm({});
    setExtSel([]);
    if (tab === 'extensions') {
      const res = await api.profileExtensions(id);
      if (res.code === 0) setExtSel(res.data.extension_ids);
    }
    if (tab === 'fingerprint') {
      // Load the current overrides into the structured form.
      const res = await api.profileDetail(id);
      if (res.code === 0) {
        const cfg = (res.data.fingerprint?.config ?? {}) as Record<string, unknown>;
        const screen = cfg.screen as { width?: number; height?: number } | undefined;
        setFpForm({
          platform: typeof cfg.platform === 'string' ? cfg.platform : '',
          brand: typeof cfg.brand === 'string' ? cfg.brand : '',
          brandVersion: typeof cfg.brandVersion === 'string' ? cfg.brandVersion : '',
          hardwareConcurrency: typeof cfg.hardwareConcurrency === 'number' ? cfg.hardwareConcurrency : undefined,
          deviceMemory: typeof cfg.deviceMemory === 'number' ? cfg.deviceMemory : undefined,
          lang: typeof cfg.lang === 'string' ? cfg.lang : '',
          screenWidth: screen?.width,
          screenHeight: screen?.height,
          disableSpoofing:
            typeof cfg.disableSpoofing === 'string' && cfg.disableSpoofing
              ? cfg.disableSpoofing.split(',').map((s) => s.trim()).filter(Boolean)
              : undefined,
        });
      }
    }
  };

  const saveCookies = async () => {
    if (!manage) return;
    setBusy(true);
    setError('');
    try {
      let cookies: Array<Record<string, unknown>>;
      try {
        cookies = JSON.parse(cookiesText);
      } catch {
        setError('Invalid JSON for cookies');
        setBusy(false);
        return;
      }
      const res = await api.cookiesImport(manage.id, cookies);
      if (res.code !== 0) setError(res.msg);
      setManage(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveFingerprint = async () => {
    if (!manage) return;
    setBusy(true);
    setError('');
    try {
      // Structured form -> fingerprint config JSON (backend validates ranges).
      const cfg: Record<string, unknown> = {};
      if (fpForm.platform) cfg.platform = fpForm.platform;
      if (fpForm.brand) cfg.brand = fpForm.brand;
      if (fpForm.brandVersion) cfg.brandVersion = fpForm.brandVersion;
      if (fpForm.hardwareConcurrency) cfg.hardwareConcurrency = fpForm.hardwareConcurrency;
      if (fpForm.deviceMemory) cfg.deviceMemory = fpForm.deviceMemory;
      if (fpForm.lang) cfg.lang = fpForm.lang;
      if (fpForm.screenWidth && fpForm.screenHeight) {
        cfg.screen = { width: fpForm.screenWidth, height: fpForm.screenHeight };
      }
      if (fpForm.disableSpoofing?.length) cfg.disableSpoofing = fpForm.disableSpoofing.join(',');
      const res = await api.profileUpdateFingerprint(manage.id, cfg);
      if (res.code !== 0) setError(res.msg);
      setManage(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveExtensions = async () => {
    if (!manage) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.profileBindExtensions(manage.id, extSel);
      if (res.code !== 0) setError(res.msg);
      setManage(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const getGroupName = (gId: string | null): string => {
    if (!gId) return 'Ungrouped';
    const g = groups.find((item) => item.id === gId);
    return g ? g.name : 'Unknown';
  };

  // Filtering (search/platform/status) and pagination are server-side now.
  const filteredProfiles = profiles;

  /**
   * Column widths, dragged by the operator.
   *
   * Every column except the last is resizable; Actions takes whatever remains, which is what
   * keeps the table inside its container at any window size. The shares are fractions rather
   * than pixels for that same reason — a pixel width saved on a wide window would not fit a
   * narrow one, and the horizontal scrollbar would come back.
   *
   * These shares deliberately sum to ~0.755, NOT to 1: the remainder is the Actions column's
   * room, and it has to hold four icon buttons plus the kebab. A set summing to 0.85 leaves that
   * column 148px at a 992px content width — less than the buttons need — and since cells clip
   * (no scrolling), the buttons would be cut off rather than pushed into a scrollbar.
   */
  const columns = useMemo(
    () => [
      { key: 'check', defaultFraction: 0.045, minWidth: 44 },
      { key: 'name', defaultFraction: 0.35, minWidth: 160 },
      { key: 'proxy', defaultFraction: 0.24, minWidth: 130 },
      { key: 'status', defaultFraction: 0.12, minWidth: 96 },
    ],
    [],
  );
  const { containerRef: tableRef, colWidths, beginResize, resetColumn, dragging } = useColumnResize('profiles', columns);

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredProfiles.length && filteredProfiles.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredProfiles.map((p) => p.user_id)));
    }
  };

  const toggleSelectProfile = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };


  // Realistic random Chrome UA matching the bundled kernel (Chrome 148).
  // Platform-consistent: Windows 10/11 or macOS — never mixes (e.g. Mac UA on Windows kernel).
  const generateRandomUa = (): string => {
    const chromeVer = '148.0.0.0';
    const webkit = '537.36';
    const roll = Math.random();
    if (roll < 0.45) {
      // Windows 10 / 11 (both report NT 10.0)
      const variants = [
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${chromeVer} Safari/${webkit}`,
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${chromeVer} Safari/${webkit} Edg/${chromeVer}`,
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    if (roll < 0.7) {
      // macOS (platform version in UA is fixed at 10_15_7 by Chrome itself)
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${chromeVer} Safari/${webkit}`;
    }
    // Linux
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${chromeVer} Safari/${webkit}`;
  };

  const handleBulkStart = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    setError('');
    try {
      const res = await api.bulkStart(Array.from(selectedIds));
      if (res.code === 0) {
        const failedCount = res.data.failed?.length ?? 0;
        if (failedCount > 0) setError(`Started ${res.data.succeeded.length}, failed ${failedCount}: ${res.data.failed[0].error}`);
        await loadProfiles();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkStop = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    setError('');
    try {
      const res = await api.bulkStop(Array.from(selectedIds));
      if (res.code === 0) {
        const failedCount = res.data.failed?.length ?? 0;
        if (failedCount > 0) setError(`Stopped ${res.data.succeeded.length}, failed ${failedCount}: ${res.data.failed[0].error}`);
        await loadProfiles();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkMoveGroup = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    setError('');
    try {
      const res = await api.bulkGroup(Array.from(selectedIds), bulkTargetGroup || null);
      if (res.code === 0) {
        await loadProfiles();
        await loadGroups();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (!window.confirm(`Are you sure you want to delete ${count} selected profile(s)? This action cannot be undone.`)) {
      return;
    }
    setBulkBusy(true);
    setError('');
    try {
      const res = await api.bulkDelete(Array.from(selectedIds));
      if (res.code === 0) {
        setSelectedIds(new Set());
        const failedCount = res.data.failed?.length ?? 0;
        if (failedCount > 0) setError(`Deleted ${res.data.succeeded.length}, failed ${failedCount}: ${res.data.failed[0].error}`);
        await loadProfiles();
        await loadGroups();
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkBusy(false);
    }
  };

  // ---- Action Syncer (Sprint 3): mirror actions across running profiles ----
  const selectedRunning = profiles.filter((p) => selectedIds.has(p.user_id) && p.status === 'running');
  const syncEligible = selectedRunning.length >= 2;

  const handleStartSync = async () => {
    if (!syncEligible) return;
    setSyncBusy(true);
    setError('');
    try {
      const res = await api.syncCreate(selectedRunning.map((p) => p.user_id));
      if (res.code === 0) {
        setSyncSession(res.data);
      } else {
        setError(res.msg);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncBusy(false);
    }
  };

  const runningNow = computeRunningCount(profiles);

  return (
    <div>
      {/* Metric summary, in the reference's order and shape: a row of equal cards above the
          tabs, each a label plus a large tabular figure. Every number is a real backend
          value — `total`/`profiles` from the profile list, `proxies` and `devices` from
          their own lists (both already loaded by the effects above). A value that has not
          arrived renders as an em dash rather than 0, because "0" is a claim and a missing
          number is not the same claim. */}
      <div className="metrics-row">
        <div className={`metric-card${total > 0 ? ' accent' : ''}`}>
          <div className="metric-label">{t('Profiles')}</div>
          <div className="metric-value">{loaded.profiles ? total : '—'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t('Running')}</div>
          <div className={`metric-value${runningNow > 0 ? ' ok' : ''}`}>{loaded.profiles ? runningNow : '—'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t('Proxies')}</div>
          <div className="metric-value">{loaded.proxies ? proxies.length : '—'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t('Devices')}</div>
          <div className="metric-value">{loaded.devices ? devices.length : '—'}</div>
        </div>
      </div>

      {/* Top Action Header */}
      <div
        className="page-header-actions"
        style={{
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-3)',
        }}
      >
        {/* Top Action Row: Group/Tag toggles, Utilities, and single primary action */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          {/* Left Action Buttons: Restrained secondary toolbar controls */}
          <div className="header-btn-group" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            <button className="btn btn-sm" onClick={() => setShowGroupModal(true)}>
              <FolderIcon size={13} />
              <span>Groups</span>
            </button>
            <button
              className="btn btn-sm"
              onClick={() => { setTagForm({ id: null, name: '', color: 'var(--text-secondary)' }); setShowTagModal(true); }}
            >
              <ProxiesIcon size={13} />
              <span>Tags</span>
            </button>
            <button
              className={`btn btn-sm ${blockOnFail ? 'active' : ''}`}
              onClick={toggleBlockOnFail}
              title={t('Block profile launch if preflight check fails (enforces proxy & fingerprint health before start)')}
              style={{
                borderColor: blockOnFail ? 'var(--accent)' : undefined,
                color: blockOnFail ? 'var(--accent)' : undefined,
                background: blockOnFail ? 'var(--control-bg-active)' : undefined,
              }}
            >
              <ShieldCheckIcon size={13} />
              <span>{blockOnFail ? t('Preflight Guard: ON') : t('Preflight Guard: OFF')}</span>
            </button>
            <div style={{ width: 1, height: 16, background: 'var(--divider)', margin: '0 4px' }} />
            <button className="btn btn-sm" onClick={() => setShowBatch(true)}>
              {t('Batch Create')}
            </button>
          </div>

          {/* Primary Action Button */}
          <div>
            <button className="btn btn-sm primary" onClick={openCreateModal} disabled={busy} style={{ fontWeight: 500 }}>
              <PlusIcon size={14} />
              <span>{t('New Profile')}</span>
            </button>
          </div>
        </div>

        {/* Integrated Unified Filter Toolbar Strip */}
        <div
          className="header-filters"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '2px',
            overflow: 'hidden',
          }}
        >
          <div
            className="search-box"
            style={{
              flex: 1,
              minWidth: 180,
              background: 'transparent',
              border: 'none',
              borderRight: '1px solid var(--border)',
              borderRadius: 0,
              height: 'var(--control-h-sm)',
              padding: '0 8px',
            }}
          >
            <SearchIcon size={14} style={{ color: 'var(--text-muted)' }} />
            <input
              placeholder={t('Search profile name, ID, or proxy...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ fontSize: 'var(--text-xs)', background: 'transparent', border: 'none', outline: 'none' }}
            />
          </div>
          <Dropdown
            size="sm"
            ariaLabel={t('All Groups')}
            value={selectedGroupFilter}
            onChange={setSelectedGroupFilter}
            placeholder={`${t('All Groups')} (${groups.reduce((acc, g) => acc + g.profile_count, 0)})`}
            options={[
              { value: '', label: `${t('All Groups')} (${groups.reduce((acc, g) => acc + g.profile_count, 0)})` },
              ...groups.map((g) => ({ value: g.id, label: `${g.name} (${g.profile_count})` })),
            ]}
          />

          <Dropdown
            size="sm"
            ariaLabel={t('All Platforms')}
            value={selectedPlatformFilter}
            onChange={setSelectedPlatformFilter}
            placeholder={t('All Platforms')}
            options={[
              { value: '', label: t('All Platforms') },
              { value: 'windows', label: t('Windows') },
              { value: 'macos', label: t('macOS') },
              { value: 'android', label: t('Android') },
              { value: 'ios', label: t('iOS') },
              { value: 'linux', label: t('Linux') },
            ]}
          />

          <Dropdown
            size="sm"
            ariaLabel={t('All Statuses')}
            value={selectedStatusFilter}
            onChange={setSelectedStatusFilter}
            placeholder={t('All Statuses')}
            options={[
              { value: '', label: t('All Statuses') },
              { value: 'running', label: t('Running') },
              { value: 'closed', label: t('Closed') },
            ]}
          />

          <Dropdown
            size="sm"
            ariaLabel={t('All Tags')}
            value={selectedTagFilter}
            onChange={setSelectedTagFilter}
            placeholder={t('All Tags')}
            options={[
              { value: '', label: t('All Tags') },
              ...tags.map((tg) => ({ value: tg.id, label: `${tg.name} (${tg.profile_count})` })),
            ]}
          />
        </div>
      </div>

      {transportError && (
        <div
          className="transport-refusal-banner"
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--danger)',
            borderLeft: '4px solid var(--danger)',
            borderRadius: 'var(--radius-md)',
            padding: '14px 18px',
            margin: '0 0 16px 0',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>🔌</span>
              <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--danger)' }}>
                {t('Proxy Refused Connection (Transport Failure)')}
              </span>
              <span
                className="preflight-tag fail"
                style={{ fontSize: 10, padding: '1px 6px' }}
              >
                {t('NOT GUARD BLOCKED')}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setTransportError(null)}
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              {t('Dismiss')}
            </button>
          </div>

          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {t(
              'The launch was NOT blocked by Preflight Guard. The proxy server itself timed out or refused the connection during transport probing.'
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
              {t('Transport Error Details:')}
            </span>
            <code
              className="preflight-code"
              style={{
                padding: '6px 10px',
                background: 'var(--control-bg)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                color: 'var(--text)',
                wordBreak: 'break-all',
              }}
            >
              {transportError.message}
            </code>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--warn-bg)',
              color: 'var(--warn)',
              fontSize: 11.5,
            }}
          >
            <span>💡</span>
            <span>
              {t(
                'Pointer: The proxy needs fixing. Check host, port, credentials, or server status in profile settings.'
              )}
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 11.5,
              color: 'var(--warn)',
            }}
          >
            <span>⚠️</span>
            <span>
              {t(
                'Warning: Launching without proxy will route traffic through your real IP address.'
              )}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                const p = profiles.find((item) => item.user_id === transportError.profileId);
                if (p) {
                  await openEditModal(p);
                }
              }}
            >
              {t('Edit Proxy Settings')}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={async () => {
                const id = transportError.profileId;
                const name = transportError.profileName;
                setTransportError(null);
                await api.profileUpdate({ user_id: id, proxy_id: null, proxy: null });
                await loadProfiles();
                await start(id, name, true);
              }}
              title={t('Remove proxy from profile and launch directly using real IP')}
            >
              {t('Launch without proxy')}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                const id = transportError.profileId;
                const name = transportError.profileName;
                setTransportError(null);
                await start(id, name, false);
              }}
            >
              {t('Retry Launch')}
            </button>
          </div>
        </div>
      )}
      {error ? <div className="error-banner">{error}</div> : null}

      {endpoint ? (
        <div className="endpoint-banner">
          <div>
            <strong style={{ fontSize: 13, marginRight: 10 }}>Active CDP:</strong>
            <code>{endpoint.ws}</code>
          </div>
          <span className="hint" style={{ margin: 0 }}>Connected to automation</span>
        </div>
      ) : null}

      {/* Profiles Table */}
      <div className="table-container" ref={tableRef}>
        <table className="table">
          {/*
            Widths live here, not on the `<th>` elements: with `table-layout: fixed` a `<col>`
            is authoritative, while a width on the header cell is only a hint that a long name
            can override. The Actions column carries no `<col>` — it takes the remainder, so the
            table is always exactly the container's width and never needs to scroll.
          */}
          <colgroup>
            {colWidths.map((col) => (
              <col key={col.key} style={{ width: `${col.percent}%` }} />
            ))}
            <col />
          </colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: 'center' }}>
                <span className="row-dense__check">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === filteredProfiles.length && filteredProfiles.length > 0}
                    onChange={toggleSelectAll}
                    style={{ cursor: 'pointer' }}
                  />
                </span>
              </th>
              <th>
                {t('Profile Name')}
                <button
                  type="button"
                  className={`col-resize-handle ${dragging === 'name' ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginResize('name', e)}
                  onDoubleClick={() => resetColumn('name')}
                  title={t('Drag to resize. Double-click to reset.')}
                  aria-label={t('Resize column')}
                  tabIndex={-1}
                />
              </th>
              <th>
                {t('Proxy')}
                <button
                  type="button"
                  className={`col-resize-handle ${dragging === 'proxy' ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginResize('proxy', e)}
                  onDoubleClick={() => resetColumn('proxy')}
                  title={t('Drag to resize. Double-click to reset.')}
                  aria-label={t('Resize column')}
                  tabIndex={-1}
                />
              </th>
              <th>
                {t('Status')}
                <button
                  type="button"
                  className={`col-resize-handle ${dragging === 'status' ? 'is-dragging' : ''}`}
                  onPointerDown={(e) => beginResize('status', e)}
                  onDoubleClick={() => resetColumn('status')}
                  title={t('Drag to resize. Double-click to reset.')}
                  aria-label={t('Resize column')}
                  tabIndex={-1}
                />
              </th>
              <th style={{ textAlign: 'right' }}>{t('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredProfiles.length === 0 ? (
              searchQuery ? (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    {t('No profiles match your search criteria.')}
                  </td>
                </tr>
              ) : (
                <EmptyState
                  colSpan={5}
                  icon={<ProfilesIcon size={32} />}
                  title={t('No profiles yet')}
                  description={t('Create your first browser profile — each profile gets a unique fingerprint, device, and proxy.')}
                  action={
                    <button className="btn btn-sm primary" onClick={openCreateModal} style={{ fontWeight: 500 }}>
                      <PlusIcon size={13} />
                      <span>{t('New Profile')}</span>
                    </button>
                  }
                />
              )
            ) : (
              filteredProfiles.map((p) => (
                <tr key={p.user_id} className={`row-dense ${selectedIds.has(p.user_id) ? 'selected-row' : ''}`}>
                  <td style={{ textAlign: 'center' }}>
                    <span className="row-dense__check">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(p.user_id)}
                        onChange={() => toggleSelectProfile(p.user_id)}
                        style={{ cursor: 'pointer' }}
                      />
                    </span>
                  </td>
                  <td>
                    <div className="row-dense__lead">
                      {p.color ? (
                        <span
                          data-testid="profile-color-dot"
                          title={p.color}
                          style={{ width: 10, height: 10, borderRadius: 999, background: p.color, flexShrink: 0, border: '1px solid rgba(255,255,255,0.25)' }}
                        />
                      ) : null}
                      <strong style={{ fontSize: 13, color: 'var(--text)' }}>{p.name || 'Unnamed Profile'}</strong>
                      <span className="row-dense__group">
                        <span className="group-tag">
                          <FolderIcon size={10} />
                          {getGroupName(p.group_id)}
                        </span>
                      </span>
                      {(profileTagMap[p.user_id] || []).map((tg) => (
                        <span
                          key={tg.tag_id}
                          className="group-tag"
                          style={{ color: tg.color || 'var(--text-secondary)', borderColor: `${tg.color || 'var(--border)'}66` }}
                          title={tg.name}
                        >
                          #{tg.name}
                        </span>
                      ))}
                      <div className="id-badge">
                        <code>{p.user_id.slice(0, 8)}</code>
                        <button onClick={() => copyToClipboard(p.user_id)} title="Copy ID">
                          {copiedId === p.user_id ? <CheckIcon size={11} style={{ color: 'var(--ok)' }} /> : <CopyIcon size={11} />}
                        </button>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="row-dense__meta">
                      {p.proxy_host ? (
                        /* Geography ONLY — no protocol, no host:port.
                           The column answers one question, "where does this profile exit", and the
                           transport plus address were noise in it (the address is still reachable
                           in the tooltip). A proxy whose last check FAILED shows a cross instead of
                           a location: it has no exit to report, and printing a stale country next
                           to a dead proxy would be worse than printing nothing. */
                        <div
                          className="proxy-tag"
                          title={`${(p.proxy_type || 'HTTP').toUpperCase()} · ${p.proxy_host}:${p.proxy_port}`}
                        >
                          {p.proxy_status === 'fail' ? (
                            <span
                              data-testid="proxy-failed"
                              style={{ color: 'var(--danger)', fontSize: 13, fontWeight: 700, lineHeight: 1 }}
                              title={t('Proxy check failed — no exit location')}
                            >
                              ✕
                            </span>
                          ) : p.proxy_country_code || p.proxy_country ? (
                            <span
                              style={{ color: 'var(--accent)', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                            >
                              {/*
                                A real flag ICON, not the emoji. Windows has no glyph for the
                                regional-indicator pair, so the emoji rendered as the bare letters
                                "PL" — measured in this app's kernel: one monochrome colour on a
                                canvas, 14px wide. The icon is drawn as SVG, so it looks the same on
                                every platform, and it renders NOTHING for a code it does not cover
                                (the two-letter code below is still shown, so nothing is lost).
                              */}
                              <CountryFlag code={p.proxy_country_code} height={11} />
                              {p.proxy_country_code ? `${p.proxy_country_code.toUpperCase()} · ` : ''}
                              {[p.proxy_country, p.proxy_city].filter(Boolean).join(' · ')}
                            </span>
                          ) : (
                            /* No result yet. Named rather than left blank, so an unchecked proxy is
                               distinguishable from a failed one. */
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                              {t('Not checked yet')}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Direct (No Proxy)</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className="row-dense__status">
                      <span className={`badge ${p.status}`}>
                        {p.status === 'running' ? t('Running') : t('Closed')}
                      </span>
                    </span>
                  </td>
                  <td>
                    <div className="row-dense__actions" style={{ justifyContent: 'flex-end', position: 'relative' }}>
                      {p.status === 'running' ? (
                        <button
                          type="button"
                          className="btn-icon stop-btn"
                          onClick={() => void stop(p.user_id)}
                          disabled={busy}
                          title="Stop Profile"
                        >
                          <StopIcon size={13} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-icon play-btn"
                          onClick={() => void start(p.user_id, p.name || undefined)}
                          disabled={busy}
                          title={blockOnFail ? t('Start Profile (with Preflight Guard)') : t('Start Profile')}
                        >
                          <PlayIcon size={13} />
                        </button>
                      )}
                      {/* Preflight stays a first-class row action: it is the check the operator
                          runs before a launch, and burying it in the menu would hide the reason a
                          profile refuses to start. Compact form, so the column is one row of
                          buttons of the same size. */}
                      <PreflightBadge
                        compact
                        status={preflightCache[p.user_id]?.status}
                        verdict={preflightCache[p.user_id]?.verdict}
                        onClick={() => void inspectPreflight(p.user_id, p.name || undefined)}
                        onRun={() => void runPreflight(p.user_id, p.name || undefined, true)}
                      />
                      {/* Settings is the control an operator reaches for constantly, so it keeps a
                          visible button — drawn as a gear, because the edit pencil read as "rename"
                          rather than "open this profile's settings". Warm-up and Note moved into the
                          menu: both are occasional, and the row had grown to six buttons of three
                          different shapes. */}
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => void openEditModal(p)}
                        disabled={busy}
                        title={t('Profile settings')}
                      >
                        <SettingsIcon size={14} />
                      </button>


                      {/* Kebab Action Menu */}
                      <div style={{ position: 'relative' }}>
                        <button
                          type="button"
                          className={`btn-icon ${activeMenuId === p.user_id ? 'active' : ''}`}
                          onClick={(e) => {
                            if (activeMenuId === p.user_id) {
                              setActiveMenuId(null);
                              return;
                            }
                            // Position the menu with `fixed` coordinates from the button so
                            // the table container's overflow can never clip it. Flip above
                            // the button when there is not enough room below.
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            const MENU_H = 270;
                            const top =
                              rect.bottom + MENU_H > window.innerHeight
                                ? Math.max(8, rect.top - MENU_H - 6)
                                : rect.bottom + 6;
                            const right = Math.max(8, window.innerWidth - rect.right);
                            setMenuPos({ top, right });
                            setActiveMenuId(p.user_id);
                          }}
                          title="More actions"
                          style={{ fontWeight: 800, fontSize: 13, padding: '0 6px' }}
                        >
                          ⋯
                        </button>

                        {activeMenuId === p.user_id ? (
                          <>
                            <div
                              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                              onClick={() => setActiveMenuId(null)}
                            />
                            <div
                              style={{
                                position: 'fixed',
                                right: menuPos.right,
                                top: menuPos.top,
                                zIndex: 100,
                                minWidth: 175,
                                background: 'var(--panel)',
                                border: '1px solid var(--border)',
                                borderRadius: 6,
                                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                                padding: '4px 0',
                                display: 'flex',
                                flexDirection: 'column',
                              }}
                            >
                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void handleDuplicateProfile(p.user_id);
                                }}
                              >
                                <CopyIcon size={13} />
                                <span>Duplicate Profile</span>
                              </button>

                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void handleExportProfile(p.user_id, p.name || p.user_id);
                                }}
                              >
                                <CopyIcon size={13} />
                                <span>Export Profile (bundle)</span>
                              </button>

                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void handleRandomizeFingerprint(p.user_id);
                                }}
                              >
                                <DiceIcon size={13} />
                                <span>Randomize Seed</span>
                              </button>

                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void openManage(p.user_id, 'cookies');
                                }}
                              >
                                <CookieIcon size={13} />
                                <span>Manage Cookies</span>
                              </button>
                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void handleRunCookieFarm(p.user_id, p.name || undefined);
                                }}
                              >
                                <CookieIcon size={13} />
                                <span>{t('Warm up profile (cookie farm)')}</span>
                              </button>
                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void openNoteModal(p);
                                }}
                              >
                                <NoteIcon size={13} />
                                <span>{t('Note')}</span>
                              </button>

                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void openManage(p.user_id, 'fingerprint');
                                }}
                              >
                                <FingerprintIcon size={13} />
                                <span>Fingerprint Config</span>
                              </button>

                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--text)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void openManage(p.user_id, 'extensions');
                                }}
                              >
                                <ExtensionsIcon size={13} />
                                <span>Bind Extensions</span>
                              </button>

                              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

                              <button
                                type="button"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '7px 12px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--danger)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                }}
                                onClick={() => {
                                  setActiveMenuId(null);
                                  void deleteProfilePrompt(p.user_id);
                                }}
                              >
                                <TrashIcon size={13} />
                                <span>Delete Profile</span>
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14,
            padding: '0 4px',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {t('Total')}: <strong style={{ color: 'var(--text)' }}>{total}</strong> {total === 1 ? t('profile') : t('profiles')}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <select
              className="select-input"
              style={{ fontSize: 12, padding: '4px 8px' }}
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
            >
              <option value={50}>{t('50 / page')}</option>
              <option value={100}>{t('100 / page')}</option>
              <option value={200}>{t('200 / page')}</option>
            </select>

            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              {t('← Prev')}
            </button>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              {t('Page')} {page} {t('of')} {Math.max(1, Math.ceil(total / pageSize))}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPage((p) => (p * pageSize < total ? p + 1 : p))}
              disabled={page * pageSize >= total}
            >
              {t('Next →')}
            </button>
          </div>
        </div>
      ) : null}

      {/* Floating Bulk Actions Bar */}
      {selectedIds.size > 0 ? (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--panel)',
            border: '1px solid var(--accent)',
            boxShadow: '0 12px 36px rgba(0,0,0,0.6)',
            borderRadius: 10,
            padding: '10px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            zIndex: 900,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
            <span
              style={{
                background: 'var(--accent)',
                color: 'var(--accent-foreground)',
                borderRadius: '50%',
                width: 22,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11.5,
              }}
            >
              {selectedIds.size}
            </span>
            <span>{t('Selected')}</span>
          </div>

          <div style={{ height: 18, width: 1, background: 'var(--border)' }} />

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleBulkStart()}
            disabled={bulkBusy}
            title={t('Start selected profiles')}
            style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text)', borderColor: 'rgba(255, 255, 255, 0.22)' }}
          >
            <PlayIcon size={12} />
            <span>{t('Start')}</span>
          </button>

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleBulkStop()}
            disabled={bulkBusy}
            title={t('Stop selected profiles')}
            style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-secondary)', borderColor: 'rgba(255, 255, 255, 0.22)' }}
          >
            <StopIcon size={12} />
            <span>{t('Stop')}</span>
          </button>

          <div style={{ height: 18, width: 1, background: 'var(--border)' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select
              className="select-input"
              style={{ fontSize: 12, padding: '4px 8px' }}
              value={bulkTargetGroup}
              onChange={(e) => setBulkTargetGroup(e.target.value)}
              disabled={bulkBusy}
            >
              <option value="">{t('Move to Group...')}</option>
              <option value="">{t('(No Group / Ungrouped)')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void handleBulkMoveGroup()}
              disabled={bulkBusy}
            >
              {t('Apply')}
            </button>
          </div>

          <div style={{ height: 18, width: 1, background: 'var(--border)' }} />

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleStartSync()}
            disabled={bulkBusy || syncBusy || !syncEligible}
            title={
              syncEligible
                ? t('Mirror actions from the first selected profile to the others')
                : t('Select at least 2 RUNNING profiles to sync')
            }
          >
            <UsersIcon size={12} />
            <span>{syncBusy ? t('Starting...') : t('Sync (profiles)')}</span>
          </button>

          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => void handleBulkDelete()}
            disabled={bulkBusy}
            title={t('Delete selected profiles')}
          >
            <TrashIcon size={12} />
            <span>{t('Delete')}</span>
          </button>

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSelectedIds(new Set())}
            disabled={bulkBusy}
            title={t('Deselect all')}
            style={{ color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>
      ) : null}

      {/* Action Syncer panel (Sprint 3) */}
      {syncSession ? (
        <SyncPanel
          session={syncSession}
          profiles={profiles}
          onChanged={() => void loadProfiles()}
          onClosed={() => setSyncSession(null)}
        />
      ) : null}

      {/* AdsPower-Style Tabbed Profile Modal (Create / Edit) */}
      {modalMode ? (
        <div className="modal-overlay" onClick={() => setModalMode(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modalMode === 'create' ? 'Create New Profile' : `Edit Profile (${name || profileId})`}</h3>
              <button className="btn-icon" onClick={() => setModalMode(null)}>✕</button>
            </div>

            <div className="modal-body">
              {/*
                Sectioned layout, three columns, following the reference. Every section is
                visible at once — the headings below label their own group, so a jump bar
                only added a second navigation surface for a form that already fits.
                The three existing tab bodies (general / proxy / fingerprint) are kept
                VERBATIM below — the redesign is presentational, and rewriting working
                controls would be a needless regression risk.
              */}
              <div className="profile-form-grid">
                {/* ---------------- Column 1: IDENTITY ---------------- */}
                <div className="profile-form-col">
                  <div className="pf-section" id="pf-section-identity">
                    <div className="pf-section-label">{t('IDENTITY')}</div>
                                      <div className="form-group">
                    <label>Profile Name</label>
                    <input
                      placeholder="e.g. MEXC-Account-01"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoFocus
                    />
                  </div>

                  <div className="form-group">
                    <label>Window Badge Color (optional)</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="color"
                        data-testid="profile-color-picker"
                        value={/^#[0-9a-fA-F]{6}$/.test(profileColor) ? profileColor : '#555555'}
                        onChange={(e) => setProfileColor(e.target.value)}
                        style={{ width: 42, height: 30, padding: 0, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6 }}
                      />
                      <input
                        placeholder="#RRGGBB (empty = no badge)"
                        data-testid="profile-color-input"
                        value={profileColor}
                        onChange={(e) => setProfileColor(e.target.value)}
                        style={{ flex: 1 }}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Group Assignment</label>
                    <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                      <option value="">No Group (Ungrouped)</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name} ({g.profile_count} profiles)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label>Device Preset</label>
                    <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                      <option value="">Default Preset (Windows 11 PC)</option>
                      {devices.map((d) => (
                        <option key={d.device_id} value={d.device_id}>
                          {d.name} ({d.platform.toUpperCase()})
                        </option>
                      ))}
                    </select>
                  </div>

                  {deviceId === 'dev_android' ? (
                    <div className="form-group">
                      <label>Phone Model (fixed)</label>
                      <select value={mobileModelId} onChange={(e) => setMobileModelId(e.target.value)}>
                        <option value="">Auto (from seed)</option>
                        {mobilePresets.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name} — Android {m.androidVersion} · {m.gpu}
                          </option>
                        ))}
                      </select>
                      <p className="hint">
                        Pick a specific phone to fix it for this profile (long-lived accounts). "Auto" derives the phone from the seed.
                      </p>
                    </div>
                  ) : null}
                  </div>

                  <div className="pf-section" id="pf-section-extras">
                    <div className="pf-section-label">{t('EXTENSIONS & COOKIES')}</div>
                    <p className="hint">
                      {t('Extensions are managed once for the whole library in the Extensions tab; cookies are loaded per profile when the browser is running.')}
                    </p>
                  </div>
                </div>

                {/* ---------------- Column 2: LOCALE + NOISE ---------------- */}
                <div className="profile-form-col">
                  <div className="pf-section" id="pf-section-locale">
                    <div className="pf-section-label">{t('LOCALE')}</div>
                    <div className="form-group">
                      <label>{t('Timezone')}</label>
                      <select value={profileTimezone} onChange={(e) => setProfileTimezone(e.target.value)}>
                        <option value="">{t('Auto (from proxy geo)')}</option>
                        {/*
                          The profile's own zone leads, then the common set.

                          Same defect as the language select beside it: the options are a short
                          list while a timezone can arrive from anywhere — the proxy's geo, an
                          import, another build — and a `<select>` whose value matches no option
                          renders its first option. That showed "Auto" for a profile that really
                          had a zone, and Save wrote the empty value back over it. Keeping the
                          profile's own value as an option means opening a profile can never
                          misrepresent or destroy what it holds.
                        */}
                        {Array.from(new Set([...(profileTimezone ? [profileTimezone] : []), ...COMMON_TIMEZONES])).map(
                          (zone) => (
                            <option key={zone} value={zone}>
                              {zone}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>{t('Browser language')}</label>
                      <select value={profileLang} onChange={(e) => setProfileLang(e.target.value)}>
                        <option value="">{t('Auto (from proxy geo)')}</option>
                        {/*
                          Every locale the fingerprint catalog can derive, plus the profile's own
                          value when it is not in that list.

                          The list used to hold seven entries while the catalog can produce
                          twenty-one. A `<select>` whose `value` matches no `<option>` renders the
                          FIRST option instead — the operator opened the modal on a profile whose
                          language was `es-MX`, saw "Auto", and pressing Save wrote that empty value
                          back over the real one. The browser then fell back to the machine's
                          locale, which is the reported "язык не меняется".

                          The extra entry covers a locale that arrived from an import, an older
                          build or a hand-edited database: without it, reading such a profile is
                          still destructive, so the stored value is always renderable.
                        */}
                        {Array.from(new Set([...browserLanguages, ...(profileLang ? [profileLang] : [])]))
                          .sort()
                          .map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>

                  <div className="pf-section" id="pf-section-noise">
                    <div className="pf-section-label">{t('NOISE')}</div>
                    {/*
                      Each surface has a real switch behind it: Real adds the kernel's own
                      `--disable-spoofing` token for that surface, Auto leaves engine-level
                      spoofing on. Tokens match the kernel exactly (Chrome 144+ replaced the
                      old --fingerprint-gpu-* flags with `gpu`), because a misspelled token is
                      accepted silently and would make this control do nothing.
                    */}
                    {NOISE_SURFACES.map(({ label, token }) => {
                      const isReal = noiseReal.includes(token);
                      return (
                        <div className="pf-derived-row pf-noise-row" key={token}>
                          <span>{t(label)}</span>
                          <div className="noise-toggle" role="group">
                            <button
                              type="button"
                              className={isReal ? '' : 'active'}
                              data-testid={`noise-auto-${token}`}
                              onClick={() => setNoiseReal(noiseReal.filter((x) => x !== token))}
                            >
                              {t('Auto')}
                            </button>
                            <button
                              type="button"
                              className={isReal ? 'active' : ''}
                              data-testid={`noise-real-${token}`}
                              onClick={() => setNoiseReal(isReal ? noiseReal : [...noiseReal, token])}
                            >
                              {t('Real')}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {/*
                      Sensors stay informational on purpose: `resolveSensorConfig` returns null
                      for anything that is not a MOBILE profile and the kernel exposes no token
                      for them, so a switch here could not do anything for the profile showing
                      it.
                    */}
                    <div className="pf-derived-row">
                      <span>{t('Sensors')}</span><code>{t('Mobile profiles only')}</code>
                    </div>

                    <div className="form-group" style={{ marginTop: 'var(--space-3)' }}>
                      <label>{t('Ports to block')}</label>
                      <div className="pf-chip-input">
                        {blockedPorts.map((port) => (
                          <span key={port} className="pf-chip">
                            {port}
                            <button
                              type="button"
                              aria-label={`${t('Remove')} ${port}`}
                              onClick={() => setBlockedPorts(blockedPorts.filter((p) => p !== port))}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <input
                          value={portInput}
                          inputMode="numeric"
                          placeholder={t('add port…')}
                          data-testid="blocked-port-input"
                          onChange={(e) => setPortInput(e.target.value.replace(/[^0-9]/g, ''))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ',') {
                              e.preventDefault();
                              const n = Number(portInput);
                              if (Number.isInteger(n) && n >= 1 && n <= 65535 && !blockedPorts.includes(n)) {
                                setBlockedPorts([...blockedPorts, n].sort((a, b) => a - b));
                              }
                              setPortInput('');
                            } else if (e.key === 'Backspace' && !portInput && blockedPorts.length > 0) {
                              setBlockedPorts(blockedPorts.slice(0, -1));
                            }
                          }}
                          onBlur={() => {
                            const n = Number(portInput);
                            if (Number.isInteger(n) && n >= 1 && n <= 65535 && !blockedPorts.includes(n)) {
                              setBlockedPorts([...blockedPorts, n].sort((a, b) => a - b));
                            }
                            setPortInput('');
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* ---------------- Column 3: PRIVACY + MEDIA ---------------- */}
                <div className="profile-form-col">
                  <div className="pf-section" id="pf-section-privacy">
                    <div className="pf-section-label">{t('PRIVACY')}</div>
                    <div className="form-group">
                      <label>{t('WebRTC')}</label>
                      <select
                        value={webrtcPolicy}
                        data-testid="webrtc-policy"
                        onChange={(e) => setWebrtcPolicy(e.target.value as 'default' | 'disable_non_proxied_udp' | 'proxy')}
                      >
                        <option value="default">{t('Auto (browser default)')}</option>
                        <option value="disable_non_proxied_udp">{t('Disable non-proxied UDP')}</option>
                        <option value="proxy">{t('Proxy only')}</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>{t('Display mode')}</label>
                      <label
                        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}
                      >
                        <input
                          type="checkbox"
                          data-testid="headless-mode"
                          checked={headlessMode}
                          onChange={(e) => setHeadlessMode(e.target.checked)}
                        />
                        {t('Headless — launch without a window')}
                      </label>
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'block', marginTop: 4 }}>
                        {t('For agent and automation profiles. A profile you drive by hand should stay headed.')}
                      </span>
                    </div>
                    <div className="form-group">
                      <label>{t('Do Not Track')}</label>
                      <select
                        value={doNotTrack}
                        data-testid="do-not-track"
                        onChange={(e) => setDoNotTrack(e.target.value as 'off' | 'on' | 'auto')}
                      >
                        <option value="auto">{t('Auto')}</option>
                        <option value="off">{t('Off')}</option>
                        <option value="on">{t('On')}</option>
                      </select>
                    </div>
                  </div>

                  <div className="pf-section" id="pf-section-media">
                    <div className="pf-section-label">{t('MEDIA DEVICES')}</div>
                    {/*
                      Device counts are synthesised by the stealth layer from the seed, the
                      same as the noise above — exposing numeric steppers here would imply a
                      per-profile override that does not exist.
                    */}
                    <div className="pf-derived-row"><span>{t('Mic in')}</span><code>{t('Auto (per-seed)')}</code></div>
                    <div className="pf-derived-row"><span>{t('Speakers')}</span><code>{t('Auto (per-seed)')}</code></div>
                    <div className="pf-derived-row"><span>{t('Webcam')}</span><code>{t('Auto (per-seed)')}</code></div>
                  </div>

                </div>
              </div>

              {/* Proxy configuration, kept whole. */}
              <div className="pf-section" id="pf-section-proxy">
                <div className="pf-section-label">{t('PROXY')}</div>
                                  <div className="form-group">
                    <label>Proxy Mode</label>
                    <div className="mode-selector">
                      <button
                        type="button"
                        className={`mode-btn ${proxyMode === 'none' ? 'active' : ''}`}
                        onClick={() => { setProxyMode('none'); setProxyTestResult(null); }}
                      >
                        Direct (No Proxy)
                      </button>
                      <button
                        type="button"
                        className={`mode-btn ${proxyMode === 'saved' ? 'active' : ''}`}
                        onClick={() => { setProxyMode('saved'); setProxyTestResult(null); }}
                      >
                        Saved Proxy
                      </button>
                      <button
                        type="button"
                        className={`mode-btn ${proxyMode === 'custom' ? 'active' : ''}`}
                        onClick={() => { setProxyMode('custom'); setProxyTestResult(null); }}
                      >
                        Custom Proxy
                      </button>
                    </div>
                  </div>

                  {proxyMode === 'saved' ? (
                    <div className="form-group">
                      <label>Choose Proxy from List</label>
                      <select value={savedProxyId} onChange={(e) => { setSavedProxyId(e.target.value); setProxyTestResult(null); }}>
                        <option value="">Select saved proxy...</option>
                        {proxies.map((p) => (
                          <option key={p.proxy_id} value={p.proxy_id}>
                            {p.type.toUpperCase()}://{p.host}:{p.port} {p.country ? `(${p.country})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {proxyMode === 'custom' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div className="form-group">
                        <label>Protocol</label>
                        <select value={customProxyType} onChange={(e) => setCustomProxyType(e.target.value as any)}>
                          <option value="socks5">SOCKS5</option>
                          <option value="http">HTTP</option>
                          <option value="https">HTTPS</option>
                          <option value="ssh">SSH Tunnel</option>
                        </select>
                      </div>
                      <div className="form-group" style={{ marginBottom: 4 }}>
                        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>Quick Proxy String / Быстрый ввод одной строкой</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ip:port:user:pass | user:pass@host:port</span>
                        </label>
                        <input
                          placeholder="Вставьте прокси (любой формат: ip:port:login:pass, user:pass@host:port, socks5://...)"
                          onChange={(e) => {
                            const parsed = parseProxyInput(e.target.value);
                            if (parsed) applyCustomProxy(parsed);
                          }}
                        />
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                        <div className="form-group">
                          <label>Host / IP</label>
                          <input
                            placeholder="ip:port:user:pass, user:pass@host:port, or proxy.example.com"
                            value={customProxyHost}
                            data-testid="custom-proxy-host"
                            onChange={(e) => {
                              const parsed = parseProxyInput(e.target.value);
                              if (!parsed) {
                                setCustomProxyHost(e.target.value);
                                return;
                              }
                              applyCustomProxy(parsed);
                            }}
                            onPaste={(e) => {
                              const text = e.clipboardData.getData('text');
                              const parsed = parseProxyInput(text);
                              if (parsed) {
                                e.preventDefault();
                                applyCustomProxy(parsed);
                              }
                            }}
                          />
                        </div>
                        <div className="form-group">
                          <label>Port</label>
                          <input
                            placeholder="1080"
                            value={customProxyPort}
                            onChange={(e) => setCustomProxyPort(e.target.value)}
                          />
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        <div className="form-group">
                          <label>Username (optional)</label>
                          <input
                            placeholder="Username"
                            value={customProxyUser}
                            onChange={(e) => setCustomProxyUser(e.target.value)}
                          />
                        </div>
                        <div className="form-group">
                          <label>Password (optional)</label>
                          <input
                            type="password"
                            placeholder="Password"
                            value={customProxyPass}
                            onChange={(e) => setCustomProxyPass(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {proxyMode !== 'none' ? (
                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void testProxyLive()}
                        disabled={proxyTesting}
                      >
                        <RefreshIcon size={14} />
                        <span>{proxyTesting ? 'Testing connection...' : '⚡ Test Proxy Connection'}</span>
                      </button>

                      {proxyTestResult ? (
                        <div className={`proxy-test-box ${proxyTestResult.ok ? 'success' : 'failed'}`}>
                          {proxyTestResult.ok ? (
                            <span>
                              ✓ Connection OK: IP <strong>{proxyTestResult.ip}</strong> ({proxyTestResult.country || 'Unknown'}, {proxyTestResult.timezone || 'UTC'}) • Latency: {proxyTestResult.latencyMs}ms
                            </span>
                          ) : (
                            <span>✕ Proxy check failed: {proxyTestResult.error || 'Connection refused'}</span>
                          )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
              </div>

              {/* Fingerprint preview + seed, kept whole. */}
              <div className="pf-section" id="pf-section-fingerprint">
                <div className="pf-section-label">{t('FINGERPRINT')}</div>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Hardware Fingerprint</label>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setSeed(Math.floor(Math.random() * 2000000000) + 100000000)}
                      title="Generate new random seed"
                    >
                      <DiceIcon size={14} />
                      <span>Randomize Seed</span>
                    </button>
                  </div>

                  <div className="form-group">
                    <label>Fingerprint Seed (manual)</label>
                    <input
                      type="number"
                      min="1"
                      max="2147483647"
                      placeholder="e.g. 123456789 — same seed = same phone & fingerprint"
                      value={seed || ''}
                      onChange={(e) => setSeed(Number(e.target.value) || 0)}
                    />
                    <p className="hint">
                      Fix the seed to keep the same device &amp; fingerprint across restarts (recommended for long-lived accounts).
                    </p>
                  </div>

                  <div className="fingerprint-grid">
                    <div className="fp-item">
                      <span className="fp-item-label">Fingerprint Seed</span>
                      <span className="fp-item-val">{seed || 'Auto-generated'}</span>
                    </div>
                    <div className="fp-item">
                      <span className="fp-item-label">Navigator WebDriver</span>
                      <span className="fp-item-val" style={{ color: 'var(--ok)' }}>false (Stealth forced)</span>
                    </div>
                    <div className="fp-item">
                      <span className="fp-item-label">{t('Noise status')}</span>
                      {/*
                        Reports the NOISE choice above instead of a fixed "Active" badge. A badge
                        that always claimed noise was on would contradict the operator the moment
                        they switched a surface to Real — the summary would be telling them the
                        opposite of what the launch is about to do.
                      */}
                      {(() => {
                        const off = NOISE_SURFACES.filter((x) => noiseReal.includes(x.token));
                        if (off.length === 0) {
                          return <span className="fp-item-val" style={{ color: 'var(--ok)' }}>{t('Active (per-seed)')}</span>;
                        }
                        const which = off.map((x) => x.label).join(', ');
                        return (
                          <span className="fp-item-val" style={{ color: 'var(--text-secondary)' }}>
                            {`${t('Real')}: ${which}`}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="fp-item">
                      <span className="fp-item-label">CPU Cores</span>
                      <span className="fp-item-val">{cores} Logical Cores</span>
                    </div>
                    <div className="fp-item">
                      <span className="fp-item-label">GPU (WebGL)</span>
                      <span className="fp-item-val">Intel / NVIDIA (Direct3D11)</span>
                    </div>
                    <div className="fp-item">
                      <span className="fp-item-label">WebRTC Protection</span>
                      <span className="fp-item-val" style={{ color: 'var(--ok)' }}>Disabled (Zero IP Leaks)</span>
                    </div>
                  </div>

                  <div className="form-group" style={{ marginTop: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <label>{t('Custom User-Agent Override')}</label>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setUserAgent(generateRandomUa())}
                        title={t('Generate a realistic random Chrome UA (matches the kernel version)')}
                      >
                        <DiceIcon size={12} />
                        <span>{t('Randomize UA')}</span>
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={userAgent}
                      onChange={(e) => setUserAgent(e.target.value)}
                      placeholder={t('Empty = kernel default UA (recommended)')}
                      style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}
                    />
                  </div>
                </div>
              </div>


            <div className="modal-footer">
              <button className="btn" onClick={() => setModalMode(null)}>Cancel</button>
              <button className="btn primary" onClick={() => void saveProfileModal()} disabled={busy}>
                {modalMode === 'create' ? 'Create Profile' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Manage Groups Modal */}
      {showGroupModal ? (
        <div className="modal-overlay" onClick={() => setShowGroupModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Profile Groups</h3>
              <button className="btn-icon" onClick={() => setShowGroupModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ flex: 1 }}
                  placeholder="New group name (e.g. TikTok Farm, MEXC Traders)..."
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
                <button className="btn primary" onClick={() => void handleCreateGroup()} disabled={busy || !newGroupName.trim()}>
                  + Add Group
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {groups.map((g) => (
                  <div
                    key={g.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: 'var(--panel-2)',
                      padding: '10px 14px',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {editingGroup?.id === g.id ? (
                      <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                        <input
                          style={{ flex: 1 }}
                          value={editingGroup.name}
                          onChange={(e) => setEditingGroup({ ...editingGroup, name: e.target.value })}
                        />
                        <button className="btn primary" onClick={() => void handleUpdateGroup()} disabled={busy}>
                          Save
                        </button>
                        <button className="btn" onClick={() => setEditingGroup(null)}>Cancel</button>
                      </div>
                    ) : (
                      <>
                        <span style={{ fontSize: 13.5 }}>
                          <strong>{g.name}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>({g.profile_count} profiles)</span>
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn" onClick={() => setEditingGroup({ id: g.id, name: g.name })}>
                            Rename
                          </button>
                          <button className="btn danger" onClick={() => void handleDeleteGroup(g.id)} disabled={busy}>
                            <TrashIcon size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {groups.length === 0 ? <p className="hint">No custom groups created yet.</p> : null}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowGroupModal(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Tag Management Modal (Sprint 2.3) */}
      {showTagModal ? (
        <div className="modal-overlay" onClick={() => setShowTagModal(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h3>{t('Manage Tags')}</h3>
              <button className="btn-icon" onClick={() => setShowTagModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>{tagForm.id ? t('Edit tag') : t('Create tag')}</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    style={{ flex: 1 }}
                    placeholder={t('Tag name')}
                    value={tagForm.name}
                    onChange={(e) => setTagForm({ ...tagForm, name: e.target.value })}
                  />
                  <input
                    type="color"
                    value={tagForm.color}
                    onChange={(e) => setTagForm({ ...tagForm, color: e.target.value })}
                    style={{ width: 42, height: 34, padding: 2, cursor: 'pointer' }}
                  />
                  <button className="btn primary" onClick={() => void saveTag()} disabled={busy || !tagForm.name.trim()}>
                    {tagForm.id ? t('Save') : t('Create')}
                  </button>
                  {tagForm.id ? (
                    <button className="btn" onClick={() => setTagForm({ id: null, name: '', color: '#71717a' })}>
                      {t('Cancel')}
                    </button>
                  ) : null}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                {tags.map((tg) => (
                  <div
                    key={tg.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '7px 10px',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                    }}
                  >
                    <span style={{ width: 12, height: 12, borderRadius: 3, background: tg.color || 'var(--border)', display: 'inline-block' }} />
                    <span style={{ fontSize: 13, flex: 1 }}>
                      {tg.name} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({tg.profile_count})</span>
                    </span>
                    <button
                      className="btn btn-sm"
                      onClick={() => setTagForm({ id: tg.id, name: tg.name, color: tg.color || '#71717a' })}
                      disabled={busy}
                    >
                      {t('Edit')}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => void deleteTagById(tg.id)} disabled={busy}>
                      <TrashIcon size={11} />
                    </button>
                  </div>
                ))}
                {tags.length === 0 ? <p className="hint">{t('No tags yet — create one above.')}</p> : null}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowTagModal(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Batch Create Modal */}
      {showBatch ? (
        <div className="modal-overlay" onClick={() => setShowBatch(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Batch Create Profiles</h3>
              <button className="btn-icon" onClick={() => setShowBatch(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Number of profiles to generate</label>
                <input
                  type="number"
                  min="1"
                  max="500"
                  value={batchCount}
                  onChange={(e) => setBatchCount(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Name Prefix</label>
                <input
                  placeholder="e.g. farm-acc"
                  value={batchPrefix}
                  onChange={(e) => setBatchPrefix(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Assign to Group</label>
                <select value={batchGroup} onChange={(e) => setBatchGroup(e.target.value)}>
                  <option value="">No Group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setShowBatch(false)}>Cancel</button>
              <button className="btn primary" onClick={() => void createBatch()} disabled={busy}>
                Generate Profiles
              </button>
            </div>
          </div>
        </div>
      ) : null}


      {/* Manage Drawer / Modal for Cookies, Fingerprint Overrides, Extensions */}
      {manage ? (
        <div className="modal-overlay" onClick={() => setManage(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {manage.tab === 'cookies' && 'Manage Cookies'}
                {manage.tab === 'fingerprint' && 'Fingerprint Overrides'}
                {manage.tab === 'extensions' && 'Bound Extensions'}
              </h3>
              <button className="btn-icon" onClick={() => setManage(null)}>✕</button>
            </div>

            <div className="modal-body">
              {manage.tab === 'cookies' ? (
                <>
                  <p className="hint" style={{ margin: 0 }}>
                    Paste an array of JSON cookies exported from EditThisCookie or another browser.
                  </p>
                  <textarea
                    placeholder='[{"name":"session","value":"xyz","domain":".example.com","path":"/"}]'
                    value={cookiesText}
                    onChange={(e) => setCookiesText(e.target.value)}
                    rows={8}
                    style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                  />
                </>
              ) : manage.tab === 'fingerprint' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p className="hint" style={{ margin: 0 }}>
                    {t('Per-profile fingerprint overrides (like AdsPower). Leave empty for defaults.')}
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('Platform')}</label>
                      <select
                        value={fpForm.platform}
                        onChange={(e) => setFpForm({ ...fpForm, platform: e.target.value })}
                      >
                        <option value="">{t('Default (Windows)')}</option>
                        <option value="windows">Windows</option>
                        <option value="macos">macOS</option>
                        <option value="linux">Linux</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('Browser Brand')}</label>
                      <select
                        value={fpForm.brand}
                        onChange={(e) => setFpForm({ ...fpForm, brand: e.target.value })}
                      >
                        <option value="">{t('Default (Chrome)')}</option>
                        <option value="Chrome">Chrome</option>
                        <option value="Edge">Edge</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('CPU Cores')}</label>
                      <input
                        type="number"
                        min={1}
                        max={32}
                        placeholder={t('e.g. 8')}
                        value={fpForm.hardwareConcurrency ?? ''}
                        onChange={(e) =>
                          setFpForm({ ...fpForm, hardwareConcurrency: e.target.value ? Number(e.target.value) : undefined })
                        }
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('RAM (GB) — navigator.deviceMemory')}</label>
                      <select
                        value={fpForm.deviceMemory ?? ''}
                        onChange={(e) =>
                          setFpForm({ ...fpForm, deviceMemory: e.target.value ? Number(e.target.value) : undefined })
                        }
                      >
                        <option value="">{t('Default (8 GB)')}</option>
                        <option value={2}>2 GB</option>
                        <option value={4}>4 GB</option>
                        <option value={8}>8 GB</option>
                        <option value={16}>16 GB</option>
                        <option value={32}>32 GB</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('Language (Accept-Language)')}</label>
                      <input
                        placeholder="en-US"
                        value={fpForm.lang ?? ''}
                        onChange={(e) => setFpForm({ ...fpForm, lang: e.target.value || undefined })}
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('Brand Version')}</label>
                      <input
                        placeholder="148.0.0.0"
                        value={fpForm.brandVersion ?? ''}
                        onChange={(e) => setFpForm({ ...fpForm, brandVersion: e.target.value || undefined })}
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('Screen Width')}</label>
                      <input
                        type="number"
                        min={320}
                        max={7680}
                        placeholder={t('native')}
                        value={fpForm.screenWidth ?? ''}
                        onChange={(e) =>
                          setFpForm({ ...fpForm, screenWidth: e.target.value ? Number(e.target.value) : undefined })
                        }
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{t('Screen Height')}</label>
                      <input
                        type="number"
                        min={240}
                        max={4320}
                        placeholder={t('native')}
                        value={fpForm.screenHeight ?? ''}
                        onChange={(e) =>
                          setFpForm({ ...fpForm, screenHeight: e.target.value ? Number(e.target.value) : undefined })
                        }
                      />
                    </div>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>{t('Disable Spoofing (advanced — pass-through to real values)')}</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13, color: 'var(--text-secondary)' }}>
                      {(['canvas', 'webgl', 'audio', 'clientrects'] as const).map((k) => (
                        <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', textTransform: 'capitalize' }}>
                          <input
                            type="checkbox"
                            checked={fpForm.disableSpoofing?.includes(k) ?? false}
                            onChange={(e) => {
                              const cur = new Set(fpForm.disableSpoofing ?? []);
                              if (e.target.checked) cur.add(k);
                              else cur.delete(k);
                              setFpForm({ ...fpForm, disableSpoofing: cur.size ? Array.from(cur) : undefined });
                            }}
                          />
                          {k}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {extensions.map((e) => (
                    <label key={e.extension_id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13.5 }}>
                      <input
                        type="checkbox"
                        checked={extSel.includes(e.extension_id)}
                        onChange={(evt) =>
                          setExtSel((prev) =>
                            evt.target.checked
                              ? [...prev, e.extension_id]
                              : prev.filter((x) => x !== e.extension_id)
                          )
                        }
                      />
                      <span>{e.name}</span>
                    </label>
                  ))}
                  {extensions.length === 0 ? <p className="hint">No extensions available. Go to Extensions to import .crx or unpacked folders.</p> : null}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn" onClick={() => setManage(null)}>Cancel</button>
              {manage.tab === 'cookies' && (
                <button className="btn primary" onClick={() => void saveCookies()} disabled={busy}>
                  Save Cookies
                </button>
              )}
              {manage.tab === 'fingerprint' && (
                <button className="btn primary" onClick={() => void saveFingerprint()} disabled={busy}>
                  Apply Overrides
                </button>
              )}
              {manage.tab === 'extensions' && (
                <button className="btn primary" onClick={() => void saveExtensions()} disabled={busy}>
                  Save Extensions
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {preflightModal.isOpen ? (
        <PreflightModal
          isOpen={preflightModal.isOpen}
          onClose={() => setPreflightModal((prev) => ({ ...prev, isOpen: false, isBlockedLaunch: false }))}
          profileId={preflightModal.profileId}
          profileName={preflightModal.profileName}
          verdict={preflightModal.verdict}
          loading={preflightModal.loading}
          error={preflightModal.error}
          isBlockedLaunch={preflightModal.isBlockedLaunch}
          onRecheck={async (id: string) => {
            await runPreflight(id, preflightModal.profileName, true);
            void loadProfiles();
          }}
          onStartProfile={async (id: string) => {
            await start(id, preflightModal.profileName, true);
          }}
          onStartWithoutProxy={async (id: string) => {
            await start(id, preflightModal.profileName, true);
          }}
        />
      ) : null}
      {cookieFarmModal.isOpen ? (
        <Modal
          title={`${t('Profile Warm-up (Cookie Farm)')}: ${cookieFarmModal.profileName || cookieFarmModal.profileId}`}
          icon={<CookieIcon size={18} />}
          // Close is always enabled: dismissing the modal does not abort the background run.
          // Stop sends the abort signal to cancel the crawl.
          onClose={() => {
            setCookieFarmModal((prev) => ({ ...prev, isOpen: false }));
          }}
          width={640}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              {cookieFarmModal.loading ? (
                <button
                  type="button"
                  className="btn danger"
                  disabled={cookieFarmModal.stopping}
                  onClick={() => void handleStopCookieFarm()}
                >
                  {cookieFarmModal.stopping ? t('Stopping...') : t('Stop')}
                </button>
              ) : null}
              <button
                type="button"
                className="btn"
                onClick={() => setCookieFarmModal((prev) => ({ ...prev, isOpen: false }))}
              >
                {t('Close')}
              </button>
            </div>
          }
        >
          {cookieFarmModal.error ? (
            <div className="error-banner" style={{ marginBottom: 12 }}>
              {cookieFarmModal.error}
            </div>
          ) : null}

          {/*
            Where this run's traffic exited. Read from the REPORT, not from the profile: a report
            records a past run, and re-checking or replacing the proxy afterwards must not
            re-label it. Absent when the profile has no proxy or its country is unresolved — shown
            as nothing rather than guessed, because a wrong flag is worse than no flag.

            Rendered through `geoLabel`, the same helper the proxies table and the profiles PROXY
            column use, so the flag and the two-letter code are derived one way everywhere rather
            than by a third implementation that could drift from them.
          */}
          {cookieFarmModal.report?.exitGeo ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('Exit location')}</span>
              <span style={{ fontSize: 13, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {/* Same icon as the table cells, so a run's exit reads identically wherever it
                    appears. `geoLabel` still supplies the code and place; the flag is drawn. */}
                <CountryFlag code={cookieFarmModal.report.exitGeo.code} height={12} />
                {geoLabel({
                  code: cookieFarmModal.report.exitGeo.code,
                  country: cookieFarmModal.report.exitGeo.country,
                })}
              </span>
            </div>
          ) : null}

          {cookieFarmModal.loading && !cookieFarmModal.report ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="preflight-loading-box" style={{ margin: 0, padding: '12px 16px' }}>
                <div className="preflight-spinner" />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <p style={{ margin: 0, fontWeight: 500 }}>
                    {t('Warming up profile (visiting sites, collecting cookies, accepting consent)...')}
                  </p>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {t('Crawl running in background')}
                  </span>
                </div>
              </div>

              <div className="metrics-row" style={{ marginBottom: 0 }}>
                <div className="metric-card">
                  <div className="metric-label">{t('Pages Visited')}</div>
                  <div className="metric-value">
                    {cookieFarmModal.progress
                      ? `${cookieFarmModal.progress.pagesVisited ?? 0} / ${cookieFarmModal.progress.maxPages ?? '…'}`
                      : '0 / …'}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{t('Cookies Set')}</div>
                  <div className="metric-value ok">
                    {cookieFarmModal.progress?.cookiesSet ?? 0}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{t('Domains Touched')}</div>
                  <div className="metric-value">
                    {cookieFarmModal.progress?.domainsTouched?.length ?? 0}
                  </div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{t('Consents Accepted')}</div>
                  <div className="metric-value">
                    {cookieFarmModal.progress?.consentsAccepted ?? 0}
                  </div>
                </div>
              </div>

              <div className="pf-section">
                <div className="pf-section-label">{t('Current Site')}</div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    background: 'var(--panel)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: 'var(--radius-full)',
                      background: 'var(--accent)',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {cookieFarmModal.progress?.currentDomain || t('Warming up profile (visiting sites, collecting cookies, accepting consent)...')}
                  </span>
                </div>
              </div>

              {cookieFarmModal.progress?.domainsTouched &&
              cookieFarmModal.progress.domainsTouched.length > 0 ? (
                <div className="pf-section">
                  <div className="pf-section-label">{t('Domains Touched')}</div>
                  <div className="pf-chip-input" style={{ maxHeight: 100, overflowY: 'auto' }}>
                    {cookieFarmModal.progress.domainsTouched.map((domain, idx) => (
                      <span key={idx} className="pf-chip" style={{ fontSize: 11, padding: '2px 6px' }}>
                        {domain}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {cookieFarmModal.report ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="metrics-row" style={{ marginBottom: 0 }}>
                <div className="metric-card">
                  <div className="metric-label">{t('Pages Visited')}</div>
                  <div className="metric-value">{cookieFarmModal.report.pagesVisited}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{t('Cookies Set')}</div>
                  <div className="metric-value ok">{cookieFarmModal.report.cookiesSet}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{t('Domains Touched')}</div>
                  <div className="metric-value">{cookieFarmModal.report.domainsTouched.length}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">{t('Duration')}</div>
                  <div className="metric-value">
                    {(cookieFarmModal.report.durationMs / 1000).toFixed(1)}s
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>{t('Status')}:</span>
                <span
                  className={`preflight-tag ${
                    cookieFarmModal.report.status === 'completed'
                      ? 'pass'
                      : cookieFarmModal.report.status === 'aborted'
                      ? 'warn'
                      : 'fail'
                  }`}
                  style={{ padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}
                >
                  {cookieFarmModal.report.status.toUpperCase()}
                </span>
                {cookieFarmModal.report.managedProfile ? (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    ({t('Auto-managed profile')})
                  </span>
                ) : null}
              </div>

              {cookieFarmModal.report.errors && cookieFarmModal.report.errors.length > 0 ? (
                <div className="pf-section">
                  <div className="pf-section-label" style={{ color: 'var(--danger)' }}>
                    {t('Errors')} ({cookieFarmModal.report.errors.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {cookieFarmModal.report.errors.map((err, idx) => (
                      <div
                        key={idx}
                        className="error-banner"
                        style={{ fontSize: 12, padding: '6px 10px', margin: 0 }}
                      >
                        {err}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {cookieFarmModal.report.consents && cookieFarmModal.report.consents.length > 0 ? (
                <div className="pf-section">
                  <div className="pf-section-label">{t('Cookie Consents')}</div>
                  <div
                    style={{
                      maxHeight: 180,
                      overflowY: 'auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      background: 'var(--panel)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '8px 12px',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {cookieFarmModal.report.consents.map((c, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          fontSize: 12,
                          padding: '4px 0',
                          borderBottom:
                            idx < (cookieFarmModal.report!.consents!.length - 1)
                              ? '1px solid var(--border)'
                              : 'none',
                        }}
                      >
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{c.domain}</span>
                        <span
                          className={`preflight-tag ${c.clicked ? 'pass' : 'warn'}`}
                          style={{ fontSize: 10, padding: '1px 6px' }}
                        >
                          {c.clicked
                            ? `${t('Accepted')}${c.label ? `: ${c.label}` : ''}`
                            : t('No consent banner')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {cookieFarmModal.report.domainsTouched &&
              cookieFarmModal.report.domainsTouched.length > 0 ? (
                <div className="pf-section">
                  <div className="pf-section-label">{t('Domains Touched')}</div>
                  <div className="pf-chip-input" style={{ maxHeight: 120, overflowY: 'auto' }}>
                    {cookieFarmModal.report.domainsTouched.map((domain, idx) => (
                      <span key={idx} className="pf-chip" style={{ fontSize: 11, padding: '2px 6px' }}>
                        {domain}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </Modal>
      ) : null}


      {noteModalProfile ? (
        <Modal
          title={noteModalProfile.name || t('Unnamed Profile')}
          icon={<NoteIcon size={18} />}
          onClose={closeNoteModal}
          width={640}
          footer={
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
              <button type="button" className="btn" onClick={closeNoteModal} disabled={noteBusy}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn primary" onClick={() => void saveNoteModal()} disabled={noteBusy}>
                {t('Save')}
              </button>
            </div>
          }
        >
          {noteError ? <div className="error-banner" style={{ marginBottom: 12 }}>{noteError}</div> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="pf-section">
              <div className="pf-section-label">{t('NOTE')}</div>
              <textarea
                rows={4}
                placeholder={t('Free-form notes…')}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                disabled={noteBusy}
                style={{ width: '100%', resize: 'vertical' }}
              />
            </div>
            <ProfileVault profileId={noteModalProfile.user_id} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
