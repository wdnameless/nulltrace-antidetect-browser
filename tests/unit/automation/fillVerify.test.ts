import { describe, it, expect } from 'vitest';
import {
  classifyFillOutcome,
  fillOutcomeAccepted,
  verifyFillOutcome,
  READ_FILLED_VALUE_FN,
  FILL_VERIFICATION_ATTEMPTS,
  type FillOutcome,
} from '../../../src/main/automation/fillVerify';

describe('classifyFillOutcome — what the control kept after dispatch', () => {
  it('is exact when the value landed verbatim', () => {
    expect(classifyFillOutcome('', 'hello', 'hello', true, 'text')).toBe('exact');
    expect(classifyFillOutcome('', 'hello', 'hello', false, 'text')).toBe('exact');
  });

  it('is exact for append-mode when the expected value is contained', () => {
    // clearFirst=false means typing continues an existing value.
    expect(classifyFillOutcome('abc', 'de', 'abcde', false, 'text')).toBe('exact');
  });

  it('accepts numeric formatting differences as equivalent', () => {
    expect(classifyFillOutcome('', '1000', '1,000', true, 'number')).toBe('equivalent');
    // A text field that strips leading zeros reshapes the value; that is still
    // an acceptance (application formatting), not a dropped input.
    expect(fillOutcomeAccepted(classifyFillOutcome('', '007', '7', true, 'text'))).toBe(true);
  });

  it('detects a leftover value as appended rather than a silent failure', () => {
    // select-all did not take: the new text followed the old digits.
    expect(classifyFillOutcome('12', '34', '1234', true, 'text')).toBe('appended');
    expect(classifyFillOutcome('abc', 'de', 'abcde', true, 'text')).toBe('appended');
  });

  it('reports unchanged when nothing moved and transformed when the app reshaped it', () => {
    expect(classifyFillOutcome('abc', 'xyz', 'abc', true, 'text')).toBe('unchanged');
    expect(classifyFillOutcome('', 'hello', 'HELLO', true, 'text')).toBe('transformed');
  });

  it('treats accepted outcomes as final', () => {
    const accepted: FillOutcome[] = ['exact', 'equivalent', 'transformed'];
    const rejected: FillOutcome[] = ['appended', 'unchanged', 'unverified'];
    for (const o of accepted) expect(fillOutcomeAccepted(o)).toBe(true);
    for (const o of rejected) expect(fillOutcomeAccepted(o)).toBe(false);
  });
});

describe('verifyFillOutcome — read back until the reading settles', () => {
  const noSleep = async (): Promise<void> => {};

  it('returns an accepted outcome on the first read', async () => {
    const outcome = await verifyFillOutcome(async () => ({ actual: 'hello', type: 'text' }), '', 'hello', true, noSleep);
    expect(outcome).toBe('exact');
  });

  it('re-reads a rejection and reports it once two identical readings settle', async () => {
    let reads = 0;
    const outcome = await verifyFillOutcome(
      async () => {
        reads += 1;
        return { actual: '', type: 'text' };
      },
      '',
      'hello',
      true,
      noSleep
    );
    expect(outcome).toBe('unchanged');
    // Two identical rejections settle; it must not burn all attempts.
    expect(reads).toBe(2);
    expect(reads).toBeLessThan(FILL_VERIFICATION_ATTEMPTS);
  });

  it('keeps polling while readings still change', async () => {
    const readings = ['', 'h', 'he', 'hel', 'hello'];
    let i = 0;
    const outcome = await verifyFillOutcome(
      async () => ({ actual: readings[Math.min(i++, readings.length - 1)], type: 'text' }),
      '',
      'hello',
      true,
      noSleep
    );
    expect(outcome).toBe('exact');
  });

  it('reports unverified, never a failure, when the control cannot be read', async () => {
    expect(await verifyFillOutcome(async () => null, '', 'x', true, noSleep)).toBe('unverified');
    expect(
      await verifyFillOutcome(
        async () => {
          throw new Error('node detached');
        },
        '',
        'x',
        true,
        noSleep
      )
    ).toBe('unverified');
    expect(await verifyFillOutcome(async () => ({ error: 'element is not connected' }), '', 'x', true, noSleep)).toBe(
      'unverified'
    );
  });

  it('gives up after the attempt budget on a control that never settles', async () => {
    // Both readings are rejections (partial prefix, then unchanged), so the
    // loop must exhaust its budget instead of declaring success early.
    let n = 0;
    const outcome = await verifyFillOutcome(
      async () => ({ actual: n++ % 2 === 0 ? 'hel' : '', type: 'text' }),
      '',
      'hello',
      true,
      noSleep
    );
    expect(fillOutcomeAccepted(outcome)).toBe(false);
    expect(n).toBe(FILL_VERIFICATION_ATTEMPTS);
  });
});

describe('READ_FILLED_VALUE_FN', () => {
  it('reads value for input/textarea and innerText otherwise', () => {
    expect(READ_FILLED_VALUE_FN).toContain('this.value');
    expect(READ_FILLED_VALUE_FN).toContain('innerText');
    expect(READ_FILLED_VALUE_FN).toContain('isConnected');
    expect(READ_FILLED_VALUE_FN).toContain('this.type');
  });
});
