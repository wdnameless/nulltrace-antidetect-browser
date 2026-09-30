// Phase-1 feedback loop for the macOS SIGTRAP backend crash (v0.6.21).
//
// The symptom on the teammate's machine: the shell spawns the vendored Node sidecar, the child
// dies with signal 5 (SIGTRAP) before printing the readiness line, stderr is EMPTY. A trap with
// no output means the death happens in native code before (or without) any JS running — so the
// loop discriminates in order: (1) is the node binary itself alive, (2) does trivial JS run,
// (3) does the real backend entry run with the shell's env. The first FAILING step is the fact;
// everything after it is not run.
//
// Exits 0 only when every step passes; a nonzero exit names the guilty layer. No mocks, no stubs:
// it runs the published bytes (downloaded release asset) exactly as the shell would spawn them.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const appRoot = process.argv[2]; // folder holding NullTrace.app (the portable layout root)
const port = Number(process.argv[3] ?? '55331');
let failures = 0;

function verdict(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`DIAG ${name}: ${ok ? 'PASS' : 'FAIL'} — ${detail}`);
}

function sh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, ...opts });
  return { status: r.status, signal: r.signal, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function runNode(bin, args, opts = {}, ms = 20000) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); }, ms);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, signal: null, out, err, spawnError: String(e) }); });
    p.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, out, err }); });
  });
}

const app = path.join(appRoot, 'NullTrace.app');
const macosDir = path.join(app, 'Contents', 'MacOS');
const resDir = path.join(app, 'Contents', 'Resources');
const nodeBin = path.join(macosDir, 'node');
const entry = path.join(resDir, 'dist', 'src', 'main', 'index.js');

// --- step 0: the host ---------------------------------------------------------------
const uname = sh('uname', ['-m']);
const pagesize = sh('sysctl', ['-n', 'hw.pagesize']);
const translated = sh('sysctl', ['-n', 'sysctl.proc_translated']);
const swvers = sh('sw_vers', ['-productVersion']);
console.log(`DIAG-HOST uname=${uname.out} pagesize=${pagesize.out} translated=${translated.out || '0'} macos=${swvers.out}`);

// --- step 1: the binary --------------------------------------------------------------
verdict('node-binary-exists', existsSync(nodeBin), nodeBin);
const lipo = sh('lipo', ['-archs', nodeBin]);
verdict('node-arch', /arm64/.test(lipo.out) && !/x86_64/.test(lipo.out), `lipo: ${lipo.out || '(failed)'}`);
const csVerify = sh('codesign', ['--verify', '--strict', nodeBin]);
const csInfo = sh('codesign', ['-dv', nodeBin]);
const adhoc = /Signature=adhoc|Authority=(not bound|\(adhoc\))/.test(csInfo.err + csInfo.out);
verdict('node-signature', csVerify.status === 0, `verify=${csVerify.status} ${adhoc ? 'ad-hoc' : csInfo.err.split('\n')[0] || ''}`.trim());

// --- step 2: the binary runs at all ----------------------------------------------------
const v = await runNode(nodeBin, ['--version'], {}, 20000);
verdict('node-starts', v.code === 0, v.spawnError ?? `exit=${v.code} signal=${v.signal} stderr=${v.err.slice(0, 200) || '(empty)'}`);
if (v.signal) { console.log(`DIAG-RESULT: BINARY — vendored node traps on its own (signal ${v.signal}). Nothing in our code runs.`); process.exit(1); }

// --- step 3: trivial JS ----------------------------------------------------------------
const t = await runNode(nodeBin, ['-e', 'console.log("DIAG-ALIVE")'], {}, 20000);
verdict('node-runs-js', t.code === 0 && t.out.includes('DIAG-ALIVE'), t.signal ? `signal=${t.signal} stderr=${t.err.slice(0, 200) || '(empty)'}` : `exit=${t.code}`);
if (t.signal) { console.log(`DIAG-RESULT: V8 — JS itself traps (signal ${t.signal}). Runtime/JIT issue, not our entry point.`); process.exit(1); }

// --- step 4: the real backend with the shell's env ---------------------------------------
const dataDir = path.join(appRoot, 'diag-data');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const env = {
  ...process.env,
  API_PORT: String(port),
  API_HOST: '127.0.0.1',
  ANTIDETECT_SETTINGS_DIR: path.join(dataDir, 'settings'),
  ANTIDETECT_DATA_DIR: path.join(dataDir, 'data'),
  ANTIDETECT_APP_VERSION: '0.0.0-diag',
  ANTIDETECT_TARGET_RESOURCES_DIR: resDir,
  NODE_PATH: [path.join(resDir, 'node_modules'), path.join(resDir, 'dist', 'node_modules')].join(':'),
};
mkdirSync(env.ANTIDETECT_SETTINGS_DIR, { recursive: true });
const b = await runNode(nodeBin, [entry], { env, cwd: dataDir }, 60000);
const sawReady = b.out.includes('[antidetect] Local API listening on');
const firstOut = b.out.split('\n').filter(Boolean).slice(0, 8).join(' | ').slice(0, 400);
const firstErr = b.err.split('\n').filter(Boolean).slice(0, 8).join(' | ').slice(0, 400);
verdict('backend-readiness-line', sawReady, `exit=${b.code} signal=${b.signal} stdout=[${firstOut || '(empty)'}] stderr=[${firstErr || '(empty)'}]`);
if (!sawReady) {
  console.log(`DIAG-RESULT: BACKEND — node and V8 are healthy; the shipped entry dies (exit=${b.code} signal=${b.signal}). See stdout/stderr above.`);
  process.exit(1);
}
console.log('DIAG-RESULT: HEALTHY — the published bytes start and signal readiness.');
