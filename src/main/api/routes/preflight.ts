import { Request, Response, Router } from 'express';
import { runPreflight, blockOnFailLaunchGuard } from '../../preflight/preflightService';
import { getLastVerdict } from '../../preflight/store';
import { PreflightVerdict } from '../../preflight/types';
import * as pm from '../../profiles/profileManager';
import * as launcher from '../../launcher/chromium';
import * as firefox from '../../launcher/firefox';
import { SERVER_MODE } from '../../config';
import * as androidRuntime from '../../android/instance';
const router = Router();

/**
 * POST /api/profiles/:id/preflight
 * Runs preflight checks for the profile and returns full PreflightVerdict.
 */
router.post('/api/profiles/:id/preflight', async (req: Request, res: Response) => {
  const profileId = String(req.params.id || '');
  if (!profileId) {
    return res.status(400).json({ code: -1, msg: 'profile ID is required', data: {} });
  }
  const profile = pm.getProfile(profileId);
  if (!profile) {
    return res.status(404).json({ code: -1, msg: 'profile not found', data: {} });
  }

  try {
    const verdict = await runPreflight(profileId);
    return res.json({
      code: 0,
      msg: 'success',
      data: verdict,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ code: -1, msg, data: {} });
  }
});

/**
 * GET /api/profiles/:id/preflight/last
 * Returns the cached last verdict for the profile, or 404 if none exists.
 */
router.get('/api/profiles/:id/preflight/last', (req: Request, res: Response) => {
  const profileId = String(req.params.id || '');
  if (!profileId) {
    return res.status(400).json({ code: -1, msg: 'profile ID is required', data: {} });
  }
  const verdict = getLastVerdict(profileId);
  if (!verdict) {
    return res.status(404).json({ code: -1, msg: 'no preflight verdict recorded for profile', data: {} });
  }
  return res.json({
    code: 0,
    msg: 'success',
    data: verdict,
  });
});

/**
 * POST /api/profiles/:id/start-with-preflight
 * Start profile with optional blockOnFail guard
 */
router.post('/api/profiles/:id/start-with-preflight', async (req: Request, res: Response) => {
  const profileId = String(req.params.id || '');
  if (!profileId) {
    return res.status(400).json({ code: -1, msg: 'profile ID is required', data: {} });
  }

  const blockOnFail = Boolean(req.body?.blockOnFail || req.query.blockOnFail === 'true');
  const autoStart = Boolean(req.body?.autoStart || req.query.autoStart === 'true');

  if (autoStart) {
    const profile = pm.getProfile(profileId);
    if (!profile) {
      return res.status(404).json({ code: -1, msg: 'profile not found', data: {} });
    }
  }

  let verdict: PreflightVerdict | undefined;

  if (blockOnFail) {
    const guard = await blockOnFailLaunchGuard(profileId, true);
    verdict = guard.verdict;
    if (!guard.allowed) {
      return res.status(412).json({
        code: -1,
        msg: 'Launch blocked by preflight failure',
        data: guard.verdict,
      });
    }
  } else {
    verdict = await runPreflight(profileId);
    if (autoStart && verdict.overall === 'fail') {
      return res.status(412).json({
        code: -1,
        msg: 'Launch blocked by preflight failure',
        data: verdict,
      });
    }
  }

  if (!autoStart) {
    return res.json({
      code: 0,
      msg: 'Preflight launch guard passed',
      data: {
        profileId,
        allowed: true,
        ...(verdict ? { verdict } : {}),
      },
    });
  }

  // autoStart = true: spawn the profile via the existing launcher start path
  try {
    const profile = pm.getProfile(profileId);
    if (profile?.browser_type === 'android') {
      const status = await androidRuntime.launchAndroidProfile(profileId);
      pm.setStatus(profileId, 'running');
      return res.json({
        code: 0,
        msg: 'success',
        data: {
          browser_type: 'android',
          ...status,
          profileId,
          allowed: true,
          ...(verdict ? { verdict } : {}),
        },
      });
    }
    const cfg = pm.resolveLaunchConfig(profileId);
    if (cfg.browserType === 'firefox') {
      const result = await firefox.startFirefox(cfg);
      if (result.ok) {
        pm.setStatus(profileId, 'running');
        const launchData = {
          browser_type: 'firefox',
          url: result.url,
          title: result.title,
        };
        return res.json({
          code: 0,
          msg: 'success',
          data: {
            ...launchData,
            profileId,
            allowed: true,
            ...(verdict ? { verdict } : {}),
          },
        });
      } else {
        return res.json({ code: -1, msg: result.error ?? 'firefox start failed', data: {} });
      }
    } else {
      const startResult = await launcher.startProfile(cfg);
      pm.setStatus(profileId, 'running');

      // Rewrite for remote host in SERVER_MODE if applicable
      const host = req.headers.host;
      const isLoopback = !host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
      let resolvedResult = startResult;
      if (SERVER_MODE && !isLoopback) {
        const ep = launcher.getCdpEndpoint(profileId);
        if (ep) {
          resolvedResult = {
            ...startResult,
            ws: {
              puppeteer: `ws://${host}/cdp/${profileId}${ep.wsPath}`,
              selenium: startResult.ws.selenium,
            },
          };
        }
      }

      const wsEndpoint = resolvedResult.ws?.puppeteer;

      return res.json({
        code: 0,
        msg: 'success',
        data: {
          ...resolvedResult,
          ...(wsEndpoint ? { wsEndpoint } : {}),
          profileId,
          allowed: true,
          ...(verdict ? { verdict } : {}),
        },
      });
    }
  } catch (err) {
    pm.setStatus(profileId, 'closed');
    return res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});


export default router;
