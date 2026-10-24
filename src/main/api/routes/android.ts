import { Router, Request, Response } from 'express';
import { getDb } from '../../db';
import { resolveAndroidConfig } from '../../android/config';
import { getAndroidEngineStatus, ensureAndroidEngine } from '../../android/packageManager';
import { resolveAndroidPlatform, assertHypervisorReady } from '../../android/platform';
import {
  launchAndroidProfile,
  stopAndroidProfile,
  getAndroidInstance,
  listAndroidStatuses,
} from '../../android/instance';

const router = Router();

function extractErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// GET /api/v1/android/engine
router.get('/api/v1/android/engine', async (_req: Request, res: Response) => {
  try {
    const status = getAndroidEngineStatus();
    res.json({ code: 0, msg: 'success', data: status });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// POST /api/v1/android/engine/install
router.post('/api/v1/android/engine/install', async (req: Request, res: Response) => {
  try {
    const platform = resolveAndroidPlatform();
    await assertHypervisorReady(platform);
    const apiLevel = req.body?.apiLevel ? Number(req.body.apiLevel) : undefined;
    const result = await ensureAndroidEngine({ apiLevel });
    res.json({ code: 0, msg: 'success', data: result });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// GET /api/v1/android/instances
router.get('/api/v1/android/instances', async (_req: Request, res: Response) => {
  try {
    const instances = listAndroidStatuses();
    res.json({ code: 0, msg: 'success', data: instances });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// POST /api/v1/android/profiles/:id/start
router.post('/api/v1/android/profiles/:id/start', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const status = await launchAndroidProfile(id);
    res.json({ code: 0, msg: 'success', data: status });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    if (code === 'NOT_READY') {
      res.status(409).json({
        code: 'NOT_READY',
        msg: toErrorMessage(err) || 'Android engine is not ready',
        data: { code: 'NOT_READY' },
      });
      return;
    }
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// POST /api/v1/android/profiles/:id/stop
router.post('/api/v1/android/profiles/:id/stop', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const stopped = await stopAndroidProfile(id);
    res.json({ code: 0, msg: 'success', data: { stopped } });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// GET /api/v1/android/profiles/:id/status
router.get('/api/v1/android/profiles/:id/status', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);

    // Distinguish a missing profile from an idle one
    const db = getDb();
    const row = db.prepare('SELECT id, deleted_at FROM profiles WHERE id = ?').get(id) as
      | { id: string; deleted_at: number | null }
      | undefined;

    if (!row || row.deleted_at !== null) {
      res.status(404).json({
        code: -1,
        msg: `Profile ${id} not found`,
        data: { code: 'ERR_ANDROID_PROFILE_NOT_FOUND' },
      });
      return;
    }

    const instance = getAndroidInstance(id);
    if (instance) {
      res.json({ code: 0, msg: 'success', data: instance.status });
      return;
    }

    // Profile exists in DB but is not currently running
    res.json({
      code: 0,
      msg: 'success',
      data: {
        profileId: id,
        state: 'stopped',
        serial: '',
        consolePort: 0,
        adbPort: 0,
        screen: { width: 0, height: 0 },
        stream: 'idle',
        startedAt: 0,
      },
    });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// POST /api/v1/android/profiles/:id/stream-ticket
router.post('/api/v1/android/profiles/:id/stream-ticket', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const instance = getAndroidInstance(id);
    if (!instance || instance.status.state !== 'running') {
      res.status(409).json({
        code: -1,
        msg: `Profile ${id} is not running`,
        data: { code: 'NOT_RUNNING' },
      });
      return;
    }

    const ticket = instance.issueStreamTicket();
    res.json({ code: 0, msg: 'success', data: ticket });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// POST /api/v1/android/profiles/:id/prepare
router.post('/api/v1/android/profiles/:id/prepare', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    // Preparation only makes sense on a booted guest: the identity is written into the running
    // product partition and published by the emulator restart it performs.
    const existing = getAndroidInstance(id);
    if (!existing) {
      const status = await launchAndroidProfile(id);
      res.json({ code: 0, msg: 'success', data: { status, prepared: (status as { device?: unknown }).device ?? null } });
      return;
    }
    if (existing.status.state !== 'running') {
      res.status(409).json({
        code: -1,
        msg: `Profile ${id} is not running (state: ${existing.status.state})`,
        data: { code: 'NOT_RUNNING' },
      });
      return;
    }
    const prepared = await existing.prepareProfile();
    res.json({ code: 0, msg: 'success', data: { status: existing.status, prepared } });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    if (code === 'NOT_READY') {
      res.status(409).json({
        code: 'NOT_READY',
        msg: toErrorMessage(err) || 'Android engine is not ready',
        data: { code: 'NOT_READY' },
      });
      return;
    }
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// ---- MCP/automation control surface (requires a running instance) ----

function requireRunningInstance(id: string, res: Response) {
  const instance = getAndroidInstance(id);
  if (!instance || instance.status.state !== 'running') {
    res.status(409).json({
      code: -1,
      msg: `Profile ${id} is not running`,
      data: { code: 'NOT_RUNNING' },
    });
    return null;
  }
  return instance;
}

function badArg(res: Response, msg: string) {
  res.status(400).json({ code: -1, msg, data: { code: 'ERR_ANDROID_BAD_ARG' } });
}

function handleControlError(res: Response, err: unknown) {
  const code = extractErrorCode(err);
  if (code === 'NOT_RUNNING') {
    res.status(409).json({ code: -1, msg: toErrorMessage(err), data: { code } });
    return;
  }
  if (code === 'ERR_ANDROID_BAD_ARG' || code === 'ERR_ANDROID_BAD_POINT') {
    res.status(400).json({ code: -1, msg: toErrorMessage(err), data: { code } });
    return;
  }
  res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
}

// POST /api/v1/android/profiles/:id/tap {x, y} — physical guest px
router.post('/api/v1/android/profiles/:id/tap', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const { x, y } = req.body ?? {};
    if (typeof x !== 'number' || typeof y !== 'number') {
      badArg(res, 'tap requires numeric {x, y} in physical guest px');
      return;
    }
    const instance = requireRunningInstance(id, res);
    if (!instance) return;
    instance.tap(x, y);
    res.json({ code: 0, msg: 'success', data: { tapped: { x, y } } });
  } catch (err: unknown) {
    handleControlError(res, err);
  }
});

// POST /api/v1/android/profiles/:id/swipe {x1, y1, x2, y2, durationMs?}
router.post('/api/v1/android/profiles/:id/swipe', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const { x1, y1, x2, y2, durationMs } = req.body ?? {};
    if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number') {
      badArg(res, 'swipe requires numeric {x1, y1, x2, y2} in physical guest px');
      return;
    }
    if (durationMs !== undefined && (typeof durationMs !== 'number' || durationMs < 0 || durationMs > 10_000)) {
      badArg(res, 'durationMs must be a number 0..10000');
      return;
    }
    const instance = requireRunningInstance(id, res);
    if (!instance) return;
    await instance.swipe(x1, y1, x2, y2, durationMs);
    res.json({ code: 0, msg: 'success', data: { swiped: { x1, y1, x2, y2 } } });
  } catch (err: unknown) {
    handleControlError(res, err);
  }
});

// POST /api/v1/android/profiles/:id/type {text}
router.post('/api/v1/android/profiles/:id/type', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const { text } = req.body ?? {};
    if (typeof text !== 'string' || text.length === 0) {
      badArg(res, 'type requires a non-empty {text} string');
      return;
    }
    const instance = requireRunningInstance(id, res);
    if (!instance) return;
    await instance.type(text);
    res.json({ code: 0, msg: 'success', data: { typed: text.length } });
  } catch (err: unknown) {
    handleControlError(res, err);
  }
});

// POST /api/v1/android/profiles/:id/key {keycode} — Android keycode (4=BACK, 66=ENTER)
router.post('/api/v1/android/profiles/:id/key', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const { keycode } = req.body ?? {};
    if (typeof keycode !== 'number') {
      badArg(res, 'key requires a numeric {keycode} (e.g. 4=BACK, 66=ENTER)');
      return;
    }
    const instance = requireRunningInstance(id, res);
    if (!instance) return;
    instance.key(keycode);
    res.json({ code: 0, msg: 'success', data: { keycode } });
  } catch (err: unknown) {
    handleControlError(res, err);
  }
});

// GET /api/v1/android/profiles/:id/screencap — PNG bytes, same envelope shape as browser.screenshot
router.get('/api/v1/android/profiles/:id/screencap', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const instance = requireRunningInstance(id, res);
    if (!instance) return;
    const png = await instance.screencap();
    res.json({
      code: 0,
      msg: 'success',
      data: { format: 'png', base64: png.toString('base64'), sizeBytes: png.length },
    });
  } catch (err: unknown) {
    handleControlError(res, err);
  }
});

// POST /api/v1/android/profiles/:id/install {apkPath} — host-side APK file
router.post('/api/v1/android/profiles/:id/install', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const { apkPath } = req.body ?? {};
    if (typeof apkPath !== 'string' || apkPath.length === 0) {
      badArg(res, 'install requires a host-side {apkPath} string');
      return;
    }
    const instance = requireRunningInstance(id, res);
    if (!instance) return;
    await instance.installApk(apkPath);
    res.json({ code: 0, msg: 'success', data: { installed: apkPath } });
  } catch (err: unknown) {
    handleControlError(res, err);
  }
});

