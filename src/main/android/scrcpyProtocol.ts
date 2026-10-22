import { Buffer } from 'node:buffer';

/**
 * Scrcpy 2.4 wire protocol (video stream + control channel).
 *
 * Source of truth: `Genymobile/scrcpy` v2.4 server sources —
 * `Streamer.java`, `DesktopConnection.java`, `ControlMessage.java`,
 * `ControlMessageReader.java`, `Binary.java`. Every layout below was verified against
 * a booted android-34 `google_apis` x86_64 guest running the pinned
 * `scrcpy-server.jar` (SHA-256 93c272b7…): codec meta `68323634 00000198 00000390`,
 * first frame `pts=1<<63` (CONFIG), `size=32`, and both the video and the control
 * socket accepted through `adb reverse`.
 *
 * Video stream layout (all big-endian), in order:
 * 1. 12-byte codec meta, NOT framed: uint32 codecId ('h264' = 0x68323634), uint32 width,
 *    uint32 height. (`Streamer.writeVideoHeader`.)
 * 2. Repeated frames: 12-byte header + payload.
 *    - uint64 ptsAndFlags: bit 63 = PACKET_FLAG_CONFIG, bit 62 = PACKET_FLAG_KEY_FRAME.
 *      A CONFIG packet carries ONLY the flag — its timestamp is not part of the value.
 *    - uint32 size: payload length.
 *
 * The 64-byte device-name field is only sent when `send_device_meta=true`; this client always
 * passes `send_device_meta=false`, so it never has to skip it.
 */

/** Size of the per-frame header (uint64 ptsAndFlags + uint32 size). */
export const SCRCPY_FRAME_HEADER_SIZE = 12;
/** Size of the raw codec-metadata prefix that opens the video stream. */
export const SCRCPY_CODEC_META_SIZE = 12;
export const SCRCPY_CODEC_H264 = 0x68323634;

/** `PACKET_FLAG_CONFIG` — 1 << 63 (Streamer.java). */
export const SCRCPY_FLAG_CONFIG = 1n << 63n;
/** `PACKET_FLAG_KEY_FRAME` — 1 << 62 (Streamer.java). */
export const SCRCPY_FLAG_KEY_FRAME = 1n << 62n;

const SCRCPY_FLAGS_MASK = SCRCPY_FLAG_CONFIG | SCRCPY_FLAG_KEY_FRAME;

/** Upper bound guard on packet payload size to fail closed against corrupted or malicious streams. */
export const MAX_SCRCPY_PACKET_SIZE = 64 * 1024 * 1024; // 64 MiB

export class ScrcpyProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ScrcpyProtocolError';
  }
}

export interface ScrcpyPacket {
  /** Presentation timestamp in microseconds, with the flag bits masked off. */
  pts: bigint;
  size: number;
  isConfig: boolean;
  isKeyFrame: boolean;
  payload: Buffer;
}

export interface ScrcpyCodecMeta {
  codecId: number; // 0x68323634 = 'h264'
  width: number;
  height: number;
}

/**
 * Pure incremental parser over a scrcpy video byte stream.
 *
 * Buffers partial prefixes, headers and payloads across feed() calls, so chunks split at any
 * byte boundary yield identical packets. Payloads are zero-copy slices whenever contiguous.
 */
export class ScrcpyParser {
  private _expectCodecMeta: boolean;
  private _codecMeta: ScrcpyCodecMeta | null = null;
  private _buffer: Buffer = Buffer.alloc(0);

  constructor(opts?: { expectCodecMeta?: boolean }) {
    this._expectCodecMeta = opts?.expectCodecMeta ?? true;
  }

  get codecMeta(): ScrcpyCodecMeta | null {
    return this._codecMeta;
  }

