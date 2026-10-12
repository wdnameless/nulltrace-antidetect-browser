import { Request, Response, Router } from 'express';
import { z } from 'zod';

export type ControllerState = 'user' | 'agent';

// In-memory store: process lifetime only. Restart reverts all profiles to 'agent'.
const handoffStore = new Map<string, ControllerState>();

export function getController(profileId?: string | null): ControllerState {
  if (!profileId || typeof profileId !== 'string') return 'agent';
  return handoffStore.get(profileId) ?? 'agent';
}

export function isUserInControl(profileId?: string | null): boolean {
  return getController(profileId) === 'user';
}

export function setController(profileId: string, state: ControllerState): void {
  if (!profileId || typeof profileId !== 'string') return;
  handoffStore.set(profileId, state);
}

export function resetControllers(): void {
  handoffStore.clear();
}

const router = Router();

const handoffBodySchema = z
  .object({
    profile_id: z.string().trim().min(1).optional(),
    profileId: z.string().trim().min(1).optional(),
    state: z.enum(['user', 'agent']),
  })
  .refine((data) => Boolean(data.profile_id || data.profileId), {
    message: 'profile_id is required',
    path: ['profile_id'],
  });

router.post(['/api/v1/agent/handoff', '/handoff'], (req: Request, res: Response) => {
  const parsed = handoffBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      code: -1,
      msg: 'invalid body',
      data: { errors: parsed.error.flatten() },
    });
  }

  const profileId = (parsed.data.profile_id ?? parsed.data.profileId)!;
  const state = parsed.data.state;
  setController(profileId, state);

  return res.json({
    code: 0,
    msg: 'success',
    data: {
      profile_id: profileId,
      controller: state,
      state,
    },
  });
});

router.get(['/api/v1/agent/handoff', '/handoff'], (req: Request, res: Response) => {
  const rawProfileId = req.query.profile_id ?? req.query.profileId;
  const profileId = typeof rawProfileId === 'string' ? rawProfileId.trim() : '';

  if (!profileId) {
    return res.status(400).json({
      code: -1,
      msg: 'profile_id is required',
      data: {},
    });
  }

  const controller = getController(profileId);
  return res.json({
    code: 0,
    msg: 'success',
    data: {
      profile_id: profileId,
      controller,
    },
  });
});

export const handoffRouter = router;
export default router;
