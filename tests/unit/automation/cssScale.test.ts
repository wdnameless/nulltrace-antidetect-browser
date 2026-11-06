import { describe, it, expect } from 'vitest';
import {
  computeCssScale,
  computeCssClip,
  buildCssClip,
  CSS_CLIP_PROBE,
  type ClipRect,
  type CssClipGeometry,
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

  it('builds viewport clip from scroll offset with css scale (ego-lite observe.ts)', () => {
    const g: CssClipGeometry = { w: 1280, h: 800, sx: 0, sy: 300, pw: 1280, ph: 2400, dpr: 2 };
    expect(buildCssClip(g, false)).toEqual({ x: 0, y: 300, width: 1280, height: 800, scale: 0.5 });
  });

  it('builds full-page clip from document origin with css scale', () => {
    const g: CssClipGeometry = { w: 1280, h: 800, sx: 0, sy: 300, pw: 1280, ph: 2400, dpr: 2 };
    expect(buildCssClip(g, true)).toEqual({ x: 0, y: 0, width: 1280, height: 2400, scale: 0.5 });
  });

  it('probes the geometry fields buildCssClip consumes', () => {
    for (const field of ['w:', 'h:', 'sx:', 'sy:', 'pw:', 'ph:', 'dpr:window.devicePixelRatio']) {
      expect(CSS_CLIP_PROBE).toContain(field);
    }
    expect(buildCssClip({ w: 100, h: 100, sx: 0, sy: 0, pw: 100, ph: 100, dpr: 0 }, false).scale).toBe(1);
  });
});