  /** Feeds a stream chunk and emits all complete video packets available. */
  feed(chunk: Buffer): ScrcpyPacket[] {
    if (chunk.length === 0) {
      return [];
    }

    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    // The codec meta is a raw 12-byte prefix, not a framed packet.
    if (this._expectCodecMeta) {
      if (this._buffer.length < SCRCPY_CODEC_META_SIZE) {
        return [];
      }
      this._codecMeta = {
        codecId: this._buffer.readUInt32BE(0),
        width: this._buffer.readUInt32BE(4),
        height: this._buffer.readUInt32BE(8),
      };
      this._expectCodecMeta = false;
      this._buffer = this._buffer.subarray(SCRCPY_CODEC_META_SIZE);
    }

    const packets: ScrcpyPacket[] = [];
    let offset = 0;

    while (this._buffer.length - offset >= SCRCPY_FRAME_HEADER_SIZE) {
      const rawPts = this._buffer.readBigUInt64BE(offset);
      const size = this._buffer.readUInt32BE(offset + 8);

      if (size > MAX_SCRCPY_PACKET_SIZE) {
        throw new ScrcpyProtocolError(
          `Hostile or invalid scrcpy packet size: ${size} bytes exceeds maximum allowed ${MAX_SCRCPY_PACKET_SIZE}`,
          'ERR_SCRCPY_PACKET_TOO_LARGE'
        );
      }

      const totalPacketLength = SCRCPY_FRAME_HEADER_SIZE + size;
      if (this._buffer.length - offset < totalPacketLength) {
        // Need more data to complete this packet.
        break;
      }

      packets.push({
        pts: rawPts & ~SCRCPY_FLAGS_MASK,
        size,
        isConfig: (rawPts & SCRCPY_FLAG_CONFIG) !== 0n,
        isKeyFrame: (rawPts & SCRCPY_FLAG_KEY_FRAME) !== 0n,
        payload: this._buffer.subarray(offset + SCRCPY_FRAME_HEADER_SIZE, offset + totalPacketLength),
      });

      offset += totalPacketLength;
    }

    if (offset > 0) {
      this._buffer =
        offset === this._buffer.length ? Buffer.alloc(0) : this._buffer.subarray(offset);
    }

    return packets;
  }
}

/**
 * Control channel constructors — `ControlMessage.java` / `ControlMessageReader.java` v2.4.
 *
 * Type ids are the protocol's own (`TYPE_*`), NOT a private numbering:
 * 0 keycode · 2 touch · 3 scroll · 4 back/screen-on · 10 screen power · 11 rotate.
 */

/** `ControlMessage.TYPE_INJECT_KEYCODE`. */
export const CONTROL_TYPE_KEYCODE = 0;
/** `ControlMessage.TYPE_INJECT_TOUCH_EVENT`. */
export const CONTROL_TYPE_TOUCH = 2;
/** `ControlMessage.TYPE_INJECT_SCROLL_EVENT`. */
export const CONTROL_TYPE_SCROLL = 3;
/** `ControlMessage.TYPE_BACK_OR_SCREEN_ON`. */
export const CONTROL_TYPE_BACK_OR_SCREEN_ON = 4;
/** `ControlMessage.TYPE_SET_SCREEN_POWER_MODE`. */
export const CONTROL_TYPE_SCREEN_POWER = 10;
/** `ControlMessage.TYPE_ROTATE_DEVICE`. */
export const CONTROL_TYPE_ROTATE = 11;

/** `KeyEvent.ACTION_DOWN` / `ACTION_UP`. */
export const KEY_ACTION_DOWN = 0;
export const KEY_ACTION_UP = 1;

/** `MotionEvent.ACTION_DOWN` / `ACTION_UP` / `ACTION_MOVE`. */
export const TOUCH_ACTION_DOWN = 0;
export const TOUCH_ACTION_UP = 1;
export const TOUCH_ACTION_MOVE = 2;

/** Android keycodes used by the toolbar. */
export const KEYCODE_HOME = 3;
export const KEYCODE_BACK = 4;
export const KEYCODE_POWER = 26;
export const KEYCODE_APP_SWITCH = 187;

/** `SurfaceControl.POWER_MODE_OFF` / `POWER_MODE_NORMAL`. */
export const SCREEN_POWER_OFF = 0;
export const SCREEN_POWER_NORMAL = 2;

/** Mouse/touch pointer id used by scrcpy's own client for a single pointer. */
const POINTER_ID_MOUSE = -1n;

/** u16 fixed point: 1.0 is 0xffff, everything else is value / 2^16. */
function toUFixed16(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped >= 1 ? 0xffff : Math.round(clamped * 0x10000);
}

/** i16 fixed point: 1.0 is 0x7fff, everything else is value / 2^15. */
function toIFixed16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped >= 1 ? 0x7fff : Math.round(clamped * 0x8000);
}

export interface TouchControlParams {
  action: number;
  x: number;
  y: number;
  screenW: number;
  screenH: number;
  /** 0..1; defaults to 1 while the finger is down. */
  pressure?: number;
  buttons?: number;
}

export interface ScrollControlParams {
  x: number;
  y: number;
  screenW: number;
  screenH: number;
  /** -1..1 */
  hScroll?: number;
  /** -1..1 */
  vScroll?: number;
  buttons?: number;
}

export interface KeyControlParams {
  keycode: number;
  action?: number;
  repeat?: number;
  metaState?: number;
}

