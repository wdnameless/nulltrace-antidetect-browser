/**
 * The wire format asserted here is scrcpy 2.4's own, taken from the server sources
 * (`Streamer.java`, `DesktopConnection.java`, `ControlMessage.java`, `ControlMessageReader.java`)
 * and confirmed against a booted android-34 `google_apis` guest running the pinned jar:
 * codec meta `68323634 00000198 00000390`, first frame `pts = 1 << 63` (CONFIG), `size = 32`.
 *
 * The previous version of this suite asserted a 12-byte header in FRONT of the codec metadata and
 * flags at bits 62/61. Both were wrong, and the suite locked the mistake in: the real stream
 * starts with the bare codec-meta prefix, and CONFIG/KEY_FRAME are bits 63/62.
 */
import { describe, it, expect } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ScrcpyParser,
  SCRCPY_CODEC_META_SIZE,
  SCRCPY_FRAME_HEADER_SIZE,
  SCRCPY_FLAG_CONFIG,
  SCRCPY_FLAG_KEY_FRAME,
  ScrcpyProtocolError,
  buildKeyMessage,
  buildKeyPressMessages,
  buildTouchMessage,
  buildScrollMessage,
  buildBackOrScreenOnMessage,
  buildScreenPowerMessage,
  buildRotateMessage,
  CONTROL_TYPE_KEYCODE,
  CONTROL_TYPE_TOUCH,
  CONTROL_TYPE_SCROLL,
  CONTROL_TYPE_BACK_OR_SCREEN_ON,
  CONTROL_TYPE_SCREEN_POWER,
  CONTROL_TYPE_ROTATE,
  KEYCODE_BACK,
  SCREEN_POWER_OFF,
} from '../../src/main/android/scrcpyProtocol';
import { resolveAdbPath, allocateEmulatorPorts, AdbError } from '../../src/main/android/adb';
import { AndroidStreamHost, type AndroidInstanceLike } from '../../src/main/android/streamHost';

const makeMeta = (width: number, height: number): Buffer => {
  const meta = Buffer.allocUnsafe(SCRCPY_CODEC_META_SIZE);
  meta.writeUInt32BE(0x68323634, 0);
  meta.writeUInt32BE(width, 4);
  meta.writeUInt32BE(height, 8);
  return meta;
};

const makeFrame = (pts: bigint, payload: Buffer, flags = 0n): Buffer => {
  const header = Buffer.allocUnsafe(SCRCPY_FRAME_HEADER_SIZE);
  header.writeBigUInt64BE(pts | flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
};

const CONFIG_PAYLOAD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x2a, 0x95, 0xa0]);
const KEY_PAYLOAD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x10, 0x20]);
const DELTA_PAYLOAD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x12, 0x34]);

/** Codec meta prefix, then CONFIG, key frame, delta — the order the guest actually emits. */
const buildStream = () =>
  Buffer.concat([
    makeMeta(1080, 1920),
    makeFrame(0n, CONFIG_PAYLOAD, SCRCPY_FLAG_CONFIG),
    makeFrame(200_000n, KEY_PAYLOAD, SCRCPY_FLAG_KEY_FRAME),
    makeFrame(233_333n, DELTA_PAYLOAD),
  ]);

