import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { createContext, Script } from 'vm';

describe('Tauri bridge shape and renderer contract (tasks.md §6.4)', () => {
  const bridgePath = path.join(__dirname, '../../src-tauri/src/bridge.js');

  it('bridge.js file exists and contains valid JavaScript', () => {
    expect(fs.existsSync(bridgePath)).toBe(true);
    const code = fs.readFileSync(bridgePath, 'utf8');
    expect(code.length).toBeGreaterThan(0);
    expect(() => new Script(code)).not.toThrow();
  });

  function runBridgeInSandbox(globals: Record<string, unknown> = {}) {
    const code = fs.readFileSync(bridgePath, 'utf8');
    const sandbox: Record<string, unknown> = {
      window: {},
      console,
      setTimeout,
      clearTimeout,
      ...globals,
    };
    sandbox.window = sandbox;
    const context = createContext(sandbox);
    const script = new Script(code);
    script.runInContext(context);
    return sandbox as {
      window: {
        antidetect?: {
          getApiKey: () => Promise<unknown>;
          onUpdateStatus: () => void;
          openExternal: (url: string) => Promise<unknown>;
          _invoke: (cmd: string, args?: unknown) => Promise<unknown>;
          data?: {
            getDir: () => Promise<unknown>;
            setDir: () => Promise<unknown>;
            prepareDir: () => Promise<unknown>;
            migrateDir: () => Promise<unknown>;
            setDirPath: (p: string) => Promise<unknown>;
            openDir: () => Promise<unknown>;
          };
          logs?: {
            openDir: () => Promise<unknown>;
          };
          update?: {
            check: () => Promise<unknown>;
            download: () => Promise<unknown>;
            quitAndInstall: () => Promise<unknown>;
            onStatus: () => void;
          };
          window?: {
            minimize: () => Promise<unknown>;
            toggleMaximize: () => Promise<unknown>;
            close: () => Promise<unknown>;
          };
        };
      };
    };
  }

  it('declares exact window.antidetect namespace and all methods expected by renderer', () => {
    const sandbox = runBridgeInSandbox();
    const antidetect = sandbox.window.antidetect;
    expect(antidetect).toBeDefined();
    if (!antidetect) return;

    // Top-level methods
    expect(typeof antidetect.getApiKey).toBe('function');
    expect(typeof antidetect.onUpdateStatus).toBe('function');
    expect(typeof antidetect.openExternal).toBe('function');

    // .data namespace
    expect(antidetect.data).toBeDefined();
    expect(typeof antidetect.data?.getDir).toBe('function');
    expect(typeof antidetect.data?.setDir).toBe('function');
    expect(typeof antidetect.data?.prepareDir).toBe('function');
    expect(typeof antidetect.data?.migrateDir).toBe('function');
    expect(typeof antidetect.data?.setDirPath).toBe('function');
    expect(typeof antidetect.data?.openDir).toBe('function');

    // .logs namespace
    expect(antidetect.logs).toBeDefined();
    expect(typeof antidetect.logs?.openDir).toBe('function');

    // .update namespace
    expect(antidetect.update).toBeDefined();
    expect(typeof antidetect.update?.check).toBe('function');
    expect(typeof antidetect.update?.download).toBe('function');
    expect(typeof antidetect.update?.quitAndInstall).toBe('function');
    expect(typeof antidetect.update?.onStatus).toBe('function');

    // .window namespace — crucial: App.tsx:151 gates window buttons on window.antidetect.window
    expect(antidetect.window).toBeDefined();
    expect(typeof antidetect.window?.minimize).toBe('function');
    expect(typeof antidetect.window?.toggleMaximize).toBe('function');
    expect(typeof antidetect.window?.close).toBe('function');
  });

  it('prepareDir separates a cancel from a failed dialog', async () => {
    // The defect this pins: the renderer could not tell "the operator cancelled" from "the picker
    // is broken", so BOTH produced a `window.prompt()` asking for a typed path — the modal the
    // operator reported («это штуки быть не должно»). The two outcomes must stay distinguishable
    // through the bridge, because only a real failure deserves an error.
    const invokePick = async (impl: () => Promise<unknown>, cmd: string) => {
      const mockInvoke = vi.fn().mockImplementation(async (c: string) => {
        if (c === 'pick_directory') return impl();
        throw new Error(`unexpected command ${c}`);
      });
      const sandbox = runBridgeInSandbox({ __TAURI__: { core: { invoke: mockInvoke } } });
      void cmd;
      return sandbox.window.antidetect!.data!.prepareDir();
    };

    // Chosen folder.
    const chosen = (await invokePick(async () => ({ ok: true, path: 'D:\\out' }), 'chosen')) as {
      ok: boolean;
      canceled: boolean;
      dir: string;
    };
    expect(chosen.ok).toBe(true);
    expect(chosen.canceled).toBe(false);
    expect(chosen.dir).toBe('D:\\out');

    // Operator backed out: the shell resolves `Ok(None)` -> {ok:false}.
    const canceled = (await invokePick(async () => ({ ok: false, path: null }), 'cancel')) as {
      ok: boolean;
      canceled: boolean;
      error: string;
    };
    expect(canceled.ok).toBe(false);
    expect(canceled.canceled, 'a cancel must be marked as a cancel').toBe(true);
    expect(canceled.error).toBe('');

    // Dialog could not run: the command rejects (`Err` in `pick_directory`).
    const failed = (await invokePick(async () => {
      throw new Error('Dialog channel error: boom');
    }, 'fail')) as { ok: boolean; canceled: boolean; error: string };
    expect(failed.ok).toBe(false);
    expect(failed.canceled, 'a failure must NOT be reported as a cancel').toBe(false);
    expect(failed.error).toContain('Dialog channel error');
  });

  it('invoke routing reaches __TAURI__.core.invoke when present', async () => {
    const mockInvoke = vi.fn().mockResolvedValue('test-tauri-core');
    const sandbox = runBridgeInSandbox({
      __TAURI__: {
        core: { invoke: mockInvoke },
      },
    });

    const antidetect = sandbox.window.antidetect;
    expect(antidetect).toBeDefined();
    if (!antidetect) return;
    const res = await antidetect.getApiKey();
    expect(res).toBe('test-tauri-core');
    expect(mockInvoke).toHaveBeenCalledWith('get_api_key', undefined);
  });

  it('invoke routing reaches __TAURI_INTERNALS__.invoke when __TAURI__ is absent', async () => {
    const mockInvoke = vi.fn().mockResolvedValue('test-internals');
    const sandbox = runBridgeInSandbox({
      __TAURI_INTERNALS__: {
        invoke: mockInvoke,
      },
    });

    const antidetect = sandbox.window.antidetect;
    expect(antidetect).toBeDefined();
    if (!antidetect) return;
    const res = await antidetect.getApiKey();
    expect(res).toBe('test-internals');
    expect(mockInvoke).toHaveBeenCalledWith('get_api_key', undefined);
  });

  it('invoke routing rejects loudly when neither __TAURI__ nor __TAURI_INTERNALS__ is present', async () => {
    const sandbox = runBridgeInSandbox();
    const antidetect = sandbox.window.antidetect;
    expect(antidetect).toBeDefined();
    if (!antidetect) return;
    await expect(antidetect._invoke('get_api_key')).rejects.toThrow(/Tauri IPC invoke unavailable/);
  });

  it('window control methods route to correct Tauri commands', async () => {
    const mockInvoke = vi.fn().mockResolvedValue(undefined);
    const sandbox = runBridgeInSandbox({
      __TAURI_INTERNALS__: { invoke: mockInvoke },
    });

    const win = sandbox.window.antidetect?.window;
    expect(win).toBeDefined();
    if (!win) return;
    await win.minimize();
    expect(mockInvoke).toHaveBeenCalledWith('plugin:window|minimize', undefined);

    await win.toggleMaximize();
    expect(mockInvoke).toHaveBeenCalledWith('plugin:window|toggle_maximize', undefined);

    await win.close();
    expect(mockInvoke).toHaveBeenCalledWith('plugin:window|close', undefined);
  });

  it('openExternal routes to opener plugin (plugin:opener|open_url)', async () => {
    const mockInvoke = vi.fn().mockResolvedValue(undefined);
    const sandbox = runBridgeInSandbox({
      __TAURI_INTERNALS__: { invoke: mockInvoke },
    });

    await sandbox.window.antidetect?.openExternal('https://example.com');
    expect(mockInvoke).toHaveBeenCalledWith('open_path', { path: 'https://example.com' });
  });

  it('openAndroidWindow sends camelCase profileId (Tauri v2 renames args)', async () => {
    // Regression: bridge sent { profile_id } (snake_case) while Tauri v2 deserializes
    // command args as camelCase, so the invoke failed with
    // "missing required key profileId" and the Android window never opened.
    const mockInvoke = vi.fn().mockResolvedValue({ ok: true, error: null });
    const sandbox = runBridgeInSandbox({
      __TAURI_INTERNALS__: { invoke: mockInvoke },
    });

    const openAndroidWindow = (sandbox.window.antidetect as unknown as {
      openAndroidWindow: (id: string) => Promise<unknown>;
    })?.openAndroidWindow;
    expect(openAndroidWindow).toBeDefined();
    await openAndroidWindow('p_123');
    expect(mockInvoke).toHaveBeenCalledWith('open_android_window', { profileId: 'p_123' });
  });
  // The data namespace promises a flat {ok, dir} result while the backend answers the
  // standard {code, msg, data} envelope. Getting that translation wrong is invisible in
  // review and silent at runtime: reading `.dir` off the envelope made Settings show an
  // empty "Current folder" forever, and forcing `ok: true` over the response made a
  // refused migration report success. These pin the translation in both directions.
  describe('data namespace unwraps the response envelope', () => {
    const envelope = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, json: async () => body, status: 200, statusText: 'OK' });

    it('getDir returns data.dir, not the envelope', async () => {
      const sandbox = runBridgeInSandbox({ fetch: envelope({ code: 0, msg: 'success', data: { dir: 'D:\\NULLTRACE' } }) });
      await expect(sandbox.window.antidetect?.data?.getDir()).resolves.toBe('D:\\NULLTRACE');
    });

    it('getDir answers empty string when the folder is unknown, never the envelope', async () => {
      const sandbox = runBridgeInSandbox({ fetch: envelope({ code: 0, msg: 'success', data: {} }) });
      await expect(sandbox.window.antidetect?.data?.getDir()).resolves.toBe('');
    });

    it('setDirPath reports the directory the backend resolved, not the one it was handed', async () => {
      // The backend answers with its own resolved path; a trailing separator or a different
      // case must not be echoed back as if it were authoritative.
      const sandbox = runBridgeInSandbox({ fetch: envelope({ code: 0, msg: 'success', data: { ok: true, dir: 'E:\\DATA' } }) });
      await expect(sandbox.window.antidetect?.data?.setDirPath('E:\\DATA\\')).resolves.toMatchObject({ ok: true, dir: 'E:\\DATA' });
    });

    it('setDirPath reports failure instead of forcing ok:true over the response', async () => {
      const sandbox = runBridgeInSandbox({ fetch: envelope({ code: -1, msg: 'dir is required', data: { ok: false, dir: 'D:\\OLD' } }) });
      const res = (await sandbox.window.antidetect?.data?.setDirPath('')) as { ok: boolean; error?: string } | undefined;
      expect(res?.ok).toBe(false);
      expect(res?.error).toBeTruthy();
    });

    it('migrateDir carries the migrated flag and the resolved destination', async () => {
      const sandbox = runBridgeInSandbox({ fetch: envelope({ code: 0, msg: 'success', data: { ok: true, dir: 'F:\\VAULT', migrated: true } }) });
      await expect(sandbox.window.antidetect?.data?.migrateDir('F:\\VAULT', true)).resolves.toMatchObject({
        ok: true,
        dir: 'F:\\VAULT',
        migrated: true,
      });
    });

    it('migrateDir reports a refusal as a failure, not a silent success', async () => {
      const sandbox = runBridgeInSandbox({ fetch: envelope({ code: -1, msg: 'same or invalid folder', data: { ok: false, dir: 'D:\\CURRENT' } }) });
      const res = (await sandbox.window.antidetect?.data?.migrateDir('D:\\CURRENT', true)) as { ok: boolean; dir: string; error?: string } | undefined;
      expect(res?.ok).toBe(false);
      expect(res?.error).toContain('same or invalid folder');
    });
  });
});

