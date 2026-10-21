import { describe, it, expect } from 'vitest';
import {
  splitAnnexBNals,
  buildAvcCDescription,
  codecStringFromConfig,
  annexBFrameToAvcC,
} from '../../src/renderer/src/androidStream';

// Live bytes captured from the android-34 google_apis guest (c2.android.avc.encoder):
// CONFIG (32 B): 00 00 00 01 67 42 c0 29 … 00 00 00 01 68 ce 01 a8 35 c8.
// The helpers are pure byte transforms (no WebSocket, no VideoDecoder), so they run in node.
const LIVE_CONFIG_HEX = '000000016742c0298d681a073e5e420202020f08846a0000000168ce01a835c8';
const liveConfig = (): Uint8Array => new Uint8Array(Buffer.from(LIVE_CONFIG_HEX, 'hex'));

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('Annex B to avcC helpers (Android stream decode)', () => {
  it('splits 3- and 4-byte start codes into bare NALs', () => {
    const nals = splitAnnexBNals(liveConfig());
    expect(nals).toHaveLength(2);
    expect(nals[0][0] & 0x1f).toBe(7); // SPS
    expect(nals[1][0] & 0x1f).toBe(8); // PPS
    expect(hex(nals[0]).startsWith('6742c029')).toBe(true);
    expect(hex(nals[1])).toBe('68ce01a835c8');
  });

  it('returns no NALs for a payload without start codes', () => {
    expect(splitAnnexBNals(new Uint8Array([0x67, 0x42, 0xc0]))).toHaveLength(0);
  });

  it('builds the exact avcC box the live CONFIG packet implies', () => {
    const avcC = buildAvcCDescription(liveConfig());
    expect(avcC).not.toBeNull();
    // 01 42 c0 29 FF E1 <spsLen=18> <sps> 01 <ppsLen=6> <pps>
    expect(hex(avcC!)).toBe(
      '0142c029ffe100126742c0298d681a073e5e420202020f08846a01000668ce01a835c8',
    );
  });

  it('returns null when no SPS is present', () => {
    const ppsOnly = new Uint8Array([0, 0, 0, 1, 0x68, 0xce, 0x01]);
    expect(buildAvcCDescription(ppsOnly)).toBeNull();
    expect(codecStringFromConfig(ppsOnly)).toBeNull();
  });

  it('derives avc1.42c029 from the live SPS', () => {
    expect(codecStringFromConfig(liveConfig())).toBe('avc1.42c029');
  });

  it('converts a frame to length-prefixed avcC NALs', () => {
    const frame = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0, 0, 1, 0x41, 0xcc]);
    const out = annexBFrameToAvcC(frame);
    expect(hex(out)).toBe('0000000365aabb0000000241cc');
  });

  it('passes through a payload with no start codes unchanged', () => {
    const raw = new Uint8Array([0x01, 0x02, 0x03]);
    expect(annexBFrameToAvcC(raw)).toBe(raw);
  });
});
