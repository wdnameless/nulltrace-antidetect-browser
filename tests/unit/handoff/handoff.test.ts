import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import http from 'http';
import handoffRouter, {
  getController,
  isUserInControl,
  setController,
  resetControllers,
} from '../../../src/main/api/routes/handoff';

interface HttpResponse {
  status: number;
  body: {
    code: number;
    msg: string;
    data: Record<string, unknown>;
  };
  text: string;
}

function requestHelper(
  server: http.Server,
  options: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
  }
): Promise<HttpResponse> {
  const addr = server.address() as { port: number };
  const postData = options.body !== undefined ? JSON.stringify(options.body) : undefined;

  const { promise, resolve, reject } = Promise.withResolvers<HttpResponse>();
  const req = http.request(
    {
      host: '127.0.0.1',
      port: addr.port,
      path: options.path,
      method: options.method,
      headers: {
        ...(postData !== undefined
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            }
          : {}),
      },
    },
    (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        let body: HttpResponse['body'] = { code: 0, msg: '', data: {} };
        try {
          body = JSON.parse(text);
        } catch {
          // Non-JSON response fallback
        }
        resolve({ status: res.statusCode || 0, body, text });
      });
    }
  );

  req.on('error', reject);
  if (postData !== undefined) {
    req.write(postData);
  }
  req.end();
  return promise;
}

describe('Z4 Handoff router and in-memory store (R07)', () => {
  let app: Express;
  let server: http.Server;

  beforeEach(async () => {
    resetControllers();
    app = express();
    app.use(express.json());
    app.use(handoffRouter);

    const { promise, resolve } = Promise.withResolvers<void>();
    server = app.listen(0, '127.0.0.1', () => resolve());
    await promise;
  });

  afterEach(async () => {
    resetControllers();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  });

  describe('In-memory store & exported helpers', () => {
    it('defaults controller to "agent" for unknown profiles', () => {
      expect(getController('unknown-profile')).toBe('agent');
      expect(isUserInControl('unknown-profile')).toBe(false);
    });

    it('returns "agent" when profileId is empty or undefined', () => {
      expect(getController('')).toBe('agent');
      expect(getController(undefined)).toBe('agent');
      expect(getController(null)).toBe('agent');
      expect(isUserInControl('')).toBe(false);
      expect(isUserInControl(undefined)).toBe(false);
      expect(isUserInControl(null)).toBe(false);
    });

    it('updates and retrieves controller state via setController', () => {
      setController('prof-1', 'user');
      expect(getController('prof-1')).toBe('user');
      expect(isUserInControl('prof-1')).toBe(true);

      setController('prof-1', 'agent');
      expect(getController('prof-1')).toBe('agent');
      expect(isUserInControl('prof-1')).toBe(false);
    });

    it('isolates state across different profiles', () => {
      setController('prof-a', 'user');
      expect(getController('prof-a')).toBe('user');
      expect(getController('prof-b')).toBe('agent');
      expect(isUserInControl('prof-a')).toBe(true);
      expect(isUserInControl('prof-b')).toBe(false);
    });

    it('reverts to default "agent" on restart/reset (in-memory store not persisted)', () => {
      setController('prof-1', 'user');
      expect(getController('prof-1')).toBe('user');

      // Simulate process restart
      resetControllers();
      expect(getController('prof-1')).toBe('agent');
      expect(isUserInControl('prof-1')).toBe(false);
    });
  });

  describe('REST endpoints', () => {
    it('GET /api/v1/agent/handoff returns default controller "agent" for fresh profile', async () => {
      const res = await requestHelper(server, {
        method: 'GET',
        path: '/api/v1/agent/handoff?profile_id=fresh-prof',
      });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.msg).toBe('success');
      expect(res.body.data.controller).toBe('agent');
      expect(res.body.data.profile_id).toBe('fresh-prof');
    });

    it('POST /api/v1/agent/handoff transitions profile to "user"', async () => {
      const postRes = await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: { profile_id: 'prof-test', state: 'user' },
      });

      expect(postRes.status).toBe(200);
      expect(postRes.body.code).toBe(0);
      expect(postRes.body.msg).toBe('success');
      expect(postRes.body.data.controller).toBe('user');
      expect(postRes.body.data.profile_id).toBe('prof-test');

      expect(getController('prof-test')).toBe('user');
      expect(isUserInControl('prof-test')).toBe(true);

      // Verify GET returns updated controller
      const getRes = await requestHelper(server, {
        method: 'GET',
        path: '/api/v1/agent/handoff?profile_id=prof-test',
      });
      expect(getRes.status).toBe(200);
      expect(getRes.body.code).toBe(0);
      expect(getRes.body.data.controller).toBe('user');
    });

    it('POST /api/v1/agent/handoff transitions from "user" back to "agent"', async () => {
      // First switch to user
      await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: { profile_id: 'prof-cycle', state: 'user' },
      });
      expect(getController('prof-cycle')).toBe('user');

      // Then switch back to agent
      const postRes = await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: { profile_id: 'prof-cycle', state: 'agent' },
      });
      expect(postRes.status).toBe(200);
      expect(postRes.body.code).toBe(0);
      expect(postRes.body.data.controller).toBe('agent');

      expect(getController('prof-cycle')).toBe('agent');
      expect(isUserInControl('prof-cycle')).toBe(false);

      const getRes = await requestHelper(server, {
        method: 'GET',
        path: '/api/v1/agent/handoff?profile_id=prof-cycle',
      });
      expect(getRes.status).toBe(200);
      expect(getRes.body.data.controller).toBe('agent');
    });

    it('supports profileId camelCase alias in body', async () => {
      const res = await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: { profileId: 'prof-camel', state: 'user' },
      });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(res.body.data.controller).toBe('user');
      expect(getController('prof-camel')).toBe('user');
    });

    it('rejects POST with invalid body (missing profile_id) with code -1', async () => {
      const res = await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: { state: 'user' },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(-1);
      expect(res.body.msg).toBe('invalid body');
    });

    it('rejects POST with invalid body (invalid state) with code -1', async () => {
      const res = await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: { profile_id: 'p1', state: 'unauthorized_state' },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(-1);
      expect(res.body.msg).toBe('invalid body');
    });

    it('rejects POST with empty body with code -1', async () => {
      const res = await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: {},
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(-1);
      expect(res.body.msg).toBe('invalid body');
    });

    it('rejects POST with blank profile_id with code -1', async () => {
      const res = await requestHelper(server, {
        method: 'POST',
        path: '/api/v1/agent/handoff',
        body: { profile_id: '   ', state: 'user' },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(-1);
      expect(res.body.msg).toBe('invalid body');
    });

    it('rejects GET when profile_id query parameter is missing with code -1', async () => {
      const res = await requestHelper(server, {
        method: 'GET',
        path: '/api/v1/agent/handoff',
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(-1);
      expect(res.body.msg).toBe('profile_id is required');
    });

    it('rejects GET when profile_id query parameter is blank with code -1', async () => {
      const res = await requestHelper(server, {
        method: 'GET',
        path: '/api/v1/agent/handoff?profile_id=%20%20',
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(-1);
      expect(res.body.msg).toBe('profile_id is required');
    });
  });
});
