import puppeteer, { Browser, Page, KeyInput } from 'puppeteer-core';
import { AntidetectClient } from '@antidetect/sdk';
import { deriveMotorSeed } from '../../src/main/motion/seeds';
import { planGlide } from '../../src/main/motion/trajectory';
import { planTyping } from '../../src/main/motion/typing';

/** Stable non-cryptographic seed from a profile id string (FNV-1a). */
function hashStringToSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 2147483646) + 1;
}
export interface TabDesc {
  label: string;
  url: string;
  title?: string;
}

export interface DialogReceipt {
  type: string;
  message: string;
}

export interface ActionReceipt {
  ok: true;
  popups: Array<{ label: string }>;
  dialog: DialogReceipt | null;
}

interface DialogHandleLike {
  type?: () => string;
  message?: () => string;
  accept?: (promptText?: string) => Promise<void>;
  dismiss?: () => Promise<void>;
}

interface CDPSessionLike {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, handler: (payload: Record<string, unknown>) => void) => void;
}

interface ProfileTabState {
  pages: Map<string, Page>;
  nextPageNum: number;
  recentPopups: Array<{ label: string }>;
  pendingDialog: { type: string; message: string; handle?: DialogHandleLike } | null;
  cdpSession?: CDPSessionLike;
  armedDialogListener?: boolean;
}

export class BrowserDriver {
  private readonly client: AntidetectClient;
  private readonly browserCache: Map<string, Browser> = new Map();
  private readonly tabStates: Map<string, ProfileTabState> = new Map();

  constructor(client: AntidetectClient) {
    this.client = client;
  }