describe('scrcpyProtocol', () => {
  it('reads the codec meta as a bare 12-byte prefix, not as a framed packet', () => {
    const parser = new ScrcpyParser({ expectCodecMeta: true });
    parser.feed(buildStream());

    expect(parser.codecMeta).toEqual({ codecId: 0x68323634, width: 1080, height: 1920 });
  });

  it('parses CONFIG / key / delta frames with flags at bits 63 and 62 (scrcpy 2.4)', () => {
    const parser = new ScrcpyParser({ expectCodecMeta: true });
    const packets = parser.feed(buildStream());

    expect(packets).toHaveLength(3);

    expect(packets[0].isConfig).toBe(true);
    expect(packets[0].isKeyFrame).toBe(false);
    expect(packets[0].pts).toBe(0n);
    expect(Buffer.compare(packets[0].payload, CONFIG_PAYLOAD)).toBe(0);

    expect(packets[1].isConfig).toBe(false);
    expect(packets[1].isKeyFrame).toBe(true);
    expect(packets[1].pts).toBe(200_000n);
    expect(Buffer.compare(packets[1].payload, KEY_PAYLOAD)).toBe(0);

    expect(packets[2].isConfig).toBe(false);
    expect(packets[2].isKeyFrame).toBe(false);
    expect(packets[2].pts).toBe(233_333n);
    expect(Buffer.compare(packets[2].payload, DELTA_PAYLOAD)).toBe(0);
  });

  it('produces identical packets when the stream arrives byte-by-byte', () => {
    const wholeParser = new ScrcpyParser({ expectCodecMeta: true });
    const wholePackets = wholeParser.feed(buildStream());

    const stream = buildStream();
    const byteParser = new ScrcpyParser({ expectCodecMeta: true });
    const bytePackets = [];
    for (let i = 0; i < stream.length; i++) {
      bytePackets.push(...byteParser.feed(stream.subarray(i, i + 1)));
    }

    expect(byteParser.codecMeta).toEqual(wholeParser.codecMeta);
    expect(bytePackets.map((p) => [p.pts, p.isConfig, p.isKeyFrame, p.size])).toEqual(
      wholePackets.map((p) => [p.pts, p.isConfig, p.isKeyFrame, p.size])
    );
  });

  it('handles a chunk split inside the codec-meta prefix without inventing a frame', () => {
    const stream = buildStream();
    const parser = new ScrcpyParser({ expectCodecMeta: true });

    expect(parser.feed(stream.subarray(0, 7))).toHaveLength(0);
    expect(parser.codecMeta).toBeNull();

    // 7 + 20 crosses the prefix and lands inside the CONFIG payload.
    const rest = parser.feed(stream.subarray(7, 27));
    expect(parser.codecMeta).toEqual({ codecId: 0x68323634, width: 1080, height: 1920 });
    expect(rest).toHaveLength(0);
  });

  it('rejects an absurd declared packet size rather than allocating gigabytes', () => {
    const parser = new ScrcpyParser({ expectCodecMeta: false });
    const hostileHeader = Buffer.allocUnsafe(SCRCPY_FRAME_HEADER_SIZE);
    hostileHeader.writeBigUInt64BE(1_000_000n, 0);
    hostileHeader.writeUInt32BE(100 * 1024 * 1024, 8);

    expect(() => parser.feed(hostileHeader)).toThrow(ScrcpyProtocolError);
    try {
      parser.feed(hostileHeader);
    } catch (err) {
      expect((err as ScrcpyProtocolError).code).toBe('ERR_SCRCPY_PACKET_TOO_LARGE');
    }
  });

  it('builds control messages in ControlMessageReader layouts', () => {
    // TYPE_INJECT_TOUCH_EVENT, type 2, 32 bytes:
    // [02][action][pointerId i64 = -1][x][y][w u16][h u16][pressure u16][actionButton][buttons]
    const touch = buildTouchMessage({ action: 0, x: 100, y: 200, screenW: 1080, screenH: 1920 });
    expect(touch.length).toBe(32);
    expect(touch.readUInt8(0)).toBe(CONTROL_TYPE_TOUCH);
    expect(touch.readUInt8(1)).toBe(0);
    expect(touch.readBigInt64BE(2)).toBe(-1n);
    expect(touch.readInt32BE(10)).toBe(100);
    expect(touch.readInt32BE(14)).toBe(200);
    expect(touch.readUInt16BE(18)).toBe(1080);
    expect(touch.readUInt16BE(20)).toBe(1920);
    expect(touch.readUInt16BE(22)).toBe(0xffff); // pressure 1.0 in u16 fixed point
    expect(touch.readInt32BE(24)).toBe(1); // BUTTON_PRIMARY

    // Release frame: pressure 0, no action button.
    const lift = buildTouchMessage({ action: 1, x: 100, y: 200, screenW: 1080, screenH: 1920 });
    expect(lift.readUInt16BE(22)).toBe(0);
    expect(lift.readInt32BE(24)).toBe(0);

    // TYPE_INJECT_SCROLL_EVENT, 21 bytes: [03][x][y][w u16][h u16][h i16][v i16][buttons i32]
    const scroll = buildScrollMessage({ x: 100, y: 200, screenW: 1080, screenH: 1920, vScroll: -1 });
    expect(scroll.length).toBe(21);
    expect(scroll.readUInt8(0)).toBe(CONTROL_TYPE_SCROLL);
    expect(scroll.readInt32BE(1)).toBe(100);
    expect(scroll.readInt32BE(5)).toBe(200);
    expect(scroll.readUInt16BE(9)).toBe(1080);
    expect(scroll.readUInt16BE(11)).toBe(1920);
    expect(scroll.readInt16BE(13)).toBe(0);
    expect(scroll.readInt16BE(15)).toBe(-0x8000); // -1.0 in i16 fixed point
    expect(scroll.readInt32BE(17)).toBe(0);

    // TYPE_INJECT_KEYCODE, 14 bytes: [00][action][keycode i32][repeat i32][metaState i32]
    const key = buildKeyMessage({ keycode: KEYCODE_BACK, action: 0 });
    expect(key.length).toBe(14);
    expect(key.readUInt8(0)).toBe(CONTROL_TYPE_KEYCODE);
    expect(key.readUInt8(1)).toBe(0);
    expect(key.readInt32BE(2)).toBe(KEYCODE_BACK);
    expect(key.readInt32BE(6)).toBe(0);
    expect(key.readInt32BE(10)).toBe(0);

    // A toolbar tap is press + release.
    const press = buildKeyPressMessages(KEYCODE_BACK);
    expect(press.length).toBe(28);
    expect(press.readUInt8(1)).toBe(0);
    expect(press.readUInt8(15)).toBe(1);

    // TYPE_BACK_OR_SCREEN_ON, 2 bytes.
    const back = buildBackOrScreenOnMessage(1);
    expect(back.toString('hex')).toBe(`${CONTROL_TYPE_BACK_OR_SCREEN_ON.toString(16).padStart(2, '0')}01`);

    // TYPE_SET_SCREEN_POWER_MODE, 2 bytes.
    const power = buildScreenPowerMessage(SCREEN_POWER_OFF);
    expect(power.length).toBe(2);
    expect(power.readUInt8(0)).toBe(CONTROL_TYPE_SCREEN_POWER);
    expect(power.readUInt8(1)).toBe(SCREEN_POWER_OFF);

    // TYPE_ROTATE_DEVICE, 1 byte.
    expect(buildRotateMessage()).toEqual(Buffer.from([CONTROL_TYPE_ROTATE]));
  });
});

