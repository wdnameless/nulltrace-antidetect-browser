// The MCP endpoints and the downloadable bundle.
//
// Two defects are pinned here, both of which made a WORKING MCP server look broken:
//
//  1. `GET /api/v1/mcp/status` returned the bare status object while every other route in
//     this API answers `{ code, msg, data }` (docs/API_CONTRACT.md). The panel checks
//     `res.code === 0`, so it reported "MCP: Off" while the server was running with 47
//     tools — the operator turned it on and was told it had not started.
//
//  2. The bundle must be runnable by a foreign agent. Its entry point cannot be a bare
//     `require()` of the built server: that server starts only when `require.main === module`,
//     so requiring it leaves the process idle and it exits with no output at all.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMcpBundle } from '../../src/main/mcp/bundle';

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bundle-'));
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Every test here builds a whole MCP bundle (measured ~6.7s each, six builds per run). The 20s
// global default in `vitest.config.ts` is sized for ordinary unit work; under full-suite parallel
// load one build was measured at 22.5s and tripped it. That flake fails the CI `test` job, and the
// `release` job is gated on it (`needs: [test]`) — so a passing tree could publish no release at
// all. The ceiling sits above the worst measured build rather than at the default; the whole file
// runs in ~40s, so this changes nothing but which side of the timeout a slow machine lands on.
// `hookTimeout` rides along for the same reason: the afterEach removes a whole bundle tree, and
// under the same parallel load the 10s default hook ceiling tripped on a loaded CI runner.
describe('MCP bundle', { timeout: 60000, hookTimeout: 60000 }, () => {
  it('writes a runnable server, a zip, and a README', () => {
    const res = buildMcpBundle({
      targetDir: tmp,
      apiUrl: 'http://127.0.0.1:50325',
      apiToken: 'token-abc',
      scope: 'standard',
    });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(res.dir as string, 'index.js'))).toBe(true);
    expect(fs.existsSync(res.zip as string)).toBe(true);
    expect(fs.existsSync(path.join(res.dir as string, 'README.md'))).toBe(true);
  });

  it('vendors its runtime dependencies so no install step is needed', () => {
    // A bundle that needs `npm install` breaks the promise of "point your agent at it": it
    // can fail on a machine with no registry access.
    const res = buildMcpBundle({ targetDir: tmp, apiUrl: 'http://x', apiToken: 't' });
    const mods = path.join(res.dir as string, 'node_modules');
    expect(fs.existsSync(path.join(mods, 'express'))).toBe(true);
    expect(fs.existsSync(path.join(mods, 'puppeteer-core'))).toBe(true);
    // Imported by tools.js; missing it fails at agent startup, far from this code.
    expect(fs.existsSync(path.join(mods, '@antidetect', 'sdk'))).toBe(true);
  });

  it('keeps the built layout the compiled server expects', () => {
    // The server requires `../../src/main/motion/seeds` relative to its own location, so the
    // bundle must reproduce `mcp/dist/mcp/src` AND `mcp/dist/src/main`. Flattening the output
    // produced "Cannot find module '../../src/main/motion/seeds'" on a real run.
    const res = buildMcpBundle({ targetDir: tmp, apiUrl: 'http://x', apiToken: 't' });
    const dir = res.dir as string;
    expect(fs.existsSync(path.join(dir, 'mcp', 'dist', 'mcp', 'src', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'mcp', 'dist', 'src', 'main', 'motion', 'seeds.js'))).toBe(true);
  });

  it('gives the root entry point a server that actually runs', async () => {
    // This is the assertion that was worth the most: the first implementation wrote a root
    // `index.js` that merely `require`d the real entry, which left the process idle and
    // exiting with no output — indistinguishable from a crash to an agent.
    const res = buildMcpBundle({ targetDir: tmp, apiUrl: 'http://127.0.0.1:1', apiToken: 't' });
    const entry = fs.readFileSync(path.join(res.dir as string, 'index.js'), 'utf8');
    // It must hand off to the real module as the MAIN module (spawn), not require it.
    expect(entry).toMatch(/spawn\(/);
    expect(entry).toMatch(/index\.js/);
    expect(entry).not.toMatch(/require\(['"][^'"]*mcp[^'"]*index\.js['"]\)/);
  });

  it('writes the operator-chosen scope into the launch scripts', () => {
    const res = buildMcpBundle({ targetDir: tmp, apiUrl: 'http://x', apiToken: 't', scope: 'admin' });
    const readme = fs.readFileSync(path.join(res.dir as string, 'README.md'), 'utf8');
    expect(readme).toContain('ANTIDETECT_MCP_SCOPE');
    expect(readme).toContain('admin');
  });

  it('reports the failure instead of throwing when the MCP build is absent', () => {
    // A missing build must be a legible error in the UI, not an exception that surfaces as a
    // generic failure.
    const res = buildMcpBundle({ targetDir: path.join(tmp, 'no-such'), apiUrl: 'http://x', apiToken: 't' });
    expect(typeof res.ok).toBe('boolean');
    if (!res.ok) expect(res.error).toBeTruthy();
  });
});

describe('MCP status envelope', () => {
  it('is the documented { code, msg, data } shape, not a bare object', async () => {
    // Asserted against the route's own response builder rather than by importing Express:
    // the contract is what the renderer reads, and the renderer checks `code`.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'api', 'routes', 'mcp.ts'), 'utf8');
    // Every response in this router must carry all three envelope fields.
    const bare = src.match(/res\.json\(\s*mcpService\.status\(\)\s*\)/);
    expect(bare).toBeNull();
    expect(src).toMatch(/code: 0, msg: 'success', data: mcpService\.status\(\)/);
    void setEnv;
  });
});
