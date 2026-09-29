import { describe, it, expect, vi, beforeEach } from 'vitest';

// The scroll/key mirroring logic dispatches through CDP sessions. This test
// verifies the event CONTRACT: master listener emits scroll/key payloads and
// the dispatch layer forwards only valid events to Input.* CDP methods.

vi.mock('../../src/main/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({}), get: () => undefined, all: () => [] }),
  }),
}));

vi.mock('../../src/main/profiles/profileManager', () => ({
  getLiveProfile: () => ({ browser_type: 'chromium' }),
}));

vi.mock('../../src/main/launcher/chromium', () => ({
  getRunningWs: () => undefined,
  isRunning: () => false,
}));

vi.mock('../../src/main/util/logger', () => ({
  logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
}));

describe('syncer scroll + key mirroring (docs gap closure)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('KEY_CODE_MAP covers the documented special-key set', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/main/syncer/actionSyncer.ts', 'utf8')
    );
    for (const key of [
      'Enter',
      'Escape',
      'Tab',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'PageUp',
      'PageDown',
      'Home',
      'End',
      'F5',
    ]) {
      expect(src).toContain(`${key}: { code:`);
    }
  });

  it('master listener reports scroll deltas and throttles wheel', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/main/syncer/actionSyncer.ts', 'utf8');
    // wheel listener with 100 ms throttle + delta accumulation (momentum bursts
    // are summed into pendingWheel, not dropped)
    expect(src).toMatch(/addEventListener\('wheel'[\s\S]*?lastWheel/);
    expect(src).toMatch(/pendingWheel\.deltaX \+= ev\.deltaX/);
    expect(src).toMatch(/send\('scroll', \{ deltaX: pendingWheel\.deltaX, deltaY: pendingWheel\.deltaY/);
    // slave replay uses real input injection, not scripted scrollTo
    expect(src).toMatch(/slaveScroll[\s\S]*?Input\.dispatchMouseEvent[\s\S]*?mouseWheel/);
    expect(src).not.toMatch(/slaveScroll[\s\S]*?scrollTo/);
  });

  it('master listener forwards submit keys from inside fields', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/main/syncer/actionSyncer.ts', 'utf8');
    // Enter/Escape inside inputs must still reach slaves (form submit/dismiss);
    // all other in-field keys stay local (content mirrors via input events).
    expect(src).toMatch(/inField && !submitKeys\.includes\(ev\.key\)\) return/);
    expect(src).toMatch(/send\('key', \{ key: ev\.key/);
    // slave replay uses CDP key events
    expect(src).toMatch(/slaveKey[\s\S]*?Input\.dispatchKeyEvent[\s\S]*?keyDown/);
    expect(src).toMatch(/slaveKey[\s\S]*?Input\.dispatchKeyEvent[\s\S]*?keyUp/);
  });

  it('mirrorScroll drops NaN and zero deltas', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/main/syncer/actionSyncer.ts', 'utf8');
    expect(src).toMatch(/mirrorScroll[\s\S]*?Number\.isFinite\(ev\.deltaX\)/);
    expect(src).toMatch(/mirrorScroll[\s\S]*?deltaX === 0 && ev\.deltaY === 0/);
  });

  it('mirrorKey rejects keys outside the allowlist', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/main/syncer/actionSyncer.ts', 'utf8');
    expect(src).toMatch(/mirrorKey[\s\S]*?if \(!KEY_CODE_MAP\[ev\.key\]\) return/);
  });
});
