import { describe, it, expect } from 'vitest';
import {
  computeCssScale,
  computeCssClip,
  type ClipRect,
} from '../../../src/main/automation/snapshot';

describe('cssScale helper — HiDPI 1:1 coordinate matching (tasks.md §1.3, R05)', () => {
  it('computes scale factor as 1 / devicePixelRatio', () => {
    // 1x standard display
    expect(computeCssScale(1)).toBe(1);

    // 2x Retina / HiDPI display
    expect(computeCssScale(2)).toBe(0.5);

    // 3x high density display
    expect(computeCssScale(3)).toBeCloseTo(0.3333333333333333, 5);

    // 1.5x fractional scale display
    expect(computeCssScale(1.5)).toBeCloseTo(0.6666666666666666, 5);

    // 1.25x scale
    expect(computeCssScale(1.25)).toBe(0.8);
  });

  it('handles invalid or non-positive devicePixelRatio safely by defaulting to 1', () => {
    expect(computeCssScale(0)).toBe(1);
    expect(computeCssScale(-1)).toBe(1);
    expect(computeCssScale(NaN)).toBe(1);
    expect(computeCssScale(Infinity)).toBe(1);
  });

  it('adjusts clip rectangle with scale factor', () => {
    const originalClip: ClipRect = {
      x: 100,
      y: 200,
      width: 400,
      height: 300,
    };

    const scaledOn2x = computeCssClip(originalClip, 2);
    expect(scaledOn2x).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 300,
      scale: 0.5,
    });

    const scaledOn1x = computeCssClip(originalClip, 1);
    expect(scaledOn1x).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 300,
      scale: 1,
    });
  });
});
