import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as pm from '../../profiles/profileManager';
import * as launcher from '../../launcher/chromium';
import * as firefox from '../../launcher/firefox';
import { checkProxy } from '../../proxy/proxyManager';
import { MOBILE_PRESETS as mobilePresets } from '../../devices/mobilePresets';
import {
  EXTENDED_FINGERPRINT_CATALOG,
  WINDOWS_FINGERPRINT_CATALOG,
} from '../../fingerprints/catalog';
import { SERVER_MODE } from '../../config';
import * as androidRuntime from '../../android/instance';
import type { StartResult } from '../../launcher/chromium';

const router = Router();

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Server mode + non-loopback Host: hand out the tunnel endpoint
 * (`ws://<host>/cdp/<id><ws-path>`) instead of the loopback one.
 */
function rewriteForRemote(req: Request, profileId: string, result: StartResult): StartResult {
  const host = req.headers.host;
  if (!SERVER_MODE || !host || LOOPBACK_HOST_RE.test(host)) return result;
  const ep = launcher.getCdpEndpoint(profileId);
  if (!ep) return result;
  return {
    ...result,
    ws: {
      puppeteer: `ws://${host}/cdp/${profileId}${ep.wsPath}`,
      selenium: result.ws.selenium,
    },
  };
}

/** Narrows an unknown thrown value to its string `code`, when it carries one. */
function errorCodeOf(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

async function handleStart(req: Request, id: string, res: Response): Promise<void> {
  if (!id) {
    res.json({ code: -1, msg: 'user_id is required', data: {} });
    return;
  }
  const profile = pm.getProfile(id);
  if (!profile) {
    res.json({ code: -1, msg: 'profile not found', data: {} });
    return;
  }
  try {
    // An Android profile is launched by the Android runtime, not by a browser binary. The
    // selector is explicit so a desktop profile can never fall into this branch — and so an
    // Android profile stops silently resolving to chromium, which is what
    // `resolveLaunchConfig` reports for any type other than firefox.
    if (profile.browser_type === 'android') {
      try {
        const status = await androidRuntime.launchAndroidProfile(id);
        pm.setStatus(id, 'running');
        res.json({ code: 0, msg: 'success', data: { browser_type: 'android', ...status } });
      } catch (err) {
        const code = errorCodeOf(err);
        pm.setStatus(id, 'closed');
        if (code === 'NOT_READY') {
          res.status(409).json({
            code: 'NOT_READY',
            msg: (err as Error).message || 'Android engine is not installed',
            data: { code: 'NOT_READY' },
          });
          return;
        }
        res.json({ code: -1, msg: (err as Error).message, data: code ? { code } : {} });
      }
      return;
    }

    const cfg = pm.resolveLaunchConfig(id);
    // A per-launch headless override. The stored value on the profile is the default; an
    // agent that wants the same profile headed or hidden for one run passes it here rather
    // than rewriting the profile. Accepted as a boolean or the strings a query parameter
    // carries ("1"/"true"), because GET /api/v1/browser/start is the documented AdsPower
    // shape and query strings have no booleans.
    const requested = req.body?.headless ?? req.query.headless;
    if (requested !== undefined) {
      cfg.headless = requested === true || requested === '1' || requested === 'true';
    }
    const bypassProbe =
      req.body?.bypass_proxy_probe === true ||
      req.body?.bypass_proxy_probe === '1' ||
      req.query.bypass_proxy_probe === '1' ||
      req.query.bypass_proxy_probe === 'true';
    if (bypassProbe) {
      cfg.bypassProxyProbe = true;
    }
    if (cfg.browserType === 'firefox') {
      const result = await firefox.startFirefox(cfg);
      if (result.ok) {
        pm.setStatus(id, 'running');
        res.json({
          code: 0,
          msg: 'success',
          data: {
            browser_type: 'firefox',
            url: result.url,
            title: result.title,
          },
        });
      } else {
        res.json({ code: -1, msg: result.error ?? 'firefox start failed', data: {} });
      }
    } else {
      const startResult = await launcher.startProfile(cfg);
      pm.setStatus(id, 'running');
      res.json({ code: 0, msg: 'success', data: rewriteForRemote(req, id, startResult) });
    }
  } catch (err) {
    pm.setStatus(id, 'closed');
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
}

// GET /api/v1/browser/start?user_id=<id>
router.get('/api/v1/browser/start', async (req, res) => {
  const id = String(req.query.user_id || '');
  await handleStart(req, id, res);
});

// POST /api/v1/browser/start { user_id }
router.post('/api/v1/browser/start', async (req, res) => {
  const id = String(req.body?.user_id || req.query.user_id || '');
  await handleStart(req, id, res);
});

// POST /api/v2/browser-profile/start (AdsPower V2 alias)
router.post('/api/v2/browser-profile/start', async (req, res) => {
  const id = String(req.body?.user_id || req.query.user_id || '');
  await handleStart(req, id, res);
});

// GET /api/v1/browser/stop?user_id=<id>
router.get('/api/v1/browser/stop', async (req, res) => {
  const id = String(req.query.user_id || '');
  const profile = id ? pm.getProfile(id) : undefined;
  if (profile?.browser_type === 'android') {
    // Android profiles are stopped by the Android runtime; `launcher.stopProfile` knows nothing
    // about an emulator process and would report success while leaving it running.
    await androidRuntime.stopAndroidProfile(id).catch(() => false);
    pm.setStatus(id, 'closed');
    res.json({ code: 0, msg: 'success', data: {} });
    return;
  }
  if (profile?.browser_type === 'firefox') {
    const result = await firefox.stopFirefox(id);
    if (!result.ok) {
      res.json({ code: -1, msg: result.error ?? 'stop failed', data: {} });
      return;
    }
  } else {
    await launcher.stopProfile(id);
  }
  if (id) pm.setStatus(id, 'closed');
  res.json({ code: 0, msg: 'success', data: {} });
});

// POST /api/v1/browser/stop { user_id }
router.post('/api/v1/browser/stop', async (req, res) => {
  const id = String(req.body?.user_id || req.query.user_id || '');
  const profile = id ? pm.getProfile(id) : undefined;
  if (profile?.browser_type === 'android') {
    // Android profiles are stopped by the Android runtime; `launcher.stopProfile` knows nothing
    // about an emulator process and would report success while leaving it running.
    await androidRuntime.stopAndroidProfile(id).catch(() => false);
    pm.setStatus(id, 'closed');
    res.json({ code: 0, msg: 'success', data: {} });
    return;
  }
  if (profile?.browser_type === 'firefox') {
    const result = await firefox.stopFirefox(id);
    if (!result.ok) {
      res.json({ code: -1, msg: result.error ?? 'stop failed', data: {} });
      return;
    }
  } else {
    await launcher.stopProfile(id);
  }
  if (id) pm.setStatus(id, 'closed');
  res.json({ code: 0, msg: 'success', data: {} });
});

// POST /api/v2/browser-profile/stop (AdsPower V2 alias)
router.post('/api/v2/browser-profile/stop', async (req, res) => {
  const id = String(req.body?.user_id || req.query.user_id || '');
  const profile = id ? pm.getProfile(id) : undefined;
  if (profile?.browser_type === 'android') {
    // Android profiles are stopped by the Android runtime; `launcher.stopProfile` knows nothing
    // about an emulator process and would report success while leaving it running.
    await androidRuntime.stopAndroidProfile(id).catch(() => false);
    pm.setStatus(id, 'closed');
    res.json({ code: 0, msg: 'success', data: {} });
    return;
  }
  if (profile?.browser_type === 'firefox') {
    const result = await firefox.stopFirefox(id);
    if (!result.ok) {
      res.json({ code: -1, msg: result.error ?? 'stop failed', data: {} });
      return;
    }
  } else {
    await launcher.stopProfile(id);
  }
  if (id) pm.setStatus(id, 'closed');
  res.json({ code: 0, msg: 'success', data: {} });
});

router.get('/api/v1/browser/list', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.page_size) || 100));
  const groupId = typeof req.query.group_id === 'string' ? req.query.group_id : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const tagId = typeof req.query.tag_id === 'string' ? req.query.tag_id : undefined;
  const { list, total } = pm.listProfiles(page, pageSize, groupId, search, platform, status, tagId);
  res.json({ code: 0, msg: 'success', data: { list, page, page_size: pageSize, total } });
});

