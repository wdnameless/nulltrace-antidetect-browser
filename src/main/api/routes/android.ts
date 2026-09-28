import { Router, Request, Response } from 'express';
import { getDb } from '../../db';
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

export default router;