describe('adb utilities', () => {
  it('resolveAdbPath finds executable in candidate locations or throws ERR_ANDROID_ADB_NOT_FOUND', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-test-'));
    try {
      expect(() => resolveAdbPath(tmpDir)).toThrow(AdbError);
      try {
        resolveAdbPath(tmpDir);
      } catch (err) {
        expect((err as AdbError).code).toBe('ERR_ANDROID_ADB_NOT_FOUND');
      }

      const exeName = process.platform === 'win32' ? 'adb.exe' : 'adb';
      const ptDir = path.join(tmpDir, 'platform-tools');
      fs.mkdirSync(ptDir, { recursive: true });
      const adbFake = path.join(ptDir, exeName);
      fs.writeFileSync(adbFake, '#!/bin/sh\nexit 0');

      expect(resolveAdbPath(tmpDir)).toBe(path.resolve(adbFake));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('allocateEmulatorPorts throws ERR_ANDROID_PORT_OCCUPIED when preferred port is occupied', async () => {
    const occupiedServer = net.createServer();
    const { promise: bound, resolve: resolveBound } = Promise.withResolvers<number>();
    occupiedServer.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = occupiedServer.address() as net.AddressInfo;
      resolveBound(addr.port);
    });
    const occupiedPort = await bound;

    try {
      await expect(allocateEmulatorPorts(occupiedPort)).rejects.toThrow(AdbError);
      try {
        await allocateEmulatorPorts(occupiedPort);
      } catch (err) {
        expect((err as AdbError).code).toBe('ERR_ANDROID_PORT_OCCUPIED');
      }
    } finally {
      occupiedServer.close();
    }
  });
});

describe('AndroidStreamHost ticket contract', () => {
  it('issues unique tickets with valid URL and screen dimensions', () => {
    const fakeInstance: AndroidInstanceLike = {
      profileId: 'test-profile-123',
      serial: 'emulator-5554',
      adb: {
        adbPath: 'adb',
        serial: 'emulator-5554',
      } as unknown as AndroidInstanceLike['adb'],
      screen: { width: 1080, height: 2400 },
    };

    const host = new AndroidStreamHost(fakeInstance);
    const t1 = host.issueTicket();
    const t2 = host.issueTicket();

    expect(t1.ticket).not.toBe(t2.ticket);
    expect(t1.wsUrl).toContain(`/android/stream?ticket=${t1.ticket}`);
    expect(t1.width).toBe(1080);
    expect(t1.height).toBe(2400);
    expect(t1.expiresAt).toBeGreaterThan(Date.now());
    expect(host.status).toBe('idle');
  });
});