// Alias compatible with AdsPower V2 list
router.post('/api/v2/browser-profile/list', (req, res) => {
  const page = Math.max(1, Number(req.body?.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.body?.page_size) || 100));
  const groupId = typeof req.body?.group_id === 'string' ? req.body.group_id : undefined;
  const search = typeof req.body?.search === 'string' ? req.body.search : undefined;
  const platform = typeof req.body?.platform === 'string' ? req.body.platform : undefined;
  const status = typeof req.body?.status === 'string' ? req.body.status : undefined;
  const { list, total } = pm.listProfiles(page, pageSize, groupId, search, platform, status);
  res.json({ code: 0, msg: 'success', data: { list, page, page_size: pageSize, total } });
});

// ---------------------------------------------------------------------------
// Server-side bulk operations (v0.2.18): one request per action, with a
// per-item success/failure report instead of client-side request loops.
// ---------------------------------------------------------------------------

const bulkIdsSchema = z.object({
  user_ids: z.array(z.string()).min(1).max(500),
});

router.post('/api/v1/browser-profile/bulk-start', async (req, res) => {
  const parsed = bulkIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const succeeded: Array<{ user_id: string; ws?: unknown; debug_port?: string }> = [];
  const failed: Array<{ user_id: string; error: string }> = [];
  for (const id of parsed.data.user_ids) {
    try {
      const profile = pm.getProfile(id);
      if (!profile) {
        failed.push({ user_id: id, error: 'profile not found' });
        continue;
      }
      if (profile.browser_type === 'android') {
        const status = await androidRuntime.launchAndroidProfile(id);
        pm.setStatus(id, 'running');
        succeeded.push({ user_id: id, ws: status.stream });
        continue;
      }
      const cfg = pm.resolveLaunchConfig(id);
      if (cfg.browserType === 'firefox') {
        const result = await firefox.startFirefox(cfg);
        if (result.ok) {
          pm.setStatus(id, 'running');
          succeeded.push({ user_id: id });
        } else {
          failed.push({ user_id: id, error: result.error ?? 'firefox start failed' });
        }
      } else {
        const startResult = await launcher.startProfile(cfg);
        pm.setStatus(id, 'running');
        succeeded.push({ user_id: id, ws: startResult.ws, debug_port: startResult.debug_port });
      }
    } catch (err) {
      try { pm.setStatus(id, 'closed'); } catch { /* ignore */ }
      failed.push({ user_id: id, error: (err as Error).message });
    }
  }
  res.json({
    code: 0,
    msg: 'success',
    data: { succeeded, failed, total: parsed.data.user_ids.length },
  });
});

