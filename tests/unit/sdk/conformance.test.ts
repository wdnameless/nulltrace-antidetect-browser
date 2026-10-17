import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AntidetectClient } from '../../../packages/sdk-node/src/client';

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Record<string, any>>;
  components?: {
    schemas?: Record<string, any>;
  };
}

describe('OpenAPI & SDK Conformance Suite', () => {
  const rootDir = path.resolve(__dirname, '../../../');
  const openApiPath = path.join(rootDir, 'docs/openapi.yaml');
  const nodeClientPath = path.join(rootDir, 'packages/sdk-node/src/client.ts');
  const pythonModelsPath = path.join(rootDir, 'packages/sdk-python/antidetect_sdk/models.py');

  const rawYaml = fs.readFileSync(openApiPath, 'utf8');
  const spec = yaml.load(rawYaml) as OpenApiDoc;

  // Helper to normalize path from client template to OpenAPI path template
  function normalizeApiPath(clientPath: string): string {
    return clientPath
      .replace(/\$\{encodeURIComponent\(([^)]+)\)\}/g, '{$1}')
      .replace(/\$\{[^}]+\}/g, '{profileId}');
  }

  it('loads valid OpenAPI 3.x spec with paths and components', () => {
    expect(spec).toBeDefined();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it('every sdk-node client method path and verb exists in spec.paths', () => {
    const clientContent = fs.readFileSync(nodeClientPath, 'utf8');

    // Extract all this.request calls
    const requestRegex = /this\.request(?:<[^>]+>)?\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{[^}]*?method:\s*['"`]([A-Z]+)['"`])?/g;
    const calls: { path: string; method: string }[] = [];

    let match: RegExpExecArray | null;
    while ((match = requestRegex.exec(clientContent)) !== null) {
      calls.push({
        path: normalizeApiPath(match[1]),
        method: (match[2] || 'GET').toLowerCase()
      });
    }

    expect(calls.length).toBeGreaterThan(0);

    for (const call of calls) {
      const specPathObj = spec.paths[call.path];
      expect(
        specPathObj,
        `Expected path '${call.path}' from sdk-node client to exist in openapi.yaml paths`
      ).toBeDefined();

      const specMethodObj = specPathObj[call.method];
      expect(
        specMethodObj,
        `Expected HTTP method '${call.method.toUpperCase()}' for path '${call.path}' in openapi.yaml`
      ).toBeDefined();
    }
  });

  it('every spec path and verb referenced by the client has a 200 response defined', () => {
    const clientContent = fs.readFileSync(nodeClientPath, 'utf8');
    const requestRegex = /this\.request(?:<[^>]+>)?\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{[^}]*?method:\s*['"`]([A-Z]+)['"`])?/g;

    let match: RegExpExecArray | null;
    while ((match = requestRegex.exec(clientContent)) !== null) {
      const apiPath = normalizeApiPath(match[1]);
      const method = (match[2] || 'GET').toLowerCase();
      const pathItem = spec.paths[apiPath];
      expect(pathItem).toBeDefined();

      const operation = pathItem[method];
      expect(operation).toBeDefined();
      expect(
        operation.responses && operation.responses['200'],
        `Expected 200 response for ${method.toUpperCase()} ${apiPath}`
      ).toBeDefined();
    }
  });

  it('sdk-node public methods instantiate and map cleanly to AntidetectClient API surface', () => {
    const client = new AntidetectClient({ baseUrl: 'http://localhost:50325' });
    expect(client).toBeDefined();
    expect(typeof client.getStatus).toBe('function');
    expect(typeof client.profiles.list).toBe('function');
    expect(typeof client.profiles.get).toBe('function');
    expect(typeof client.profiles.create).toBe('function');
    expect(typeof client.profiles.update).toBe('function');
    expect(typeof client.profiles.delete).toBe('function');
    expect(typeof client.profiles.temporary).toBe('function');
    expect(typeof client.browser.start).toBe('function');
    expect(typeof client.browser.stop).toBe('function');
    expect(typeof client.browser.list).toBe('function');
    expect(typeof client.proxy.list).toBe('function');
    expect(typeof client.proxy.create).toBe('function');
    expect(typeof client.proxy.update).toBe('function');
    expect(typeof client.proxy.delete).toBe('function');
    expect(typeof client.proxy.check).toBe('function');
    expect(typeof client.proxy.test).toBe('function');
    expect(typeof client.diagnostics.run).toBe('function');
    expect(typeof client.adspower.userList).toBe('function');
    expect(typeof client.adspower.userCreate).toBe('function');
    expect(typeof client.adspower.userUpdate).toBe('function');
    expect(typeof client.adspower.userDelete).toBe('function');
    expect(typeof client.adspower.browserStart).toBe('function');
    expect(typeof client.adspower.browserStop).toBe('function');
    expect(typeof client.adspower.browserActive).toBe('function');
  });

  it('sdk-python models declare field subsets of corresponding OpenAPI schemas or client contract shapes', () => {
    const pythonContent = fs.readFileSync(pythonModelsPath, 'utf8');
    const lines = pythonContent.split(/\r?\n/);

    const parsedModels: Record<string, string[]> = {};
    let currentModel: string | null = null;

    for (const line of lines) {
      const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        currentModel = classMatch[1];
        parsedModels[currentModel] = [];
        continue;
      }
      if (currentModel) {
        const fieldMatch = line.match(/^\s{4}([a-zA-Z0-9_]+)\s*:\s*([^=\n]+)/);
        if (fieldMatch && fieldMatch[1] !== 'extra') {
          parsedModels[currentModel].push(fieldMatch[1]);
        }
      }
    }

    // 1. BrowserStartData / BrowserWsEndpoints vs BrowserStartResponse schema
    const browserStartSchema = spec.components?.schemas?.BrowserStartResponse?.properties?.data?.properties;
    expect(browserStartSchema).toBeDefined();
    const browserStartDataFields = parsedModels['BrowserStartData'];
    expect(browserStartDataFields).toBeDefined();
    // 'ws', 'pid', 'debug_port'
    for (const field of browserStartDataFields) {
      expect(Object.keys(browserStartSchema)).toContain(field);
    }

    const wsSchema = browserStartSchema.ws?.properties;
    expect(wsSchema).toBeDefined();
    const wsFields = parsedModels['BrowserWsEndpoints'];
    expect(wsFields).toBeDefined();
    for (const field of wsFields) {
      expect(Object.keys(wsSchema)).toContain(field);
    }

    // 2. ProfileItem (ProfileListItem-equivalent) vs CreateProfileRequest / UpdateProfileRequest
    // ProfileItem fields in python SDK: user_id, name, group_id, browser_type, proxy_id, created_at, updated_at
    const profileItemFields = parsedModels['ProfileItem'];
    expect(profileItemFields).toBeDefined();
    const createProfileProps = spec.components?.schemas?.CreateProfileRequest?.properties || {};
    const updateProfileProps = spec.components?.schemas?.UpdateProfileRequest?.properties || {};
    const unionProfileProps = [
      ...Object.keys(createProfileProps),
      ...Object.keys(updateProfileProps),
      'user_id',
      'created_at',
      'updated_at'
    ];
    for (const field of profileItemFields) {
      expect(unionProfileProps).toContain(field);
    }

    // 3. ProxyItem vs CreateProxyRequest schema
    // ProxyItem fields: type, host, port, proxy_id, id, username, password, name, status
    const proxyItemFields = parsedModels['ProxyItem'];
    expect(proxyItemFields).toBeDefined();
    const createProxyProps = spec.components?.schemas?.CreateProxyRequest?.properties || {};
    const knownProxyFields = [
      ...Object.keys(createProxyProps),
      'proxy_id',
      'id',
      'status'
    ];
    for (const field of proxyItemFields) {
      expect(knownProxyFields).toContain(field);
    }

    // 4. ProfileListResult vs ProfileListResponse
    const profileListResponseProps = spec.components?.schemas?.ProfileListResponse?.properties?.data?.properties || {};
    const profileListFields = parsedModels['ProfileListResult'];
    expect(profileListFields).toBeDefined();
    for (const field of profileListFields) {
      expect(Object.keys(profileListResponseProps)).toContain(field);
    }
  });
});
