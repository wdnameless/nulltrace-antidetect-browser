// Build a self-contained MCP bundle a user can hand to their AI agent.
//
// The reference product ships a tarball of sources and tells the user to run `npm install`
// with browser downloads skipped. That is a worse experience than it needs to be: the whole
// point of this button is "point your agent at this file and it works", and a step that can
// fail on a machine without a configured npm registry breaks that promise.
//
// This bundle therefore VENDORS its runtime dependencies — express and puppeteer-core are
// ~6 MB together — so the agent only needs a Node runtime. The app already ships one
// (`node.exe` beside the shell on Windows), and `node` is present on any machine a developer
// would run an agent on.
//
// Shape of the produced bundle:
//   <dir>/nulltrace-mcp/
//     index.js            entry point (stdio by default, HTTP when MCP_HTTP_PORT is set)
//     package.json        metadata; no install step required
//     README.md           what it is and the exact config to paste into an agent
//     node_modules/       vendored express + puppeteer-core + transitive deps
//     run.cmd / run.sh    convenience launchers with the env vars pre-filled
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

export interface McpBundleRequest {
  /** Directory the user chose; the bundle is written into `<dir>/nulltrace-mcp`. */
  targetDir: string;
  /** API origin the MCP server should talk to, e.g. http://127.0.0.1:50325. */
  apiUrl: string;
  /** Bearer token the API requires. */
  apiToken: string;
  /**
   * Privilege tier: `standard` hides the 12 destructive tools, `admin` exposes them.
   * Written into the generated config so the operator chooses once, at download time.
   */
  scope?: 'standard' | 'admin';
}

export interface McpBundleResult {
  ok: boolean;
  /** Absolute path of the bundle directory. */
  dir?: string;
  /** Absolute path of the zip archive, when one was produced. */
  zip?: string;
  bytes?: number;
  error?: string;
}

/** Where the compiled MCP server and its vendored deps live relative to the app root. */
function mcpSourceDir(appRoot: string): string | null {
  const candidates = [
    path.join(appRoot, 'mcp', 'dist', 'mcp', 'src'),
    path.join(__dirname, '..', '..', '..', 'mcp', 'dist', 'mcp', 'src'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.js'))) ?? null;
}

/** Runtime dependency roots to vendor, resolved from the app's own node_modules. */
function resolveNodeModulesRoots(appRoot: string): string[] {
  return [
    path.join(appRoot, 'dist', 'node_modules'),
    path.join(appRoot, 'node_modules'),
    path.join(__dirname, '..', '..', '..', 'node_modules'),
  ].filter((p) => fs.existsSync(p));
}

/**
 * Copies a package and everything it requires into the bundle.
 *
 * A flat copy is not enough: `express` pulls ~30 transitive packages, and a missing one
 * surfaces as a module-not-found at agent startup, far from this code. This walks the
 * dependency graph from each root package's package.json and copies what it finds.
 */
function vendorPackages(roots: string[], rootPackages: string[], outModules: string): string[] {
  const copied = new Set<string>();
  const queue = [...rootPackages];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (copied.has(name)) continue;
    const src = findPackageDir(roots, name);
    if (!src) continue;
    copied.add(name);
    const dest = path.join(outModules, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    // Follow the copied package's own dependencies.
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
        if (!copied.has(dep)) queue.push(dep);
      }
    } catch {
      // A package without a readable manifest has nothing further to follow.
    }
  }
  return [...copied];
}

