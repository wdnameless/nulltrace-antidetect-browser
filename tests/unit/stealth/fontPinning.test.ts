import { describe, it, expect } from 'vitest';
import * as vm from 'vm';
import { buildStealthScript, StealthOptions } from '../../../src/main/proxy/stealthInjection';
import { resolveFontConfig } from '../../../src/main/fingerprints/fonts';
import { getSyntheticVoicePool } from '../../../src/main/proxy/stealthNoise';

interface FontSandboxOptions {
  stealthOpts: StealthOptions;
  hostFonts?: string[];
}

/**
 * Metric model of a real browser:
 * - every family on the host machine has its own metric (host presence),
 * - every family the profile DECLARES has its own metric (declared presence),
 * - anything else resolves to the plain fallback metric (absent).
 */
const FALLBACK_METRIC = { width: 60, height: 15 };

function parseFontChain(fontStr: string): string[] {
  if (!fontStr) return [];
  return fontStr
    .split(',')
    .map((part) => {
      let trimmed = part.trim().replace(/^["']|["']$/g, '').trim();
      const m = trimmed.match(/(?:(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger|[0-9.]+(?:px|pt|em|rem|%))\s+)+(.+)$/i);
      if (m) trimmed = m[1].replace(/^["']|["']$/g, '').trim();
      return trimmed.toLowerCase();
    })
    .filter(Boolean);
}

function buildMetricTable(hostFonts: string[], declared: string[]): Map<string, { width: number; height: number }> {
  const table = new Map<string, { width: number; height: number }>();
  hostFonts.forEach((fam, i) => table.set(fam.toLowerCase().trim(), { width: 140 + i * 10, height: 20 + i }));
  declared.forEach((fam, i) => table.set(fam.toLowerCase().trim(), { width: 220 + i * 12, height: 24 + i }));
  return table;
}

function createFontSandbox(options: FontSandboxOptions) {
  const { stealthOpts, hostFonts = ['Segoe UI', 'Arial', 'Times New Roman'] } = options;
  const scriptContent = buildStealthScript(stealthOpts);
  const declaredFamilies = stealthOpts.fontList ?? [];

  const availableHostFonts = new Set(hostFonts.map((f) => f.toLowerCase().trim()));
  const metricTable = buildMetricTable(hostFonts, declaredFamilies);

  class MockDOMException extends Error {
    name: string;
    constructor(message: string, name: string) {
      super(message);
      this.name = name;
    }
  }

  class MockFontFaceSet {
    check(font: string): boolean {
      // Host-truthful: only fonts physically present on the host are available.
      return parseFontChain(font).some((fam) => availableHostFonts.has(fam));
    }
  }

  class MockTextMetrics {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  }

  class MockCanvasRenderingContext2D {
    font = '10px sans-serif';
    canvas: unknown = null;

    measureText(_text: string): MockTextMetrics {
      // First family in the chain that has an entry answers with its metric.
      for (const fam of parseFontChain(this.font)) {
        const metric = metricTable.get(fam);
        if (metric) return new MockTextMetrics(metric.width, metric.height);
      }
      return new MockTextMetrics(FALLBACK_METRIC.width, FALLBACK_METRIC.height);
    }
  }

  class MockHTMLCanvasElement {
    private _ctx = new MockCanvasRenderingContext2D();
    constructor() {
      this._ctx.canvas = this;
    }
    getContext(type: string) {
      if (type === '2d') return this._ctx;
      return null;
    }
  }

  class MockOffscreenCanvasRenderingContext2D {
    font = '10px sans-serif';
    canvas: unknown = null;

    measureText(_text: string): MockTextMetrics {
      for (const fam of parseFontChain(this.font)) {
        const metric = metricTable.get(fam);
        if (metric) return new MockTextMetrics(metric.width, metric.height);
      }
      return new MockTextMetrics(FALLBACK_METRIC.width, FALLBACK_METRIC.height);
    }
  }

  class MockOffscreenCanvas {
    private _ctx = new MockOffscreenCanvasRenderingContext2D();
    constructor() {
      this._ctx.canvas = this;
    }
    getContext(type: string) {
      if (type === '2d') return this._ctx;
      return null;
    }
  }

  class MockCSSStyleDeclaration {
    fontFamily = '';
  }

  class MockHTMLElement {
    style = new MockCSSStyleDeclaration();

    get offsetWidth(): number {
      for (const fam of parseFontChain(this.style.fontFamily)) {
        const metric = metricTable.get(fam);
        if (metric) return metric.width;
      }
      return FALLBACK_METRIC.width;
    }

    get offsetHeight(): number {
      for (const fam of parseFontChain(this.style.fontFamily)) {
        const metric = metricTable.get(fam);
        if (metric) return metric.height;
      }
      return FALLBACK_METRIC.height;
    }
  }

  const documentFonts = new MockFontFaceSet();
  const documentObj = {
    fonts: documentFonts,
    createElement(tag: string) {
      if (tag.toLowerCase() === 'canvas') return new MockHTMLCanvasElement();
      return new MockHTMLElement();
    },
  };

  const navigatorObj: Record<string, unknown> = {
    userAgent: 'Mozilla/5.0',
  };

  const sandbox: Record<string, unknown> = {
    window: {},
    document: documentObj,
    navigator: navigatorObj,
    FontFaceSet: MockFontFaceSet,
    CanvasRenderingContext2D: MockCanvasRenderingContext2D,
    HTMLCanvasElement: MockHTMLCanvasElement,
    OffscreenCanvasRenderingContext2D: MockOffscreenCanvasRenderingContext2D,
    OffscreenCanvas: MockOffscreenCanvas,
    HTMLElement: MockHTMLElement,
    DOMException: MockDOMException,
    speechSynthesis: {
      getVoices: () => [],
    },
    Function,
    Object,
    Array,
    String,
    RegExp,
    Set,
    Promise,
    // Stock Chrome exposes Local Font Access here; seed it with a surface that would
    // RESOLVE to the host's font list, so the test proves the script overrides it.
    queryLocalFonts: () => Promise.resolve(hostFonts.map((fam) => ({ family: fam }))),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(scriptContent, context);

  function createWorkerContext() {
    class WorkerFontFaceSet extends MockFontFaceSet {}
    class WorkerOffscreenCanvasRenderingContext2D extends MockOffscreenCanvasRenderingContext2D {}
    class WorkerOffscreenCanvas {
      private _ctx = new WorkerOffscreenCanvasRenderingContext2D();
      constructor() {
        this._ctx.canvas = this;
      }
      getContext(type: string) {
        if (type === '2d') return this._ctx;
        return null;
      }
    }
    const workerFonts = new WorkerFontFaceSet();
    const workerNavigator: Record<string, unknown> = {
      userAgent: 'Mozilla/5.0',
    };
    const workerSandbox: Record<string, unknown> = {
      self: {},
      navigator: workerNavigator,
      fonts: workerFonts,
      FontFaceSet: WorkerFontFaceSet,
      OffscreenCanvasRenderingContext2D: WorkerOffscreenCanvasRenderingContext2D,
      OffscreenCanvas: WorkerOffscreenCanvas,
      DOMException: MockDOMException,
      Function,
      Object,
      Array,
      String,
      RegExp,
      Set,
      Promise,
      queryLocalFonts: () => Promise.resolve(hostFonts.map((fam) => ({ family: fam }))),
    };
    workerSandbox.self = workerSandbox;
    const workerContext = vm.createContext(workerSandbox);
    vm.runInContext(scriptContent, workerContext);
    return { workerContext, workerSandbox, workerFonts, workerNavigator };
  }

  return { context, sandbox, scriptContent, documentFonts, documentObj, navigatorObj, createWorkerContext };
}

describe('Font Pinning & Enumeration Cloaking', () => {
  describe('Requirement: Host fonts are not observable', () => {
    it('hides Segoe UI via document.fonts.check and FontFaceSet.prototype.check on a macOS profile', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['SF Pro Text', 'Helvetica Neue', 'Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial', 'Calibri'],
      });

      const results = vm.runInContext(
        `(() => ({
          viaDocument: document.fonts.check('12px "Segoe UI"'),
          viaPrototype: FontFaceSet.prototype.check.call(document.fonts, '12px "Segoe UI"'),
          declaredAbsent: document.fonts.check('12px "Helvetica Neue"'),
          declaredAndHost: document.fonts.check('12px "Arial"'),
          unknown: document.fonts.check('12px "TotallyMadeUpFont"'),
        }))()`,
        context
      );

      // Host-only font must never report as available (raw host-truthful mock would say true).
      expect(results.viaDocument).toBe(false);
      expect(results.viaPrototype).toBe(false);
      // Declared-but-host-absent family reports as available.
      expect(results.declaredAbsent).toBe(true);
      // Declared and on the host stays available.
      expect(results.declaredAndHost).toBe(true);
      // An undeclared unknown stays unavailable.
      expect(results.unknown).toBe(false);
    });

    it('masks Segoe UI measurements so host presence is not leaked via canvas or element probes', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['SF Pro Text', 'Helvetica Neue', 'Helvetica', 'Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial', 'Calibri'],
      });

      const result = vm.runInContext(
        `(() => {
          const ctx = new CanvasRenderingContext2D();
          ctx.font = '16px "Segoe UI"';
          const canvasWidth = ctx.measureText('probe').width;
          const el = new HTMLElement();
          el.style.fontFamily = 'Segoe UI';
          return { canvasWidth, elWidth: el.offsetWidth, elHeight: el.offsetHeight };
        })()`,
        context
      );

      // Under this harness the host metric for Segoe UI is 140 wide / 20 tall. A page
      // probing it must not observe those host metrics.
      expect(result.canvasWidth).toBe(FALLBACK_METRIC.width); // absent answer, never the host's 140
      expect(result.canvasWidth).not.toBe(140);
      expect(result.elWidth).toBe(FALLBACK_METRIC.width);
      expect(result.elHeight).toBe(FALLBACK_METRIC.height);
      expect(result.elWidth).not.toBe(140);
      expect(result.elHeight).not.toBe(20);
    });

    it('does not report Calibri, Consolas, or Segoe UI available to a Linux-claiming profile', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'linux',
          fontList: ['DejaVu Sans', 'DejaVu Serif'],
        },
        hostFonts: ['Calibri', 'Consolas', 'Segoe UI'],
      });

      const results = vm.runInContext(
        `(() => ({
          calibri: document.fonts.check('12px "Calibri"'),
          consolas: document.fonts.check('12px "Consolas"'),
          segoe: document.fonts.check('12px "Segoe UI"'),
          declared: document.fonts.check('12px "DejaVu Sans"'),
        }))()`,
        context
      );

      // Raw host-truthful mock would report Calibri/Consolas/Segoe UI available (they are
      // on the host); the profile must hide all of them while keeping its own family.
      expect(results.calibri).toBe(false);
      expect(results.consolas).toBe(false);
      expect(results.segoe).toBe(false);
      expect(results.declared).toBe(true);
    });
  });

  describe('Requirement: Declared fonts measure as present', () => {
    it('measures a declared-but-host-absent family as present via measureText', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['SF Pro Text', 'Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial'],
      });

      const result = vm.runInContext(
        `(() => {
          const ctx = new CanvasRenderingContext2D();
          ctx.font = '12px "SF Pro Text", monospace';
          const declaredWidth = ctx.measureText('probe').width;
          ctx.font = '12px monospace';
          const monoWidth = ctx.measureText('probe').width;
          return { declaredWidth, monoWidth };
        })()`,
        context
      );

      // The standard presence probe: target family vs plain fallback must differ, and
      // must not equal the plain fallback measurement.
      expect(result.declaredWidth).not.toBe(result.monoWidth);
      expect(result.declaredWidth).not.toBe(FALLBACK_METRIC.width);
    });

    it('measures a declared-but-host-absent family as present via offsetWidth and offsetHeight', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['SF Pro Text', 'Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial'],
      });

      const result = vm.runInContext(
        `(() => {
          const el = new HTMLElement();
          el.style.fontFamily = 'SF Pro Text';
          const declaredW = el.offsetWidth;
          const declaredH = el.offsetHeight;
          el.style.fontFamily = 'monospace';
          return { declaredW, declaredH, monoW: el.offsetWidth, monoH: el.offsetHeight };
        })()`,
        context
      );

      expect(result.declaredW).not.toBe(result.monoW);
      expect(result.declaredH).not.toBe(result.monoH);
    });

    it('measures a family that is both declared and on the host as present, not as hidden', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial'],
      });

      const result = vm.runInContext(
        `(() => {
          const ctx = new CanvasRenderingContext2D();
          ctx.font = '12px "Arial", monospace';
          const arialWidth = ctx.measureText('probe').width;
          ctx.font = '12px monospace';
          const monoWidth = ctx.measureText('probe').width;
          return { arialWidth, monoWidth, check: document.fonts.check('12px "Arial"') };
        })()`,
        context
      );

      expect(result.check).toBe(true);
      expect(result.arialWidth).not.toBe(result.monoWidth);
    });

    it('measures a declared family deterministically across repeated calls', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['SF Pro Text'],
        },
        hostFonts: ['Segoe UI'],
      });

      const result = vm.runInContext(
        `(() => {
          const ctx = new CanvasRenderingContext2D();
          ctx.font = '14px "SF Pro Text", monospace';
          const w1 = ctx.measureText('Sample Text').width;
          const w2 = ctx.measureText('Sample Text').width;
          return { w1, w2, fontAfter: ctx.font };
        })()`,
        context
      );

      expect(result.w1).toBe(result.w2);
      // The measurement must not mutate the surface a page observes.
      expect(result.fontAfter).toBe('14px "SF Pro Text", monospace');
    });
  });

  describe('Requirement: Local font enumeration is not fabricated', () => {
    it('leaves navigator.fonts undefined, matching stock Chrome', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'windows',
          fontList: ['Segoe UI', 'Arial'],
        },
      });

      const result = vm.runInContext(
        `(() => ({ typeofFonts: typeof navigator.fonts, inNavigator: 'fonts' in navigator }))()`,
        context
      );

      expect(result.typeofFonts).toBe('undefined');
      expect(result.inNavigator).toBe(false);
    });

    it('window.queryLocalFonts rejects with NotAllowedError and never resolves to the inventory', async () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'windows',
          fontList: ['Segoe UI', 'Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial'],
      });

      // The harness pre-seeds window.queryLocalFonts with a function that WOULD resolve to
      // the host's font list. The script must override it so it rejects instead.
      const outcome = await vm.runInContext(
        `(() => {
          if (typeof window.queryLocalFonts !== 'function') {
            return { settled: 'missing', name: null };
          }
          return window.queryLocalFonts().then(
            () => ({ settled: 'resolved', name: null }),
            (err) => ({ settled: 'rejected', name: err && err.name })
          );
        })()`,
        context
      );

      expect(outcome.settled).toBe('rejected');
      expect(outcome.name).toBe('NotAllowedError');
    });
  });

  describe('Requirement: Profile-coherent font inventory', () => {
    it('returns a non-empty inventory and fallback face for windows, macos, and linux', () => {
      const platforms: Array<StealthOptions['logicalPlatform']> = ['windows', 'macos', 'linux', 'android', 'ios'];

      for (const platform of platforms) {
        const config = resolveFontConfig({
          logicalPlatform: platform,
          mobile: platform === 'android' || platform === 'ios',
        });

        expect(config.inventory.length).toBeGreaterThan(0);
        expect(config.fallbackFace).toBeTruthy();
      }
    });

    it('resolves Apple faces for macOS with no Windows fonts exposed', () => {
      const macConfig = resolveFontConfig({ logicalPlatform: 'macos', mobile: false });

      expect(macConfig.inventory).not.toContain('Segoe UI');
      expect(macConfig.inventory).not.toContain('Calibri');

      const appleFaces = macConfig.inventory.filter((f) =>
        ['SF Pro', 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', 'Avenir', 'Monaco', 'Geneva'].includes(f)
      );
      expect(appleFaces.length).toBeGreaterThan(0);

      expect(macConfig.hiddenHostFonts).toContain('Segoe UI');
      expect(macConfig.fallbackFace).toBe('Helvetica');
    });

    it('resolves different inventories for phone and desktop profiles', () => {
      const desktopConfig = resolveFontConfig({ logicalPlatform: 'windows', mobile: false });
      const androidConfig = resolveFontConfig({ logicalPlatform: 'android', mobile: true });

      expect(desktopConfig.inventory.length).toBeGreaterThan(0);
      expect(androidConfig.inventory.length).toBeGreaterThan(0);
      expect(androidConfig.inventory).not.toEqual(desktopConfig.inventory);
      expect(desktopConfig.inventory).toContain('Segoe UI');
      expect(androidConfig.inventory).not.toContain('Segoe UI');

      const iosConfig = resolveFontConfig({ logicalPlatform: 'ios', mobile: true });
      expect(iosConfig.inventory).not.toEqual(desktopConfig.inventory);
    });
  });

  describe('Requirement: Mixed fallback chains and Worker context parity', () => {
    it('drops hidden Segoe UI from mixed chains ("Segoe UI, SF Pro Text, monospace") so declared SF Pro Text answers across check, measureText, and offsetWidth/offsetHeight', () => {
      const { context } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['SF Pro Text', 'Helvetica Neue', 'Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial', 'Calibri'],
      });

      const result = vm.runInContext(
        `(() => {
          const checkMixed = document.fonts.check('12px "Segoe UI", "SF Pro Text", monospace');
          const checkProtoMixed = FontFaceSet.prototype.check.call(document.fonts, '12px "Segoe UI", "SF Pro Text", monospace');
          const checkHiddenOnlyChain = document.fonts.check('12px "Segoe UI", "TotallyMadeUpFont"');

          const ctx = new CanvasRenderingContext2D();
          ctx.font = '12px "Segoe UI", "SF Pro Text", monospace';
          const mixedWidth1 = ctx.measureText('probe').width;
          const mixedWidth2 = ctx.measureText('probe').width;
          const fontAfter = ctx.font;

          ctx.font = '12px "SF Pro Text", monospace';
          const directDeclaredWidth = ctx.measureText('probe').width;

          ctx.font = '12px monospace';
          const fallbackWidth = ctx.measureText('probe').width;

          const el = new HTMLElement();
          el.style.fontFamily = 'Segoe UI, SF Pro Text, monospace';
          const elMixedW = el.offsetWidth;
          const elMixedH = el.offsetHeight;
          const styleAfter = el.style.fontFamily;

          el.style.fontFamily = 'SF Pro Text, monospace';
          const elDeclaredW = el.offsetWidth;
          const elDeclaredH = el.offsetHeight;

          return {
            checkMixed,
            checkProtoMixed,
            checkHiddenOnlyChain,
            mixedWidth1,
            mixedWidth2,
            fontAfter,
            directDeclaredWidth,
            fallbackWidth,
            elMixedW,
            elMixedH,
            styleAfter,
            elDeclaredW,
            elDeclaredH,
          };
        })()`,
        context
      );

      expect(result.checkMixed).toBe(true);
      expect(result.checkProtoMixed).toBe(true);
      expect(result.checkHiddenOnlyChain).toBe(false);

      // Hidden Segoe UI (140) drops out; declared SF Pro Text (220) answers, distinct from fallback (60).
      expect(result.mixedWidth1).toBe(result.directDeclaredWidth);
      expect(result.mixedWidth1).toBe(result.mixedWidth2);
      expect(result.mixedWidth1).not.toBe(140);
      expect(result.mixedWidth1).not.toBe(result.fallbackWidth);
      expect(result.fontAfter).toBe('12px "Segoe UI", "SF Pro Text", monospace');

      expect(result.elMixedW).toBe(result.elDeclaredW);
      expect(result.elMixedH).toBe(result.elDeclaredH);
      expect(result.elMixedW).not.toBe(140);
      expect(result.elMixedW).not.toBe(FALLBACK_METRIC.width);
      expect(result.styleAfter).toBe('Segoe UI, SF Pro Text, monospace');
    });

    it('maintains main-thread vs worker parity across fonts.check, measureText, navigator.fonts, and queryLocalFonts', async () => {
      const { context, createWorkerContext } = createFontSandbox({
        stealthOpts: {
          mobile: false,
          logicalPlatform: 'macos',
          fontList: ['SF Pro Text', 'Helvetica Neue', 'Arial'],
        },
        hostFonts: ['Segoe UI', 'Arial', 'Calibri'],
      });
      const { workerContext } = createWorkerContext();

      const mainSnap = await vm.runInContext(
        `(async () => {
          const ctx = new CanvasRenderingContext2D();
          const measure = (f) => {
            ctx.font = f;
            const w = ctx.measureText('parity-probe').width;
            return { w, fontAfter: ctx.font };
          };
          let qlf = 'resolved';
          try {
            await window.queryLocalFonts();
          } catch (e) {
            qlf = e && e.name;
          }
          return {
            checkHidden: document.fonts.check('12px "Segoe UI"'),
            checkDeclared: document.fonts.check('12px "SF Pro Text"'),
            checkMixed: document.fonts.check('12px "Segoe UI", "SF Pro Text", monospace'),
            checkUnknown: document.fonts.check('12px "NonExistentFace"'),
            mHidden: measure('12px "Segoe UI"'),
            mDeclared: measure('12px "SF Pro Text", monospace'),
            mMixed: measure('12px "Segoe UI", "SF Pro Text", monospace'),
            mFallback: measure('12px monospace'),
            hasNavFonts: 'fonts' in navigator || typeof navigator.fonts !== 'undefined',
            qlf,
          };
        })()`,
        context
      );

      const workerSnap = await vm.runInContext(
        `(async () => {
          const oc = new OffscreenCanvas(200, 50);
          const ctx = oc.getContext('2d');
          const measure = (f) => {
            ctx.font = f;
            const w = ctx.measureText('parity-probe').width;
            return { w, fontAfter: ctx.font };
          };
          let qlf = 'resolved';
          try {
            await self.queryLocalFonts();
          } catch (e) {
            qlf = e && e.name;
          }
          return {
            checkHidden: self.fonts.check('12px "Segoe UI"'),
            checkDeclared: self.fonts.check('12px "SF Pro Text"'),
            checkMixed: self.fonts.check('12px "Segoe UI", "SF Pro Text", monospace'),
            checkUnknown: self.fonts.check('12px "NonExistentFace"'),
            mHidden: measure('12px "Segoe UI"'),
            mDeclared: measure('12px "SF Pro Text", monospace'),
            mMixed: measure('12px "Segoe UI", "SF Pro Text", monospace'),
            mFallback: measure('12px monospace'),
            hasNavFonts: 'fonts' in self.navigator || typeof self.navigator.fonts !== 'undefined',
            qlf,
          };
        })()`,
        workerContext
      );

      expect(workerSnap).toEqual(mainSnap);
      expect(workerSnap.checkHidden).toBe(false);
      expect(workerSnap.checkDeclared).toBe(true);
      expect(workerSnap.checkMixed).toBe(true);
      expect(workerSnap.mHidden.w).toBe(FALLBACK_METRIC.width);
      expect(workerSnap.mMixed.w).toBe(workerSnap.mDeclared.w);
      expect(workerSnap.mMixed.w).not.toBe(workerSnap.mFallback.w);
      expect(workerSnap.hasNavFonts).toBe(false);
      expect(workerSnap.qlf).toBe('NotAllowedError');
    });

    it('enforces per-OS voice pool and font inventory coherence across windows, macos, linux, android, and ios', () => {
      const winVoices = getSyntheticVoicePool('windows', 'ru-RU');
      const macVoices = getSyntheticVoicePool('macos', 'ru-RU');
      const linuxVoices = getSyntheticVoicePool('linux', 'de-DE');
      const androidVoices = getSyntheticVoicePool('android', 'en-US');
      const iosVoices = getSyntheticVoicePool('ios', 'ru-RU');

      // Windows has Microsoft voices and never Apple voices
      expect(winVoices.some((v) => v.name.includes('Microsoft Irina'))).toBe(true);
      expect(winVoices.every((v) => !['Samantha', 'Alex', 'Milena'].includes(v.name))).toBe(true);

      // macOS and iOS have Apple voices and never Microsoft voices
      expect(macVoices.some((v) => v.name === 'Milena')).toBe(true);
      expect(macVoices.some((v) => v.name === 'Samantha')).toBe(true);
      expect(macVoices.every((v) => !v.name.includes('Microsoft'))).toBe(true);
      expect(iosVoices.some((v) => v.name === 'Milena')).toBe(true);
      expect(iosVoices.some((v) => v.name === 'Samantha')).toBe(true);
      expect(iosVoices.every((v) => !v.name.includes('Microsoft'))).toBe(true);

      // Linux and Android never leak Apple (Samantha/Alex) or Microsoft SAPI voices
      expect(linuxVoices.every((v) => !['Samantha', 'Alex', 'Fred', 'Victoria'].includes(v.name))).toBe(true);
      expect(linuxVoices.every((v) => !v.name.includes('Microsoft'))).toBe(true);
      expect(linuxVoices.some((v) => v.lang === 'de-DE')).toBe(true);

      expect(androidVoices.every((v) => !['Samantha', 'Alex', 'Fred', 'Victoria'].includes(v.name))).toBe(true);
      expect(androidVoices.every((v) => !v.name.includes('Microsoft'))).toBe(true);
      expect(androidVoices.length).toBeGreaterThan(0);
    });
  });
});