describe('Tauri sidecar and capabilities assertions (tasks.md §6.2, §6.3)', () => {
  const sidecarRsPath = path.join(__dirname, '../../src-tauri/src/sidecar.rs');
  const remoteUiCapPath = path.join(__dirname, '../../src-tauri/capabilities/remote-ui.json');

  it('sidecar spawns service entry dist/src/main/index.js and NO code path can spawn dist/electron/main.js (§6.2)', () => {
    expect(fs.existsSync(sidecarRsPath)).toBe(true);
    const sidecarRs = fs.readFileSync(sidecarRsPath, 'utf8');

    // 1. Spawns packaged script or dist/src/main/index.js
    expect(sidecarRs).toContain('join("dist").join("src").join("main").join("index.js")');

    // 2. Explicitly assert NO electron entry path exists
    expect(sidecarRs).not.toContain('dist/electron/main.js');
    expect(sidecarRs).not.toContain('electron/main.js');
  });

  it('readiness signal is [antidetect] Local API listening on and OLD Server running at never appears (§6.2)', () => {
    const sidecarRs = fs.readFileSync(sidecarRsPath, 'utf8');

    // Real readiness signal
    expect(sidecarRs).toContain('[antidetect] Local API listening on');

    // Old superseded string was a bug and must not exist
    expect(sidecarRs).not.toContain('Server running at');
  });

  it('remote-ui capability targets main window and explicitly grants minimize, toggle-maximize, close (§6.3)', () => {
    expect(fs.existsSync(remoteUiCapPath)).toBe(true);
    const raw = fs.readFileSync(remoteUiCapPath, 'utf8');
    const cap = JSON.parse(raw) as {
      windows?: string[];
      remote?: { urls?: string[] };
      permissions?: string[];
    };

    // 1. targets main window
    expect(cap.windows).toBeDefined();
    expect(cap.windows).toContain('main');

    // 2. declares remote.urls matching served origin
    expect(cap.remote).toBeDefined();
    expect(cap.remote?.urls).toBeDefined();
    expect(cap.remote?.urls).toEqual(expect.arrayContaining([
      expect.stringMatching(/127\.0\.0\.1/),
      expect.stringMatching(/localhost/),
    ]));

    // 3. grants core:window:allow-minimize, core:window:allow-toggle-maximize, core:window:allow-close explicitly
    // This is required because core:window:default does NOT include them in Tauri v2
    expect(cap.permissions).toBeDefined();
    expect(cap.permissions).toContain('core:window:allow-minimize');
    expect(cap.permissions).toContain('core:window:allow-toggle-maximize');
    expect(cap.permissions).toContain('core:window:allow-close');
  });
});

