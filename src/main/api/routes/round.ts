import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { invokeScriptTask } from '../../scripts/scriptEngine';
import { isUserInControl } from './handoff';

const router = Router();

const roundBodySchema = z.object({
  code: z.string().min(1, 'code is required'),
  timeoutMs: z.number().positive().optional(),
  timeout_ms: z.number().positive().optional(),
});

router.post(['/api/v1/browser/:id/round', '/:id/round'], async (req: Request, res: Response) => {
  const rawId = req.params.id || (req.body?.profileId as unknown) || (req.body?.profile_id as unknown);
  const profileId = Array.isArray(rawId) ? String(rawId[0] || '') : (typeof rawId === 'string' ? rawId.trim() : '');
  if (!profileId) {
    return res.status(400).json({
      code: -1,
      msg: 'profile id is required',
      data: { console: [], result: null, error: 'profile id is required' },
    });
  }
  const parsed = roundBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      code: -1,
      msg: 'invalid body',
      data: { console: [], result: null, error: 'invalid body', errors: parsed.error.flatten() },
    });
  }

  // Gate enforcement (R07): reject when user is in control of profile
  if (isUserInControl(profileId)) {
    return res.status(409).json({
      code: -1,
      msg: 'USER_IN_CONTROL',
      error: 'USER_IN_CONTROL',
      error_code: 'USER_IN_CONTROL',
      data: {
        console: [],
        result: null,
        error: 'USER_IN_CONTROL',
        error_code: 'USER_IN_CONTROL',
      },
    });
  }

  const timeoutMs = parsed.data.timeoutMs ?? parsed.data.timeout_ms ?? 30000;
  const consoleLogs: string[] = [];

  try {
    const handle = invokeScriptTask({
      profileId,
      code: parsed.data.code,
      timeoutMs,
    });

    handle.logStream.on('log', (line: string) => {
      consoleLogs.push(line);
    });

    const outcome = await new Promise<{ result?: unknown; error?: string; logs: string[] }>((resolve) => {
      handle.logStream.on('done', (data: { result?: unknown; logs?: string[] }) => {
        resolve({ result: data.result, logs: data.logs || consoleLogs });
      });
      handle.logStream.on('error', (data: { error: string; logs?: string[] }) => {
        resolve({ error: data.error, logs: data.logs || consoleLogs });
      });
    });

    if (outcome.error) {
      return res.json({
        code: -1,
        msg: outcome.error,
        error: outcome.error,
        data: {
          console: outcome.logs,
          result: null,
          error: outcome.error,
        },
      });
    }

    return res.json({
      code: 0,
      msg: 'success',
      data: {
        console: outcome.logs,
        result: outcome.result !== undefined ? outcome.result : null,
      },
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      code: -1,
      msg: errMsg,
      error: errMsg,
      data: {
        console: consoleLogs,
        result: null,
        error: errMsg,
      },
    });
  }
});

export const roundRouter = router;
export default router;