router.post('/api/v1/browser-profile/bulk-stop', async (req, res) => {
  const parsed = bulkIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const succeeded: string[] = [];
  const failed: Array<{ user_id: string; error: string }> = [];
  for (const id of parsed.data.user_ids) {
    try {
      const profile = pm.getProfile(id);
      if (profile?.browser_type === 'android') {
        await androidRuntime.stopAndroidProfile(id);
        pm.setStatus(id, 'closed');
        succeeded.push(id);
        continue;
      }
      if (profile?.browser_type === 'firefox') {
        const result = await firefox.stopFirefox(id);
        if (!result.ok) {
          failed.push({ user_id: id, error: result.error ?? 'stop failed' });
          continue;
        }
      } else {
        await launcher.stopProfile(id);
      }
      pm.setStatus(id, 'closed');
      succeeded.push(id);
    } catch (err) {
      failed.push({ user_id: id, error: (err as Error).message });
    }
  }
  res.json({ code: 0, msg: 'success', data: { succeeded, failed, total: parsed.data.user_ids.length } });
});

router.post('/api/v1/browser-profile/bulk-delete', async (req, res) => {
  const parsed = bulkIdsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const succeeded: string[] = [];
  const failed: Array<{ user_id: string; error: string }> = [];
  for (const id of parsed.data.user_ids) {
    try {
      // pm.deleteProfile also cleans up fingerprints, bound extensions and files.
      if (pm.deleteProfile(id)) succeeded.push(id);
      else failed.push({ user_id: id, error: 'profile not found' });
    } catch (err) {
      failed.push({ user_id: id, error: (err as Error).message });
    }
  }
  res.json({ code: 0, msg: 'success', data: { succeeded, failed, total: parsed.data.user_ids.length } });
});