/** Locates a package directory, handling scoped names (`@scope/pkg`). */
function findPackageDir(roots: string[], name: string): string | null {
  for (const root of roots) {
    const candidate = path.join(root, ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/** The README the user reads, and the config their agent needs. */
function bundleReadme(req: McpBundleRequest, nodeCmd: string): string {
  const scope = req.scope ?? 'standard';
  return `# NullTrace MCP server

Gives an AI agent control of this NullTrace instance: list, create, start and stop browser
profiles, drive the browser (navigate, click, type, screenshots), manage proxies, extensions,
flows and cookies.

## Requirements

- Node 18 or newer. \`node\` must be on PATH for your agent to spawn it, or use the
  \`run.cmd\` / \`run.sh\` launcher in this folder, which points at a known-good runtime.
- No \`npm install\` step: the dependencies are already vendored in \`node_modules/\`.

## Point your agent at it

The server speaks **stdio**, which is what desktop agent clients use. Paste this into the
client's MCP configuration (Claude Desktop: \`%APPDATA%\\Claude\\claude_desktop_config.json\`;
most other clients use the same shape):

\`\`\`json
{
  "mcpServers": {
    "nulltrace": {
      "command": "${nodeCmd}",
      "args": ["${path.join(req.targetDir, 'nulltrace-mcp', 'index.js')}"],
      "env": {
        "ANTIDETECT_API_URL": "${req.apiUrl}",
        "ANTIDETECT_API_TOKEN": "${req.apiToken}",
        "ANTIDETECT_MCP_SCOPE": "${scope}"
      }
    }
  }
}
\`\`\`

## What it can do

47 tools. Reads and safe actions:

- \`profiles.list\`, \`profiles.get\`, \`profiles.create\`, \`profiles.start\`, \`profiles.stop\`
- \`browser.navigate\`, \`browser.click\`, \`browser.type\`,
  \`browser.screenshot\`, \`browser.human_click\`, \`browser.human_type\`
- \`proxies.list\`, \`proxies.check\`, \`extensions.list\`, \`flows.run\`, \`tags.attach\`,
  \`task_groups.start\`, \`diagnostics.run\`

Privileged (only with \`ANTIDETECT_MCP_SCOPE=admin\`):

- \`profiles.delete\`, \`profiles.restore\`, \`triggers.delete\`, \`batch.delete\`,
  \`extensions.delete\`, \`proxies.delete\`, \`trash.delete_forever\`, and the import/export pair
  (\`cookies.export\`, \`cookies.import\`, \`browser.evaluate_allowlisted\`)
This bundle is set to **${scope}**.

## Token

The token in the config above is the API key of the running NullTrace instance. It changes
if the application's data folder is reset. Regenerate this bundle, or read the current key
from the app's Automation API panel, if calls start returning 401.
`.replace(/\$\{scope\}/g, scope);
}




/** Walks up from this module until it finds the directory holding `mcp/dist`. */
function findAppRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'mcp', 'dist'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the historical depth so a caller still gets a concrete error message from
  // the existence checks rather than silently bundling from the wrong place.
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function buildMcpBundle(req: McpBundleRequest): McpBundleResult {
  try {
    // Locate the app root by marker rather than by counting `..` levels: under vitest the
    // module is loaded from `src/`, in production from `dist/src/`, and the two need different
    // depths. Looking for `package.json` and `mcp/dist` finds the right root either way.
    const appRoot = findAppRoot();
    const source = mcpSourceDir(appRoot);
    if (!source) {
      return { ok: false, error: 'MCP server build not found (run `npm run build:mcp`).' };
    }
    const roots = resolveNodeModulesRoots(appRoot);
    if (roots.length === 0) {
      return { ok: false, error: 'Application node_modules not found; cannot vendor dependencies.' };
    }

    const outDir = path.join(req.targetDir, 'nulltrace-mcp');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    // Copy the compiled MCP tree AS BUILT, preserving `mcp/dist/...`.
    //
    // mcp/tsconfig.json sets `rootDir: ".."`, so the compiler emits both the server
    // (`mcp/dist/mcp/src/*.js`) AND the application modules it imports
    // (`mcp/dist/src/main/motion/*`, `.../fingerprints/*`). Those imports are relative
    // (`../../src/main/motion/seeds`), so flattening the output breaks them: an earlier
    // revision copied only `mcp/dist/mcp/src` and the bundle died at startup with
    // "Cannot find module '../../src/main/motion/seeds'".
    const mcpDist = path.join(appRoot, 'mcp', 'dist');
    if (!fs.existsSync(mcpDist)) {
      return { ok: false, error: 'MCP build output not found (run `npm run build:mcp`).' };
    }
    fs.cpSync(mcpDist, path.join(outDir, 'mcp', 'dist'), { recursive: true });

    // `@antidetect/sdk` is imported by tools.js and is a workspace package, so it does not
    // appear in mcp/package.json's dependency graph walk from express/puppeteer-core. Missing
    // it fails at agent startup with "Cannot find module '@antidetect/sdk'".

    vendorPackages(
      roots,
      [
        'express',
        'puppeteer-core',
        '@antidetect/sdk',
      ],
      path.join(outDir, 'node_modules'),
    );

    // A manifest so Node treats the folder as CommonJS regardless of any parent package.json,
    // and so the agent can see what it is.
    fs.writeFileSync(
      path.join(outDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'nulltrace-mcp',
          version: '1.0.0',
          private: true,
          type: 'commonjs',
          main: 'index.js',
          description: 'NullTrace MCP server — browser control for AI agents. Dependencies vendored; no install step.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    // The launcher knows the runtime that is known to work, so an agent whose PATH lacks
    // `node` still starts. Only written where the app actually ships one.
    const bundledNode = path.join(appRoot, 'node.exe');
    const nodeCmd = process.platform === 'win32' ? (fs.existsSync(bundledNode) ? bundledNode : 'node') : 'node';

    // A root-level entry so the user can point their agent at one obvious file.
    //
    // It deliberately does NOT `require()` the real entry: a copy would break that entry's own
    // relative requires (`./server`), and requiring the original leaves it idle, because it
    // runs its server only when `require.main === module` — the process then exits silently
    // and the agent sees a server that never answers. Passing through to the real file as the
    // MAIN module is what makes `require.main === module` true on the other side.
    fs.writeFileSync(
      path.join(outDir, 'index.js'),
      `#!/usr/bin/env node
// NullTrace MCP server entry point.
//
// Delegates to the compiled server under mcp/dist/, which must be the process's main module
// (it starts only when require.main === module). Spawning a child with stdio inherited keeps
// the JSON-RPC stream intact and leaves the agent talking to one obvious path.
const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn(process.execPath, [path.join(__dirname, 'mcp', 'dist', 'mcp', 'src', 'index.js')], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
`,
      'utf8',
    );

    fs.writeFileSync(path.join(outDir, 'README.md'), bundleReadme(req, nodeCmd), 'utf8');

    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(outDir, 'run.cmd'),
        `@echo off\r\nset "ANTIDETECT_API_URL=${req.apiUrl}"\r\nset "ANTIDETECT_API_TOKEN=${req.apiToken}"\r\nset "ANTIDETECT_MCP_SCOPE=${req.scope ?? 'standard'}"\r\n"${nodeCmd}" "%~dp0index.js" %*\r\n`,
        'utf8',
      );
    } else {
      const sh = path.join(outDir, 'run.sh');
      fs.writeFileSync(
        sh,
        `#!/bin/sh\nexport ANTIDETECT_API_URL="${req.apiUrl}"\nexport ANTIDETECT_API_TOKEN="${req.apiToken}"\nexport ANTIDETECT_MCP_SCOPE="${req.scope ?? 'standard'}"\nexec "${nodeCmd}" "$(dirname "$0")/index.js" "$@"\n`,
        'utf8',
      );
      fs.chmodSync(sh, 0o755);
    }

    // A zip beside the folder is what most users actually want: one file to move to another
    // machine, or to attach to a message.
    const zipPath = path.join(req.targetDir, 'nulltrace-mcp.zip');
    const zip = new AdmZip();
    zip.addLocalFolder(outDir, 'nulltrace-mcp');
    zip.writeZip(zipPath);

    return {
      ok: true,
      dir: outDir,
      zip: zipPath,
      bytes: fs.statSync(zipPath).size,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