// POST /api/v1/android/profiles/:id/rotate — bump the identity epoch (rotation, interfaces §B)
router.post('/api/v1/android/profiles/:id/rotate', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const db = getDb();
    const row = db.prepare('SELECT id, android_config, deleted_at FROM profiles WHERE id = ?').get(id) as
      | { id: string; android_config: string | null; deleted_at: number | null }
      | undefined;
    if (!row || row.deleted_at !== null) {
      res.status(404).json({
        code: -1,
        msg: `Profile ${id} not found`,
        data: { code: 'ERR_ANDROID_PROFILE_NOT_FOUND' },
      });
      return;
    }
    let cfg: Record<string, unknown> = {};
    try {
      const parsed = row.android_config ? (JSON.parse(row.android_config) as unknown) : {};
      if (parsed && typeof parsed === 'object') cfg = { ...(parsed as Record<string, unknown>) };
    } catch {
      // invalid JSON: rotation starts a fresh object rather than failing the operator
    }
    const nextEpoch = (typeof cfg.identityEpoch === 'number' ? cfg.identityEpoch : 0) + 1;
    cfg.identityEpoch = nextEpoch;
    db.prepare('UPDATE profiles SET android_config = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(cfg), Date.now(), id);
    // Live re-inject: the identifiers are plain settings/props, so a running guest picks
    // them up without a reboot. resolveAndroidConfig re-derives from the bumped epoch.
    const resolved = resolveAndroidConfig(id);
    const instance = getAndroidInstance(id);
    let appliedLive = false;
    if (instance && instance.status.state === 'running') {
      appliedLive = await instance.applyIdentity(resolved.fingerprint);
    }
    res.json({
      code: 0,
      msg: 'success',
      data: {
        identityEpoch: nextEpoch,
        appliedLive,
        androidId: resolved.fingerprint.androidId,
        serial: resolved.fingerprint.serial,
        imeiTail: resolved.fingerprint.imei.slice(-4),
      },
    });
  } catch (err: unknown) {
    const code = extractErrorCode(err);
    res.json({ code: -1, msg: toErrorMessage(err), data: code ? { code } : {} });
  }
});

// GET /api/v1/android/profiles/:id/ui — current UI hierarchy for text-driven automation
router.get('/api/v1/android/profiles/:id/ui', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const instance = requireRunningInstance(id, res);
    if (!instance) return;
    const snapshot = await instance.uiHierarchy();
    if (snapshot.error) {
      res.status(503).json({ code: -1, msg: snapshot.error, data: { code: 'ERR_ANDROID_UI_DUMP', nodes: [] } });
      return;
    }
    res.json({ code: 0, msg: 'success', data: snapshot });
  } catch (err: unknown) {
    handleControlError(res, err);
  }
});

export default router;