  private async getOrConnectBrowser(profileId: string): Promise<Browser> {
    const cached = this.browserCache.get(profileId);
    if (cached && cached.connected) {
      return cached;
    }

    // Check if profile is running, or start it
    let wsEndpoint: string | undefined;
    try {
      const activeResp = await this.client.browser.list({ page: 1, page_size: 100 });
      const activeProfiles = activeResp.data?.list || [];
      const found = activeProfiles.find((p: { user_id: string }) => p.user_id === profileId);
    } catch {
      // ignore check error, proceed to start
    }

    if (!wsEndpoint) {
      const startResp = await this.client.browser.start(profileId);
      const startData = startResp.data as { ws?: { puppeteer?: string }; debug_port?: number; port?: number; wsEndpoint?: string } | undefined;
      wsEndpoint = startData?.ws?.puppeteer || startData?.wsEndpoint;
      if (!wsEndpoint && (startData?.debug_port || startData?.port)) {
        const port = startData.debug_port || startData.port;
        wsEndpoint = `http://127.0.0.1:${port}`;
      }
    }
    if (!wsEndpoint) {
      throw new Error(`Failed to obtain CDP endpoint for profile ${profileId}`);
    }

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint.startsWith('ws') ? wsEndpoint : undefined,
      browserURL: !wsEndpoint.startsWith('ws') ? wsEndpoint : undefined,
    });

    this.browserCache.set(profileId, browser);
    return browser;
  }

  private async getActivePage(browser: Browser): Promise<Page> {
    const pages = await browser.pages();
    if (pages.length > 0) {
      return pages[0];
    }
    return await browser.newPage();
  }

  public async navigate(profileId: string, url: string): Promise<{ url: string; status: number | null }> {
    const browser = await this.getOrConnectBrowser(profileId);
    const page = await this.getActivePage(browser);
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return {
      url: page.url(),
      status: resp ? resp.status() : null,
    };
  }

  public async click(profileId: string, selector: string): Promise<{ clicked: boolean; selector: string }> {
    const browser = await this.getOrConnectBrowser(profileId);
    const page = await this.getActivePage(browser);
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.click(selector);
    return { clicked: true, selector };
  }

  public async type(profileId: string, selector: string, text: string): Promise<{ typed: boolean; selector: string }> {
    const browser = await this.getOrConnectBrowser(profileId);
    const page = await this.getActivePage(browser);
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.type(selector, text);
    return { typed: true, selector };
  }

  /**
   * Human typing via the Motion plan engine: per-key delays from the profile's
   * motor seed, optional typo + Backspace correction. Types in real time.
   */
  public async humanType(
    profileId: string,
    selector: string,
    text: string,
    allowTypos = false
  ): Promise<{ typed: boolean; selector: string; durationMs: number }> {
    const browser = await this.getOrConnectBrowser(profileId);
    const page = await this.getActivePage(browser);
    await page.waitForSelector(selector, { timeout: 10000 });
    const seed = deriveMotorSeed(hashStringToSeed(profileId));
    const plan = planTyping(text, seed, 1, allowTypos);
    await page.focus(selector);
    for (const key of plan.keys) {
      // withResolvers needs es2024 lib; mcp targets older ES — executor form required.
      await new Promise((resolve) => setTimeout(resolve, key.delayMs));
      if (key.type === 'down') {
        await page.keyboard.down(key.key as KeyInput);
      } else {
        await page.keyboard.up(key.key as KeyInput);
      }
    }
    return { typed: true, selector, durationMs: plan.durationMs };
  }

  /**
   * Human click via a Fitts-law glide from the current pointer position to the
   * element center, with seeded jitter along a bezier path.
   */
  public async humanClick(
    profileId: string,
    selector: string,
    targetWidth = 32
  ): Promise<{ clicked: boolean; selector: string; durationMs: number }> {
    const browser = await this.getOrConnectBrowser(profileId);
    const page = await this.getActivePage(browser);
    await page.waitForSelector(selector, { timeout: 10000 });
    const handle = await page.$(selector);
    if (!handle) {
      throw new Error(`humanClick: selector ${selector} not found`);
    }
    const box = await handle.boundingBox();
    if (!box) {
      throw new Error(`humanClick: selector ${selector} has no bounding box`);
    }
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const seed = deriveMotorSeed(hashStringToSeed(profileId));
    const from = { x: Math.max(0, to.x - 200), y: Math.max(0, to.y - 120) };
    const glide = planGlide(from, to, targetWidth, seed, 1);
    for (const move of glide.moves) {
      await page.mouse.move(move.x, move.y);
      if (move.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, move.delayMs));
      }
    }
    await page.mouse.down();
    await new Promise((resolve) => setTimeout(resolve, 60 + (seed % 40)));
    await page.mouse.up();
    return { clicked: true, selector, durationMs: glide.durationMs };
  }

  public async screenshot(profileId: string, fullPage: boolean = false): Promise<{ format: string; base64: string; sizeBytes: number }> {
    const browser = await this.getOrConnectBrowser(profileId);
    const page = await this.getActivePage(browser);
    const buffer = (await page.screenshot({
      fullPage,
      encoding: 'binary',
      type: 'png',
    })) as Buffer;

    const maxCap = 5 * 1024 * 1024; // 5MB cap
    if (buffer.length > maxCap) {
      throw new Error(`Screenshot size ${buffer.length} exceeds max allowed cap of ${maxCap} bytes`);
    }

    return {
      format: 'image/png',
      base64: buffer.toString('base64'),
      sizeBytes: buffer.length,
    };
  }

  public async evaluateAllowlisted(profileId: string, scriptCode: string, params: Record<string, unknown>): Promise<unknown> {
    const browser = await this.getOrConnectBrowser(profileId);
    const page = await this.getActivePage(browser);

    const result = await page.evaluate(
      (codeStr: string, paramObj: Record<string, unknown>) => {
        // Execute the allowlisted function template safely
        const fn = new Function(`return (${codeStr})`)();
        return fn(paramObj);
      },
      scriptCode,
      params
    );

    return result;
  }

  public async disconnect(profileId: string): Promise<void> {
    const cached = this.browserCache.get(profileId);
    if (cached) {
      try {
        await cached.disconnect();
      } catch {
        // ignore disconnect error
      }
      this.browserCache.delete(profileId);
    }
    this.tabStates.delete(profileId);
  }

  public async closeAll(): Promise<void> {
    for (const [id, browser] of this.browserCache.entries()) {
      try {
        await browser.disconnect();
      } catch {
        // ignore
      }
    }
    this.browserCache.clear();
    this.tabStates.clear();
  }

  private getOrCreateTabState(profileId: string): ProfileTabState {
    let state = this.tabStates.get(profileId);
    if (!state) {
      state = {
        pages: new Map(),
        nextPageNum: 1,
        recentPopups: [],
        pendingDialog: null,
        armedDialogListener: false,
      };
      this.tabStates.set(profileId, state);
    }
    return state;
  }

  private armConnectionListeners(profileId: string, browser: Browser, state: ProfileTabState): void {
    if (state.armedDialogListener) return;
    state.armedDialogListener = true;

    const eventTarget = browser as unknown as { on?: (event: string, listener: (arg: unknown) => void) => void };
    if (typeof eventTarget.on === 'function') {
      try {
        eventTarget.on('targetcreated', async (target: unknown) => {
          try {
            const targetObj = target as { type?: () => string; page?: () => Promise<Page | null> } | null;
            if (targetObj && typeof targetObj.type === 'function' && targetObj.type() === 'page' && typeof targetObj.page === 'function') {
              const p = await targetObj.page();
              if (p) {
                for (const existing of state.pages.values()) {
                  if (existing === p) return;
                }
                const newLabel = `p${++state.nextPageNum}`;
                state.pages.set(newLabel, p);
                state.recentPopups.push({ label: newLabel });
                this.attachPageListeners(state, p, newLabel);
              }
            }
          } catch {}
        });
      } catch {}
    }
  }

  private attachPageListeners(state: ProfileTabState, page: Page, _label: string): void {
    const eventPage = page as unknown as {
      on?: (event: string, listener: (arg: unknown) => void) => void;
      createCDPSession?: () => Promise<CDPSessionLike>;
    };
    if (!eventPage || typeof eventPage.on !== 'function') return;

    try {
      eventPage.on('popup', (popup: unknown) => {
        const nextLabel = `p${++state.nextPageNum}`;
        const popupPage = popup as Page;
        state.pages.set(nextLabel, popupPage);
        state.recentPopups.push({ label: nextLabel });
        this.attachPageListeners(state, popupPage, nextLabel);
      });
    } catch {}

    try {
      eventPage.on('dialog', (dialog: unknown) => {
        const d = dialog as DialogHandleLike | undefined;
        state.pendingDialog = {
          type: typeof d?.type === 'function' ? d.type() : 'alert',
          message: typeof d?.message === 'function' ? d.message() : '',
          handle: d,
        };
      });
    } catch {}

    if (typeof eventPage.createCDPSession === 'function') {
      try {
        void eventPage.createCDPSession().then(async (cdp) => {
          state.cdpSession = cdp;
          try {
            await cdp.send('Page.enable');
          } catch {}
          cdp.on('Page.javascriptDialogOpening', (evt: Record<string, unknown>) => {
            state.pendingDialog = {
              type: typeof evt.type === 'string' ? evt.type : 'alert',
              message: typeof evt.message === 'string' ? evt.message : '',
              handle: state.pendingDialog?.handle,
            };
          });
        }).catch(() => {});
      } catch {}
    }
  }

  public async getPageByLabel(profileId: string, label: string = 'p1'): Promise<Page> {
    const browser = await this.getOrConnectBrowser(profileId);
    const state = this.getOrCreateTabState(profileId);
    this.armConnectionListeners(profileId, browser, state);

    const existing = state.pages.get(label);
    if (existing) {
      const pageWithClose = existing as unknown as { isClosed?: () => boolean };
      if (typeof pageWithClose.isClosed === 'function' && pageWithClose.isClosed()) {
        state.pages.delete(label);
      } else {
        return existing;
      }
    }

    if (label === 'p1') {
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();
      state.pages.set('p1', page);
      this.attachPageListeners(state, page, 'p1');
      return page;
    }

    throw new Error(`Tab '${label}' not found for profile ${profileId}`);
  }

  public async listTabs(profileId: string): Promise<TabDesc[]> {
    const browser = await this.getOrConnectBrowser(profileId);
    const state = this.getOrCreateTabState(profileId);
    this.armConnectionListeners(profileId, browser, state);

    if (state.pages.size === 0) {
      await this.getPageByLabel(profileId, 'p1');
    }

    const tabs: TabDesc[] = [];
    for (const [label, page] of state.pages.entries()) {
      const pageWithClose = page as unknown as { isClosed?: () => boolean };
      if (typeof pageWithClose.isClosed === 'function' && pageWithClose.isClosed()) {
        state.pages.delete(label);
        continue;
      }
      const url = typeof page.url === 'function' ? page.url() : '';
      let title: string | undefined;
      if (typeof page.title === 'function') {
        try {
          title = await page.title();
        } catch {}
      }
      tabs.push({ label, url, title });
    }
    return tabs;
  }

  public async newPage(profileId: string): Promise<{ label: string }> {
    const browser = await this.getOrConnectBrowser(profileId);
    const state = this.getOrCreateTabState(profileId);
    this.armConnectionListeners(profileId, browser, state);

    const page = await browser.newPage();
    const label = `p${++state.nextPageNum}`;
    state.pages.set(label, page);
    this.attachPageListeners(state, page, label);
    return { label };
  }

  public async closePage(profileId: string, label: string): Promise<{ ok: true }> {
    const state = this.tabStates.get(profileId);
    if (state) {
      const page = state.pages.get(label);
      if (page) {
        if (typeof page.close === 'function') {
          try {
            await page.close();
          } catch {}
        }
        state.pages.delete(label);
      }
    }
    return { ok: true };
  }

  public async acceptDialog(profileId: string, promptText?: string): Promise<{ ok: true }> {
    const state = this.tabStates.get(profileId);
    if (state?.pendingDialog) {
      if (state.pendingDialog.handle && typeof state.pendingDialog.handle.accept === 'function') {
        try {
          await state.pendingDialog.handle.accept(promptText);
        } catch {}
      } else if (state.cdpSession && typeof state.cdpSession.send === 'function') {
        try {
          await state.cdpSession.send('Page.handleJavaScriptDialog', {
            accept: true,
            promptText: promptText !== undefined ? String(promptText) : undefined,
          });
        } catch {}
      }
      state.pendingDialog = null;
    }
    return { ok: true };
  }

  public async dismissDialog(profileId: string): Promise<{ ok: true }> {
    const state = this.tabStates.get(profileId);
    if (state?.pendingDialog) {
      if (state.pendingDialog.handle && typeof state.pendingDialog.handle.dismiss === 'function') {
        try {
          await state.pendingDialog.handle.dismiss();
        } catch {}
      } else if (state.cdpSession && typeof state.cdpSession.send === 'function') {
        try {
          await state.cdpSession.send('Page.handleJavaScriptDialog', {
            accept: false,
          });
        } catch {}
      }
      state.pendingDialog = null;
    }
    return { ok: true };
  }

  public getPendingReceipt(profileId: string): ActionReceipt {
    const state = this.tabStates.get(profileId);
    const receipt: ActionReceipt = {
      ok: true,
      popups: state ? [...state.recentPopups] : [],
      dialog: state?.pendingDialog ? { type: state.pendingDialog.type, message: state.pendingDialog.message } : null,
    };
    if (state) {
      state.recentPopups = [];
    }
    return receipt;
  }
}