/**
 * TYPE_INJECT_KEYCODE — 14 bytes:
 * `[type u8][action u8][keycode i32][repeat i32][metaState i32]`.
 */
export function buildKeyMessage(params: KeyControlParams | number): Buffer {
  const p: KeyControlParams = typeof params === 'number' ? { keycode: params } : params;
  const buf = Buffer.allocUnsafe(14);
  buf.writeUInt8(CONTROL_TYPE_KEYCODE, 0);
  buf.writeUInt8((p.action ?? KEY_ACTION_DOWN) & 0xff, 1);
  buf.writeInt32BE(p.keycode | 0, 2);
  buf.writeInt32BE(p.repeat ?? 0, 6);
  buf.writeInt32BE(p.metaState ?? 0, 10);
  return buf;
}

/** A press-and-release pair, which is what a toolbar button means. */
export function buildKeyPressMessages(keycode: number): Buffer {
  return Buffer.concat([
    buildKeyMessage({ keycode, action: KEY_ACTION_DOWN }),
    buildKeyMessage({ keycode, action: KEY_ACTION_UP }),
  ]);
}

/**
 * TYPE_INJECT_TOUCH_EVENT — 32 bytes:
 * `[type u8][action u8][pointerId i64][x i32][y i32][screenW u16][screenH u16]
 *  [pressure u16 fixed][actionButton i32][buttons i32]`.
 */
export function buildTouchMessage(params: TouchControlParams): Buffer {
  const buf = Buffer.allocUnsafe(32);
  const pressure = params.pressure ?? (params.action === TOUCH_ACTION_UP ? 0 : 1);
  buf.writeUInt8(CONTROL_TYPE_TOUCH, 0);
  buf.writeUInt8(params.action & 0xff, 1);
  buf.writeBigInt64BE(POINTER_ID_MOUSE, 2);
  buf.writeInt32BE(Math.round(params.x), 10);
  buf.writeInt32BE(Math.round(params.y), 14);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(params.screenW))), 18);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(params.screenH))), 20);
  buf.writeUInt16BE(toUFixed16(pressure), 22);
  // actionButton carries the button this event is about — including on UP (the released button).
  // Sending BUTTON_NONE(0) on UP makes the guest reject the release with "action button
  // should be nonzero for BUTTON_RELEASE" (measured in InputDispatcher logs).
  buf.writeInt32BE(1, 24);
  // buttons = held button mask (renderer twin has the same rule): BUTTON_PRIMARY while
  // touching, 0 on UP. An explicit params.buttons overrides (tests, special gestures).
  buf.writeInt32BE(params.buttons ?? (params.action === TOUCH_ACTION_UP ? 0 : 1), 28);
  return buf;
}

/**
 * TYPE_INJECT_SCROLL_EVENT — 21 bytes:
 * `[type u8][x i32][y i32][screenW u16][screenH u16][hScroll i16 fixed][vScroll i16 fixed][buttons i32]`.
 */
export function buildScrollMessage(params: ScrollControlParams): Buffer {
  const buf = Buffer.allocUnsafe(21);
  buf.writeUInt8(CONTROL_TYPE_SCROLL, 0);
  buf.writeInt32BE(Math.round(params.x), 1);
  buf.writeInt32BE(Math.round(params.y), 5);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(params.screenW))), 9);
  buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(params.screenH))), 11);
  buf.writeInt16BE(toIFixed16(params.hScroll ?? 0), 13);
  buf.writeInt16BE(toIFixed16(params.vScroll ?? 0), 15);
  buf.writeInt32BE(params.buttons ?? 0, 17);
  return buf;
}

/**
 * TYPE_BACK_OR_SCREEN_ON — 2 bytes: `[type u8][action u8]`.
 * ACTION_DOWN turns the screen on when it is off; ACTION_UP injects BACK.
 */
export function buildBackOrScreenOnMessage(action: number): Buffer {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(CONTROL_TYPE_BACK_OR_SCREEN_ON, 0);
  buf.writeUInt8(action & 0xff, 1);
  return buf;
}

/** TYPE_SET_SCREEN_POWER_MODE — 2 bytes: `[type u8][mode u8]`. */
export function buildScreenPowerMessage(mode: number): Buffer {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt8(CONTROL_TYPE_SCREEN_POWER, 0);
  buf.writeUInt8(mode & 0xff, 1);
  return buf;
}

/** TYPE_ROTATE_DEVICE — 1 byte: `[type]`. */
export function buildRotateMessage(): Buffer {
  return Buffer.from([CONTROL_TYPE_ROTATE]);
}
