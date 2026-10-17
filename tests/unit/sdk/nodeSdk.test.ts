import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import yaml from 'js-yaml';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AntidetectClient, ApiError } from '../../../packages/sdk-node/src/index.js';

describe('Node SDK & Contract Sync Test Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  const validToken = 'secret-test-token';

  beforeAll(async () => {
    const app = express();
    app.use(express.json());

    // Middleware: Authorization
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (req.path === '/status' && !authHeader) {
        // Status allows unauthenticated or checked separately
        return next();
      }
      if (req.headers['x-bypass-auth'] === 'true') {
        return next();
      }
      if (authHeader && authHeader === `Bearer ${validToken}`) {
        return next();
      }
      res.status(401).json({ code: 401, msg: 'Unauthorized: Invalid token', data: null });
    });

    // GET /status
    app.get('/status', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { version: '1.0.0', status: 'running' } });
    });

    // GET /api/v1/browser/list
    app.get('/api/v1/browser/list', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: {
          list: [
            { user_id: 'prof_1', name: 'Profile 1' },
            { user_id: 'prof_2', name: 'Profile 2' },
          ],
          total: 2,
        },
      });
    });

    // GET /api/v1/browser-profile/detail
    app.get('/api/v1/browser-profile/detail', (req, res) => {
      const userId = req.query.user_id;
      if (!userId) {
        return res.status(400).json({ code: -1, msg: 'Missing user_id', data: null });
      }
      res.json({
        code: 0,
        msg: 'ok',
        data: { user_id: String(userId), name: `Profile ${userId}` },
      });
    });

    // POST /api/v1/browser-profile/create
    app.post('/api/v1/browser-profile/create', (req, res) => {
      const body = req.body;
      if (!body.name) {
        return res.status(400).json({ code: -1, msg: 'Name is required', data: null });
      }
      res.json({
        code: 0,
        msg: 'ok',
        data: { user_id: 'prof_new', name: body.name },
      });
    });

    // POST /api/v1/browser-profile/update
    app.post('/api/v1/browser-profile/update', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: { user_id: req.body.user_id, name: req.body.name || 'updated' },
      });
    });

    // POST /api/v1/browser-profile/delete
    app.post('/api/v1/browser-profile/delete', (req, res) => {
      res.json({ code: 0, msg: 'deleted', data: {} });
    });

    // POST /api/v1/profiles/temporary
    app.post('/api/v1/profiles/temporary', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: {
          user_id: 'temp_profile_123',
          name: req.body.name || 'Temporary Profile',
          is_temporary: true,
        },
      });
    });

    // POST /api/v1/browser/start
    app.post('/api/v1/browser/start', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: {
          ws: {
            puppeteer: 'ws://127.0.0.1:9222/devtools/browser/abc',
            selenium: 'http://127.0.0.1:9222',
          },
          pid: 1234,
        },
      });
    });

    // POST /api/v1/browser/stop
    app.post('/api/v1/browser/stop', (req, res) => {
      res.json({ code: 0, msg: 'stopped', data: {} });
    });

    // GET /api/v1/proxy/list
    app.get('/api/v1/proxy/list', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { list: [] } });
    });

    // POST /api/v1/proxy/create
    app.post('/api/v1/proxy/create', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { proxy_id: 'px_created_1' } });
    });

    // POST /api/v1/proxy/update
    app.post('/api/v1/proxy/update', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { proxy_id: req.body.proxy_id } });
    });

    // POST /api/v1/proxy/delete
    app.post('/api/v1/proxy/delete', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: {} });
    });

    // POST /api/v1/proxy/check
    app.post('/api/v1/proxy/check', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { ok: true, latency_ms: 45 } });
    });

    // POST /api/v1/proxy/test
    app.post('/api/v1/proxy/test', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { ok: true, latency_ms: 60 } });
    });

    // GET /api/v1/diagnostics/:profileId
    app.get('/api/v1/diagnostics/:profileId', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: {
          profileId: req.params.profileId,
          timestamp: Date.now(),
          checks: { storage: 'ok', network: 'ok' },
        },
      });
    });

    // AdsPower endpoints
    app.get('/api/v1/user/list', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { list: [] } });
    });

    app.post('/api/v1/user/create', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { id: 'ads_1' } });
    });

    app.post('/api/v1/user/update', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: {} });
    });

    app.post('/api/v1/user/delete', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: {} });
    });

    app.get('/api/v1/browser/start', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: {
          ws: { puppeteer: 'ws://127.0.0.1:9222/ads' },
        },
      });
    });

    app.get('/api/v1/browser/stop', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: {} });
    });

    app.get('/api/v1/browser/active', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { status: 'Active' } });
    });

    // ==========================================
    // Email Mock Routes
    // ==========================================
    app.get('/api/v1/email/accounts', (req, res) => {
      const profileId = req.query.profile_id;
      res.json({
        code: 0,
        msg: 'ok',
        data: [
          {
            id: 'acc_1',
            email: 'user1@example.com',
            profile_id: profileId !== undefined ? (profileId === '' ? null : String(profileId)) : null,
          },
        ],
      });
    });

    app.post('/api/v1/email/accounts', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { id: 'acc_new', ...req.body } });
    });

    app.get('/api/v1/email/accounts/:id', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { id: req.params.id, email: 'user@example.com' } });
    });

    app.put('/api/v1/email/accounts/:id', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { id: req.params.id, ...req.body } });
    });

    app.delete('/api/v1/email/accounts/:id', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { deleted: true } });
    });

    app.post('/api/v1/email/accounts/:id/bind-profile', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { id: req.params.id, profile_id: req.body.profile_id ?? null } });
    });

    app.post('/api/v1/email/accounts/:id/reveal', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { password: 'plain-secret-password' } });
    });

    app.get('/api/v1/email/accounts/:id/folders', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: [{ name: 'INBOX', unread: 2 }] });
    });

    app.get('/api/v1/email/accounts/:id/folders/:folder/messages', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: {
          messages: [{ uid: '101', subject: 'Test Mail', from: 'sender@x.io', date: '2026-10-17' }],
          cached: false,
        },
      });
    });

    app.get('/api/v1/email/accounts/:id/folders/:folder/messages/:uid', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: {
          id: req.params.uid,
          uid: req.params.uid,
          folder: req.params.folder,
          body: 'Hello World Body',
          subject: 'Test Mail',
        },
      });
    });

    app.patch('/api/v1/email/accounts/:id/messages/:uid/flags', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { success: true } });
    });

    app.post('/api/v1/email/accounts/:id/send', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { messageId: '<msg_123@example.com>' } });
    });

    app.get('/api/v1/email/accounts/:id/outbox', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: [{ id: 'out_1', subject: 'Outbox Test', status: 'sent', to: ['to@x.io'] }],
      });
    });

    app.get('/api/v1/email/accounts/:id/drafts', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: [{ id: 'dr_1', subject: 'Draft Test', to: ['d@x.io'] }],
      });
    });

    app.post('/api/v1/email/accounts/:id/drafts', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { id: 'dr_new', ...req.body } });
    });

    app.delete('/api/v1/email/accounts/:id/drafts/:draftId', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { deleted: true } });
    });

    app.get('/api/v1/email/accounts/:id/inbox', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: { messages: [{ uid: '1', subject: 'Inbox Message' }], cached: false },
      });
    });

    app.get('/api/v1/email/accounts/:id/messages/:uid', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: { uid: req.params.uid, subject: 'Legacy Message', body: 'Verification code: 123456' },
      });
    });

    app.get('/api/v1/email/accounts/:id/messages/:uid/codes', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: { codes: ['123456'], message: { uid: req.params.uid, body: 'code: 123456' } },
      });
    });

    app.get('/api/v1/email/accounts/:id/codes', (req, res) => {
      res.json({
        code: 0,
        msg: 'ok',
        data: { codes: [{ uid: '1', subject: 'Code: 998877', codes: ['998877'] }] },
      });
    });

    app.post('/api/v1/email/extract-codes', (req, res) => {
      res.json({ code: 0, msg: 'ok', data: { codes: ['554433'] } });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it('authenticates with valid token and handles invalid token errors', async () => {
    const validClient = new AntidetectClient({ baseUrl, token: validToken });
    const invalidClient = new AntidetectClient({ baseUrl, token: 'wrong-token' });

    const statusRes = await validClient.getStatus();
    expect(statusRes.code).toBe(0);
    expect(statusRes.data.status).toBe('running');

    await expect(invalidClient.profiles.list()).rejects.toThrow(ApiError);
    try {
      await invalidClient.profiles.list();
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(401);
      expect(err.code).toBe(401);
    }
  });

  it('performs profile and temporary profile operations', async () => {
    const client = new AntidetectClient({ baseUrl, token: validToken });

    // List profiles
    const listRes = await client.profiles.list();
    expect(listRes.code).toBe(0);
    expect(listRes.data.list.length).toBe(2);

    // Get detail
    const detailRes = await client.profiles.get('prof_1');
    expect(detailRes.code).toBe(0);
    expect(detailRes.data.user_id).toBe('prof_1');

    // Create profile
    const createRes = await client.profiles.create({ name: 'Created Profile' });
    expect(createRes.code).toBe(0);
    expect(createRes.data.user_id).toBe('prof_new');

    // Update profile
    const updateRes = await client.profiles.update({ user_id: 'prof_new', name: 'Updated Profile' });
    expect(updateRes.code).toBe(0);
    expect(updateRes.data.name).toBe('Updated Profile');

    // Delete profile
    const deleteRes = await client.profiles.delete('prof_new');
    expect(deleteRes.code).toBe(0);

    // Temporary profile
    const tempRes = await client.profiles.temporary({ name: 'Ephemeral 1', ttl_minutes: 20 });
    expect(tempRes.code).toBe(0);
    expect(tempRes.data.user_id).toBe('temp_profile_123');
  });

  it('performs browser and proxy operations', async () => {
    const client = new AntidetectClient({ baseUrl, token: validToken });

    // Browser start / stop
    const startRes = await client.browser.start('prof_1', { headless: true });
    expect(startRes.code).toBe(0);
    expect(startRes.data.ws?.puppeteer).toContain('ws://');

    const stopRes = await client.browser.stop('prof_1');
    expect(stopRes.code).toBe(0);

    // Proxy CRUD & check/test
    const pList = await client.proxy.list();
    expect(pList.code).toBe(0);

    const pCreate = await client.proxy.create({ type: 'http', host: '1.2.3.4', port: 8080 });
    expect(pCreate.data.proxy_id).toBe('px_created_1');

    const pUpdate = await client.proxy.update({ proxy_id: 'px_created_1', host: '5.6.7.8' });
    expect(pUpdate.data.proxy_id).toBe('px_created_1');

    const pDelete = await client.proxy.delete('px_created_1');
    expect(pDelete.code).toBe(0);

    const pCheck = await client.proxy.check('px_created_1');
    expect(pCheck.data.ok).toBe(true);

    const pTest = await client.proxy.test({ type: 'socks5', host: '1.2.3.4', port: 1080 });
    expect(pTest.data.ok).toBe(true);

    // Diagnostics
    const diag = await client.diagnostics.run('prof_1');
    expect(diag.data.profileId).toBe('prof_1');
  });

  it('performs AdsPower compatibility operations', async () => {
    const client = new AntidetectClient({ baseUrl, token: validToken });

    const uList = await client.adspower.userList();
    expect(uList.code).toBe(0);

    const uCreate = await client.adspower.userCreate({ name: 'ads' });
    expect(uCreate.code).toBe(0);

    const uUpdate = await client.adspower.userUpdate({ user_id: 'ads_1', name: 'ads_updated' });
    expect(uUpdate.code).toBe(0);

    const uDelete = await client.adspower.userDelete(['ads_1']);
    expect(uDelete.code).toBe(0);

    const bStart = await client.adspower.browserStart('ads_1');
    expect(bStart.code).toBe(0);
    expect(bStart.data.ws?.puppeteer).toContain('ws://');

    const bStop = await client.adspower.browserStop('ads_1');
    expect(bStop.code).toBe(0);

    const bActive = await client.adspower.browserActive();
    expect(bActive.code).toBe(0);
  });

  it('performs email domain operations', async () => {
    const client = new AntidetectClient({ baseUrl, token: validToken });

    // 1. Accounts CRUD + bind + reveal
    const listAcc = await client.email.listAccounts();
    expect(listAcc.code).toBe(0);
    expect(listAcc.data.length).toBe(1);

    const filterAcc = await client.email.listAccounts({ profile_id: 'prof_1' });
    expect(filterAcc.code).toBe(0);
    expect(filterAcc.data[0].profile_id).toBe('prof_1');

    const unboundAcc = await client.email.listAccounts({ profile_id: null });
    expect(unboundAcc.code).toBe(0);
    expect(unboundAcc.data[0].profile_id).toBeNull();

    const getAcc = await client.email.getAccount('acc_1');
    expect(getAcc.code).toBe(0);
    expect(getAcc.data.id).toBe('acc_1');

    const createAcc = await client.email.createAccount({
      email: 'new@x.io',
      host: 'imap.x.io',
      username: 'new@x.io',
      display_name: 'New Mail',
    });
    expect(createAcc.code).toBe(0);
    expect(createAcc.data.id).toBe('acc_new');

    const updateAcc = await client.email.updateAccount('acc_1', { display_name: 'Updated Name' });
    expect(updateAcc.code).toBe(0);

    const bindRes = await client.email.bindProfile('acc_1', 'prof_123');
    expect(bindRes.code).toBe(0);
    expect(bindRes.data.profile_id).toBe('prof_123');

    const revealRes = await client.email.revealPassword('acc_1');
    expect(revealRes.code).toBe(0);
    expect(revealRes.data.password).toBe('plain-secret-password');

    // 2. Folders & Messages
    const foldersRes = await client.email.listFolders('acc_1');
    expect(foldersRes.code).toBe(0);
    expect(foldersRes.data[0].name).toBe('INBOX');

    const msgsRes = await client.email.listMessages('acc_1', 'INBOX', { q: 'Test' });
    expect(msgsRes.code).toBe(0);
    expect(msgsRes.data.messages.length).toBe(1);

    const searchRes = await client.email.searchMessages('acc_1', 'INBOX', 'Test', { unread: true });
    expect(searchRes.code).toBe(0);
    expect(searchRes.data.messages[0].uid).toBe('101');

    const msgDetail = await client.email.getMessage('acc_1', 'INBOX', '101');
    expect(msgDetail.code).toBe(0);
    expect(msgDetail.data.folder).toBe('INBOX');

    const flagsRes = await client.email.setMessageFlags('acc_1', '101', { seen: true });
    expect(flagsRes.code).toBe(0);
    expect(flagsRes.data.success).toBe(true);

    // 3. Send & Outbox
    const sendRes = await client.email.send('acc_1', {
      to: 'dest@x.io',
      subject: 'Hello',
      text: 'Body text',
    });
    expect(sendRes.code).toBe(0);
    expect(sendRes.data.messageId).toContain('@example.com');

    const outboxRes = await client.email.listOutbox('acc_1');
    expect(outboxRes.code).toBe(0);
    expect(outboxRes.data[0].status).toBe('sent');

    // 4. Drafts CRUD
    const draftsList = await client.email.listDrafts('acc_1');
    expect(draftsList.code).toBe(0);
    expect(draftsList.data.length).toBe(1);

    const saveDraft = await client.email.saveDraft('acc_1', { subject: 'New Draft' });
    expect(saveDraft.code).toBe(0);
    expect(saveDraft.data.id).toBe('dr_new');

    const delDraft = await client.email.deleteDraft('acc_1', 'dr_1');
    expect(delDraft.code).toBe(0);
    expect(delDraft.data.deleted).toBe(true);

    // 5. Codes & Legacy
    const inboxRes = await client.email.listInbox('acc_1');
    expect(inboxRes.code).toBe(0);
    expect(inboxRes.data.messages[0].uid).toBe('1');

    const inMsg = await client.email.getInboxMessage('acc_1', '1');
    expect(inMsg.code).toBe(0);
    expect(inMsg.data.uid).toBe('1');

    const msgCodes = await client.email.getMessageCodes('acc_1', '1');
    expect(msgCodes.code).toBe(0);
    expect(msgCodes.data.codes).toEqual(['123456']);

    const listCodes = await client.email.listCodes('acc_1');
    expect(listCodes.code).toBe(0);
    expect(listCodes.data.codes[0].codes).toEqual(['998877']);

    const extCodes = await client.email.extractCodes('Your code: 554433');
    expect(extCodes.code).toBe(0);
    expect(extCodes.data.codes).toEqual(['554433']);

    const delAcc = await client.email.deleteAccount('acc_1');
    expect(delAcc.code).toBe(0);
    expect(delAcc.data.deleted).toBe(true);

    // 6. Sub-namespaces delegation verify
    expect(typeof client.email.accounts.list).toBe('function');
    expect(typeof client.email.folders.list).toBe('function');
    expect(typeof client.email.messages.send).toBe('function');
    expect(typeof client.email.drafts.save).toBe('function');
    expect(typeof client.email.codes.extract).toBe('function');
  });

  it('validates contract sync between SDK methods and docs/openapi.yaml', () => {
    const openapiPath = path.resolve(process.cwd(), 'docs/openapi.yaml');
    expect(fs.existsSync(openapiPath)).toBe(true);

    const yamlContent = fs.readFileSync(openapiPath, 'utf-8');
    const spec = yaml.load(yamlContent) as { paths: Record<string, unknown> };

    expect(spec.paths).toBeDefined();

    // Required core paths in openapi spec
    const requiredPaths = [
      '/status',
      '/api/v1/browser/start',
      '/api/v1/browser/stop',
      '/api/v1/browser/list',
      '/api/v1/browser-profile/create',
      '/api/v1/browser-profile/update',
      '/api/v1/browser-profile/delete',
      '/api/v1/browser-profile/detail',
      '/api/v1/profiles/temporary',
      '/api/v1/proxy/create',
      '/api/v1/proxy/list',
      '/api/v1/proxy/update',
      '/api/v1/proxy/delete',
      '/api/v1/proxy/check',
      '/api/v1/proxy/test',
      '/api/v1/diagnostics/{profileId}',
      '/api/v1/user/list',
      '/api/v1/user/create',
      '/api/v1/user/update',
      '/api/v1/user/delete',
      '/api/v1/browser/active',
      '/api/v2/browser-profile/start',
      '/api/v2/browser-profile/stop',
      '/api/v2/browser-profile/list',
    ];

    for (const reqPath of requiredPaths) {
      expect(spec.paths[reqPath]).toBeDefined();
    }
  });
});