describe('Renderer has no desktop-runtime dependency (supersedes tasks.md §6.4a)', () => {
  // §6.4a asserted `src/renderer/**` was byte-identical to the merge base. That was a
  // migration-time guard: it proved the Electron→Tauri switch needed no renderer edits,
  // which is why the browser-served UI kept working untouched. It has been discharged —
  // the renderer is now edited deliberately (the sidebar restructure, the local-auth gate),
  // so asserting it is untouched would forbid the work instead of protecting anything.
  //
  // The contract that still matters is the one that guard was protecting: the renderer must
  // work with NO Tauri bridge and NO Electron runtime, because it is also served to a plain
  // browser (the install-free path the docs advertise). That is what this asserts.
  const RENDERER_SRC = path.resolve(__dirname, '../../src/renderer/src');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
    });

  it('never imports a desktop-runtime module', () => {
    const offenders = walk(RENDERER_SRC).filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return /\bfrom\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)|from\s+['"]@tauri-apps\//.test(text);
    });
    expect(offenders, 'renderer must not import electron or a Tauri JS package').toEqual([]);
  });

  it('reaches the native bridge only through the optional window.antidetect object', () => {
    // Optional chaining is what makes the browser path work: no bridge ⇒ the calls are
    // skipped rather than throwing. A bare `window.antidetect.x` would break the browser build.
    const appTsx = fs.readFileSync(path.join(RENDERER_SRC, 'App.tsx'), 'utf8');
    expect(appTsx).toMatch(/window\.antidetect\?\./);
    expect(appTsx).toMatch(/hasNativeWindow/);
  });

  it('the frameless-window drag marker is an attribute Tauri can use, not Electron CSS', () => {
    // `-webkit-app-region: drag` is Electron-only; Tauri needs the HTML attribute.
    // Both may coexist (the CSS is harmless), but the attribute MUST be present on the topbar.
    const appTsx = fs.readFileSync(path.join(RENDERER_SRC, 'App.tsx'), 'utf8');
    expect(appTsx).toMatch(/className="topbar"[^>]*data-tauri-drag-region|data-tauri-drag-region[^>]*className="topbar"/);
  });
});

