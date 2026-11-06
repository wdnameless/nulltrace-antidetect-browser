import { Router, Request, Response } from 'express';
import { WebSocket } from 'ws';
import { motionSessions } from '../../motion/session';
import type { GlidePlan } from '../../motion/trajectory';
import type { TypingPlan } from '../../motion/typing';
import { getCdpEndpoint } from '../../launcher/chromium';
import { generatePersona } from '../../motion/persona';
import { fillFormOnProfile } from '../../motion/formFill';
import { resolveLaunchConfig } from '../../profiles/profileManager';

export const motionRouter = Router();

const LOOPBACK = '127.0.0.1';

interface RawCdp {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** Minimal browser-level CDP client; auto-attaches to the first page target. */
async function connectRawCdp(profileId: string): Promise<RawCdp> {
  const ep = getCdpEndpoint(profileId);
  if (!ep) {
    throw new Error('profile is not running');
  }
  const ws = new WebSocket(`ws://${LOOPBACK}:${ep.port}${ep.wsPath}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let pageSessionId: string | null = null;

  const rawSend = (frame: Record<string, unknown>): void => {
    ws.send(JSON.stringify(frame));
  };
  const call = <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      rawSend({ id, method, params: params ?? {} });
    });
  };

  ws.on('message', (data: unknown) => {
    try {
      const msg = JSON.parse(String(data)) as {
        id?: number;
        error?: unknown;
        result?: Record<string, unknown>;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(JSON.stringify(msg.error)));
        } else {
          p.resolve((msg.result ?? {}) as Record<string, unknown>);
        }
        return;
      }
      if (msg.method === 'Target.attachedToTarget' && msg.params) {
        const info = msg.params as { sessionId: string; targetInfo: { type: string } };
        if (info.targetInfo?.type === 'page') {
          pageSessionId = info.sessionId;
        }
      }
    } catch {
      // ignore malformed frames
    }
  });

  // Attach to the first page target: the Input domain lives on the page.
  const { targetInfos } = await call<{ targetInfos: Array<{ targetId: string; type: string }> }>(
    'Target.getTargets'
  );
  const page = targetInfos.find((t) => t.type === 'page');
  if (!page) {
    ws.close();
    throw new Error('no page target in browser');
  }
  await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  if (!pageSessionId) {
    ws.close();
    throw new Error('failed to attach to page target');
  }

  return {
    send(method, params) {
      const id = nextId++;
      const frame: Record<string, unknown> = { id, method, params: params ?? {} };
      if (pageSessionId && (method.startsWith('Input.') || method.startsWith('Page.'))) {
        frame.sessionId = pageSessionId;
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        rawSend(frame);
      });
    },
    close() {
      ws.close();
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function executeGlide(_profileId: string, cdp: RawCdp, plan: GlidePlan): Promise<void> {
  for (const move of plan.moves) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: move.x,
      y: move.y,
      button: 'none',
    });
    if (move.delayMs > 0) await sleep(move.delayMs);
  }
}

async function executeTyping(_profileId: string, cdp: RawCdp, plan: TypingPlan): Promise<void> {
  for (const key of plan.keys) {
    await sleep(key.delayMs);
    if (key.type === 'down') {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: key.key });
    } else {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key });
    }
  }
}

// POST /api/v1/motion/:profileId/:command
motionRouter.post('/api/v1/motion/:profileId/:command', async (req: Request, res: Response) => {
  const profileId = String(req.params.profileId || '');
  const command = String(req.params.command || '');
  const params = (req.body || {}) as Record<string, unknown>;

  let cdp: RawCdp | null = null;
  try {
    const needCdp = command !== 'createPointer' && command !== 'destroyPointer';
    if (needCdp) {
      cdp = await connectRawCdp(profileId);
    }

    switch (`Motion.${command}`) {
      case 'Motion.createPointer': {
        const pointer = motionSessions.createPointer(profileId, {
          seed: typeof params.seed === 'number' ? params.seed : undefined,
          paceScale: typeof params.paceScale === 'number' ? params.paceScale : undefined,
          profileSeed: typeof params.profileSeed === 'number' ? params.profileSeed : undefined,
          startX: typeof params.startX === 'number' ? params.startX : undefined,
          startY: typeof params.startY === 'number' ? params.startY : undefined,
        });
        res.json({
          code: 0,
          msg: 'success',
          data: { pointer: { x: pointer.x, y: pointer.y, seed: pointer.seed, paceScale: pointer.paceScale } },
        });
        break;
      }
      case 'Motion.glideTo': {
        const { plan, pointer } = motionSessions.glideTo(
          profileId,
          { x: Number(params.x) || 0, y: Number(params.y) || 0 },
          typeof params.targetWidth === 'number' ? params.targetWidth : 32
        );
        await executeGlide(profileId, cdp!, plan);
        res.json({ code: 0, msg: 'success', data: { durationMs: plan.durationMs, x: pointer.x, y: pointer.y } });
        break;
      }
      case 'Motion.tap': {
        const tap = motionSessions.tap(profileId, {
          clickCount: typeof params.clickCount === 'number' ? params.clickCount : undefined,
          button: typeof params.button === 'string' ? (params.button as 'left' | 'right' | 'middle') : undefined,
          delayMs: typeof params.delayMs === 'number' ? params.delayMs : undefined,
        });
        const clicks = tap.clicks;
        for (let i = 0; i < clicks; i++) {
          await cdp!.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: tap.x,
            y: tap.y,
            button: tap.button,
            clickCount: i + 1,
          });
          await sleep(Math.round(tap.delayMs / 2));
          await cdp!.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: tap.x,
            y: tap.y,
            button: tap.button,
            clickCount: i + 1,
          });
          if (i < clicks - 1) await sleep(Math.round(tap.delayMs / 2));
        }
        res.json({ code: 0, msg: 'success', data: { x: tap.x, y: tap.y, clicks, button: tap.button } });
        break;
      }
      case 'Motion.enterText': {
        const { plan } = motionSessions.enterText(
          profileId,
          String(params.text ?? ''),
          params.allowTypos === true
        );
        await executeTyping(profileId, cdp!, plan);
        res.json({ code: 0, msg: 'success', data: { durationMs: plan.durationMs } });
        break;
      }
      case 'Motion.destroyPointer': {
        const removed = motionSessions.destroyPointer(profileId);
        res.json({ code: 0, msg: 'success', data: { destroyed: removed } });
        break;
      }
      default:
        res.json({ code: -1, msg: `unknown Motion command: ${command}`, data: {} });
    }
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  } finally {
    // Every Motion request opens its own CDP WebSocket; a throw before the
    // success path (timeout, closed page, aborted gesture) used to leak it.
    // Measured on a long-lived install: 4 487 orphaned listeners after 10 days,
    // which exhausted ephemeral ports and made every outbound connect fail.
    cdp?.close();
  }
});
// ---------------------------------------------------------------------------
// Persona + form filling (parity: form-filling-helper). The persona is derived
// from the profile's fingerprint seed, so a profile always presents the same
// person; filling goes through the Motion input path as real keystrokes.
// ---------------------------------------------------------------------------

// GET /api/v1/persona?profile_id=...
motionRouter.get('/api/v1/persona', (req: Request, res: Response) => {
  try {
    const profileId = String(req.query.profile_id || '');
    if (!profileId) {
      res.json({ code: -1, msg: 'profile_id is required', data: {} });
      return;
    }
    const cfg = resolveLaunchConfig(profileId);
    const country = typeof req.query.country === 'string' ? req.query.country : undefined;
    const persona = generatePersona(cfg.fingerprintSeed, country ? { country } : {});
    res.json({ code: 0, msg: 'success', data: { persona } });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

// POST /api/v1/persona/fill {profile_id, mapping, clear_first?}
motionRouter.post('/api/v1/persona/fill', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      profile_id?: unknown;
      mapping?: unknown;
      clear_first?: unknown;
    };
    const profileId = typeof body.profile_id === 'string' ? body.profile_id : '';
    if (!profileId) {
      res.json({ code: -1, msg: 'profile_id is required', data: {} });
      return;
    }
    const mapping =
      body.mapping && typeof body.mapping === 'object' && !Array.isArray(body.mapping)
        ? (body.mapping as Record<string, string>)
        : {};
    if (Object.keys(mapping).length === 0) {
      res.json({ code: -1, msg: 'mapping must map a selector to a persona field', data: {} });
      return;
    }
    const cfg = resolveLaunchConfig(profileId);
    const persona = generatePersona(cfg.fingerprintSeed);
    const result = await fillFormOnProfile(profileId, persona, mapping, cfg.fingerprintSeed);
    res.json({ code: 0, msg: 'success', data: result });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});
