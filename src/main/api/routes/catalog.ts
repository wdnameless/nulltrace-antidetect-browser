// Catalog API (Sprint 4.4): manifest fetch + checksum-verified install.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as catalog from '../../scripts/scriptCatalog';
import { setSetting, getSetting } from '../../config';
import { assertPublicHttpUrl } from '../../util/outboundUrl';

const router = Router();

router.get('/api/v1/catalog', async (_req: Request, res: Response) => {
  const r = await catalog.fetchCatalog();
  if (!r.ok) {
    res.status(400).json({ code: r.code, msg: r.msg, data: { url: catalog.getCatalogUrlSetting() } });
    return;
  }
  res.json({ code: 0, msg: 'success', data: { url: catalog.getCatalogUrlSetting(), ...r.data } });
});

router.get('/api/v1/catalog/code', async (req: Request, res: Response) => {
  const url = String(req.query.url || '');
  /*
   * The scheme check that used to live here (`/^https?:\/\//i`) let any address the machine can
   * reach be fetched server-side — including loopback. Because this backend also serves
   * `GET /ui/key`, which returns the automation key with its same-origin guard skipped when no
   * `Origin` header is sent, the fetch became a way to read that key back out of the response body.
   * Measured before the guard: the call returned 200 with the live key inside `data.code`.
   */
  const policy = await assertPublicHttpUrl(url);
  if (!policy.ok) {
    res.status(400).json({ code: 'INVALID_INPUT', msg: policy.error ?? 'url not permitted', data: {} });
    return;
  }
  const r = await catalog.fetchCatalogCode(url);
  if (!r.ok) {
    res.status(400).json({ code: r.code, msg: r.msg, data: {} });
    return;
  }
  res.json({ code: 0, msg: 'success', data: r.data });
});

router.post('/api/v1/catalog/install', async (req: Request, res: Response) => {
  const parsed = z.object({ catalog_id: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', msg: 'catalog_id required', data: {} });
    return;
  }
  const r = await catalog.installFromCatalog(parsed.data.catalog_id);
  if (!r.ok) {
    const status = r.code === 'CHECKSUM_MISMATCH' ? 400 : r.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ code: r.code, msg: r.msg, data: {} });
    return;
  }
  res.json({ code: 0, msg: 'success', data: r.data });
});

// Catalog URL setting (Settings page).
router.get('/api/v1/catalog/url', (_req: Request, res: Response) => {
  res.json({ code: 0, msg: 'success', data: { url: catalog.getCatalogUrlSetting() } });
});

router.post('/api/v1/catalog/url', (req: Request, res: Response) => {
  const parsed = z.object({ url: z.string().max(2000) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_INPUT', msg: 'url string required', data: {} });
    return;
  }
  setSetting('catalogUrl', parsed.data.url.trim());
  res.json({ code: 0, msg: 'success', data: { url: getSetting('catalogUrl') } });
});

export default router;