describe('Frameless window contract verification (tasks.md §6.1)', () => {
  // The window used to be declared in tauri.conf.json. It is now built in Rust, because
  // the shell needs `.initialization_script(...)` to install the `window.antidetect`
  // bridge — a config-declared window cannot carry that. Declaring it in BOTH places made
  // Tauri panic with `WebviewLabelAlreadyExists("main")`, so the config list is deliberately
  // empty and the builder in main.rs is the single owner. The contract is unchanged:
  // a frameless, resizable, 1280x800 window labelled `main`.
  const mainRs = fs.readFileSync(path.join(__dirname, '../../src-tauri/src/main.rs'), 'utf8');
  const tauriConfPath = path.join(__dirname, '../../src-tauri/tauri.conf.json');
  const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8')) as {
    app?: { windows?: Array<{ label?: string }> };
  };

  it('does not declare the main window twice (config list is empty)', () => {
    // A duplicate declaration panics at startup; this is the regression guard for that.
    const labels = (conf.app?.windows ?? []).map((w) => w.label);
    expect(labels).not.toContain('main');
  });

  it('builds a frameless, resizable main window in Rust', () => {
    expect(mainRs).toMatch(/WebviewWindowBuilder::new\(\s*&handle,\s*"main"/);
    expect(mainRs).toMatch(/\.decorations\(false\)/);
    expect(mainRs).toMatch(/\.inner_size\(1280\.0,\s*800\.0\)/);
    expect(mainRs).toMatch(/\.title\("NullTrace"\)/);
  });

  it('installs the native bridge as an initialization script', () => {
    // Without this the window has no `window.antidetect` and the UI silently loses
    // its window controls and Settings page.
    expect(mainRs).toMatch(/\.initialization_script\(\s*bridge_script\s*\)/);
    expect(mainRs).toMatch(/include_str!\("bridge\.js"\)/);
  });

  it('navigates the window at the serving backend once it is ready', () => {
    expect(mainRs).toMatch(/http:\/\/127\.0\.0\.1:\{api_port\}/);
    expect(mainRs).toMatch(/window\.navigate\(target_url\)/);
  });
});