const bulkGroupSchema = z.object({
  user_ids: z.array(z.string()).min(1).max(500),
  group_id: z.string().nullable(),
});

router.post('/api/v1/browser-profile/bulk-group', (req, res) => {
  const parsed = bulkGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const succeeded: string[] = [];
  const failed: Array<{ user_id: string; error: string }> = [];
  for (const id of parsed.data.user_ids) {
    try {
      const ok = pm.updateProfile(id, { group_id: parsed.data.group_id });
      if (ok) succeeded.push(id);
      else failed.push({ user_id: id, error: 'profile not found' });
    } catch (err) {
      failed.push({ user_id: id, error: (err as Error).message });
    }
  }
  res.json({ code: 0, msg: 'success', data: { succeeded, failed, total: parsed.data.user_ids.length } });
});

// ---------------------------------------------------------------------------
// Profile bundles (v0.2.19): portable export/import of a full profile.
// ---------------------------------------------------------------------------

// GET /api/v1/browser-profile/export?user_id=<id>
router.get('/api/v1/browser-profile/export', (req, res) => {
  const id = String(req.query.user_id || '');
  const bundle = pm.exportProfileBundle(id);
  if (!bundle) {
    res.json({ code: -1, msg: 'profile not found', data: {} });
    return;
  }
  res.json({ code: 0, msg: 'success', data: { bundle } });
});

const importBundleSchema = z.object({ bundle: z.unknown() });

router.post('/api/v1/browser-profile/import-bundle', (req, res) => {
  const parsed = importBundleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const newId = pm.importProfileBundle(parsed.data.bundle as pm.ProfileBundle);
    res.json({ code: 0, msg: 'success', data: { user_id: newId } });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.get('/api/v1/browser-profile/detail', (req, res) => {
  const id = String(req.query.user_id || '');
  if (!id) {
    res.json({ code: -1, msg: 'user_id is required', data: {} });
    return;
  }
  const details = pm.getProfileDetails(id);
  if (!details) {
    res.json({ code: -1, msg: 'profile not found', data: {} });
    return;
  }
  res.json({ code: 0, msg: 'success', data: details });
});

const proxyInputSchema = z.object({
  type: z.enum(['http', 'https', 'socks5', 'ssh']),
  host: z.string(),
  port: z.union([z.number(), z.string()]).transform(Number),
  username: z.string().optional(),
  password: z.string().optional(),
  privateKey: z.string().optional(),
});

const updateProfileSchema = z.object({
  user_id: z.string(),
  name: z.string().optional(),
  group_id: z.string().nullable().optional(),
  proxy_id: z.string().nullable().optional(),
  proxy: proxyInputSchema.nullable().optional(),
  device_id: z.string().nullable().optional(),
  user_agent: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  start_urls: z.array(z.string()).nullable().optional(),
  mobile_model_id: z.string().nullable().optional(),
  launch_args: z.array(z.string()).nullable().optional(),
  color: z.string().nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  do_not_track: z.enum(['off', 'on', 'auto']).nullable().optional(),
  blocked_ports: z.array(z.number().int().min(1).max(65535)).nullable().optional(),
  webrtc_policy: z.enum(['default', 'disable_non_proxied_udp', 'proxy']).nullable().optional(),
  headless: z.boolean().optional(),
});

router.post('/api/v1/browser-profile/update', (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const ok = pm.updateProfile(parsed.data.user_id, {
    name: parsed.data.name,
    group_id: parsed.data.group_id,
    proxy_id: parsed.data.proxy_id,
    proxy: parsed.data.proxy ? (parsed.data.proxy as pm.ProxyInput) : parsed.data.proxy,
    device_id: parsed.data.device_id,
    user_agent: parsed.data.user_agent,
    timezone: parsed.data.timezone,
    start_urls: parsed.data.start_urls,
    mobile_model_id: parsed.data.mobile_model_id,
    launch_args: parsed.data.launch_args,
    color: parsed.data.color,
    notes: parsed.data.notes,
    do_not_track: parsed.data.do_not_track,
    blocked_ports: parsed.data.blocked_ports,
    webrtc_policy: parsed.data.webrtc_policy,
    headless: parsed.data.headless,
  });
  res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'profile update failed', data: {} });
});

