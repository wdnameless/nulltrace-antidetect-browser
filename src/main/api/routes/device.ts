import { Router } from 'express';
import { z } from 'zod';
import * as dm from '../../devices/deviceManager';

const router = Router();

const deviceSchema = z.object({
  name: z.string(),
  platform: z.enum(['win', 'mac', 'linux', 'ios', 'android']),
  config: z.record(z.unknown()),
});

router.post('/api/v1/device/create', (req, res) => {
  const parsed = deviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: { errors: parsed.error.flatten() } });
    return;
  }
  try {
    const id = dm.createDevice({
      name: parsed.data.name,
      platform: parsed.data.platform,
      // SAFETY: the schema above types `config` as an open record, while `DeviceConfig` is the
      // store's own shape. The value is persisted as JSON and never read structurally here, so the
      // assertion cannot hide a field mismatch that this path would act on.
      config: parsed.data.config as unknown as dm.DeviceConfig,
    });
    res.json({ code: 0, msg: 'success', data: { device_id: id } });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

router.get('/api/v1/device/list', (_req, res) => {
  /*
   * `listDevices()` already parses the column, so this route parses it a second time — and that
   * second parse was the only unguarded one in the route layer: the handler has no try/catch, so a
   * single malformed `config_json` row threw out of the map and turned the whole list into a 500,
   * hiding every healthy device along with the bad one.
   *
   * A corrupt value is reachable without any hostile input: a row written by an interrupted
   * migration, a partially restored backup, or a column edited by hand all produce it. One bad row
   * must not take the list down, so the failure is contained per row and reported as `null` rather
   * than as a fabricated `{}` that would look like a device with a deliberately empty config.
   */
  const list = dm.listDevices().map((d) => {
    let config: unknown = null;
    try {
      config = JSON.parse(d.config_json) as unknown;
    } catch {
      config = null;
    }
    return {
      device_id: d.id,
      name: d.name,
      platform: d.platform,
      config,
    };
  });
  res.json({ code: 0, msg: 'success', data: { list, total: list.length } });
});

const updateSchema = deviceSchema.partial().extend({ device_id: z.string() });
router.post('/api/v1/device/update', (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  const { device_id, ...rest } = parsed.data;
  const ok = dm.updateDevice(device_id, {
    name: rest.name,
    platform: rest.platform,
    config: rest.config as dm.DeviceConfig | undefined,
  });
  res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'device not found', data: {} });
});

const deleteSchema = z.object({ device_id: z.string() });
router.post('/api/v1/device/delete', (req, res) => {
  const parsed = deleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.json({ code: -1, msg: 'invalid body', data: {} });
    return;
  }
  try {
    const ok = dm.deleteDevice(parsed.data.device_id);
    res.json(ok ? { code: 0, msg: 'success', data: {} } : { code: -1, msg: 'device not found', data: {} });
  } catch (err) {
    res.json({ code: -1, msg: (err as Error).message, data: {} });
  }
});

export default router;