const deleteProfileSchema = z.object({
  user_id: z.string(),
});

router.post('/api/v1/browser-profile/delete', (req, res) => {
  const parsed = deleteProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const ok = pm.deleteProfile(parsed.data.user_id);
  res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'profile not found', data: {} });
});

const duplicateProfileSchema = z.object({
  user_id: z.string(),
  name: z.string().optional(),
});

router.post('/api/v1/browser-profile/duplicate', (req, res) => {
  const parsed = duplicateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const newId = pm.duplicateProfile(parsed.data.user_id, parsed.data.name);
  if (!newId) {
    res.json({ code: -1, msg: 'source profile not found', data: {} });
    return;
  }
  res.json({ code: 0, msg: 'success', data: { user_id: newId } });
});

const randomizeFpSchema = z.object({
  user_id: z.string(),
});

router.post('/api/v1/browser-profile/randomize-fingerprint', (req, res) => {
  const parsed = randomizeFpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  try {
    const newSeed = pm.randomizeProfileFingerprint(parsed.data.user_id);
    res.json(
      newSeed !== null
        ? { code: 0, msg: 'success', data: { seed: newSeed } }
        : { code: -1, msg: 'randomize fingerprint failed', data: {} }
    );
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.get('/api/v1/group/list', (_req, res) => {
  const list = pm.listGroups();
  res.json({ code: 0, msg: 'success', data: { list } });
});

const createGroupSchema = z.object({ name: z.string().min(1) });
router.post('/api/v1/group/create', (req, res) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'name is required', data: {} });
    return;
  }
  const id = pm.createGroup(parsed.data.name);
  res.json({ code: 0, msg: 'success', data: { group_id: id } });
});

const updateGroupSchema = z.object({
  group_id: z.string(),
  name: z.string().min(1).optional(),
  bookmarks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        url: z.string().url().refine((u) => /^https?:\/\//i.test(u), {
          message: 'Only http and https URLs are allowed',
        }),
      })
    )
    .optional(),
});
router.post('/api/v1/group/update', (req, res) => {
  const parsed = updateGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  const bookmarksJson = parsed.data.bookmarks !== undefined ? JSON.stringify(parsed.data.bookmarks) : undefined;
  const ok = pm.updateGroup(parsed.data.group_id, parsed.data.name, bookmarksJson);
  res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'group update failed', data: {} });
});

const deleteGroupSchema = z.object({ group_id: z.string() });
router.post('/api/v1/group/delete', (req, res) => {
  const parsed = deleteGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  const ok = pm.deleteGroup(parsed.data.group_id);
  res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'group delete failed', data: {} });
});

const createSchema = z.object({
  name: z.string().optional(),
  group_id: z.string().optional(),
  user_agent: z.string().optional(),
  timezone: z.string().optional(),
  browser_type: z.enum(['chromium', 'firefox']).optional(),
  proxy_id: z.string().optional(),
  device_id: z.string().optional(),
  fingerprint_seed: z.number().optional(),
  proxy: proxyInputSchema.optional(),
  start_urls: z.array(z.string()).optional(),
  mobile_model_id: z.string().optional(),
  color: z.string().optional(),
  notes: z.string().max(10000).optional(),
  // Privacy knobs. Constrained to the modes the launcher actually implements, so an
  // unsupported value is rejected at the edge instead of being stored and ignored.
  do_not_track: z.enum(['off', 'on', 'auto']).optional(),
  blocked_ports: z.array(z.number().int().min(1).max(65535)).optional(),
  webrtc_policy: z.enum(['default', 'disable_non_proxied_udp', 'proxy']).optional(),
  launch_args: z.array(z.string()).optional(),
  // Persisted display mode: headless profiles are what agent/automation callers launch.
  headless: z.boolean().optional(),
});

router.post('/api/v1/browser-profile/create', (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  const input: pm.CreateProfileInput = {
    name: parsed.data.name,
    group_id: parsed.data.group_id,
    user_agent: parsed.data.user_agent,
    timezone: parsed.data.timezone,
    browser_type: parsed.data.browser_type,
    device_id: parsed.data.device_id,
    proxy_id: parsed.data.proxy_id,
    fingerprint_seed: parsed.data.fingerprint_seed,
    proxy: parsed.data.proxy ? (parsed.data.proxy as pm.ProxyInput) : undefined,
    start_urls: parsed.data.start_urls,
    mobile_model_id: parsed.data.mobile_model_id,
    color: parsed.data.color,
    notes: parsed.data.notes,
    do_not_track: parsed.data.do_not_track,
    blocked_ports: parsed.data.blocked_ports,
    webrtc_policy: parsed.data.webrtc_policy,
    launch_args: parsed.data.launch_args,
    headless: parsed.data.headless,
  };
  try {
    const id = pm.createProfile(input);
    res.json({ code: 0, msg: 'success', data: { user_id: id } });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

// Proxy test endpoint (without saving)
router.post('/api/v1/proxy/test', async (req, res) => {
  const parsed = proxyInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid proxy payload', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const result = await checkProxy({
      id: 'tmp_test',
      type: parsed.data.type,
      host: parsed.data.host,
      port: parsed.data.port,
      username: parsed.data.username ?? null,
      password: parsed.data.password ?? null,
      private_key: parsed.data.privateKey ?? null,
      country: null,
      country_code: null,
      city: null,
      timezone: null,
      latitude: null,
      longitude: null,
      status: 'unknown',
      created_at: Date.now(),
    });
    res.json({ code: 0, msg: 'success', data: result });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: { ok: false, error: (err as Error).message } });
  }
});

// Firefox management routes (managed model)
const navigateSchema = z.object({ user_id: z.string(), url: z.string() });
router.post('/api/v1/browser/firefox/navigate', async (req, res) => {
  const parsed = navigateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  const result = await firefox.navigate(parsed.data.user_id, parsed.data.url);
  res.json(result.ok ? { code: 0, msg: 'success', data: { url: result.url, title: result.title } } : { code: -1, msg: result.error ?? 'navigate failed', data: {} });
});

const evaluateSchema = z.object({ user_id: z.string(), expression: z.string() });
router.post('/api/v1/browser/firefox/evaluate', async (req, res) => {
  const parsed = evaluateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  const result = await firefox.evaluate(parsed.data.user_id, parsed.data.expression);
  res.json(result.ok ? { code: 0, msg: 'success', data: { result: result.result } } : { code: -1, msg: result.error ?? 'evaluate failed', data: {} });
});

router.get('/api/v1/browser/firefox/title', async (req, res) => {
  const id = String(req.query.user_id || '');
  const result = await firefox.getTitle(id);
  res.json(result.ok ? { code: 0, msg: 'success', data: { title: result.title } } : { code: -1, msg: result.error ?? 'title failed', data: {} });
});

// Mobile preset pool (fixed "phone" for long-lived accounts).
router.get('/api/v1/device/mobile-presets', (_req, res) => {
  res.json({ code: 0, msg: 'success', data: { list: mobilePresets } });
});

// Every browser language a profile's fingerprint can carry.
//
// Served rather than duplicated in the renderer. The modal used to hold its own hand-written list
// of seven while the catalog derives twenty-one, and a `<select>` whose value matches no option
// renders its first option instead — so a profile whose language was `es-MX` opened on "Auto" and
// Save wrote that empty value over the real one, leaving the browser on the machine's locale.
// The catalog is the single source of truth here, so the list cannot drift from it again.
router.get('/api/v1/browser-profile/languages', (_req, res) => {
  const locales = Array.from(
    new Set(
      [...WINDOWS_FINGERPRINT_CATALOG, ...EXTENDED_FINGERPRINT_CATALOG].flatMap((f) => f.localePool),
    ),
  ).sort();
  res.json({ code: 0, msg: 'success', data: { list: locales } });
});

export default router;
