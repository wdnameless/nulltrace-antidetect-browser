/**
 * Android stream WebSocket client and scrcpy 2.4 wire-format codec.
 *
 * The wire format is defined by the guest server (`Genymobile/scrcpy` v2.4 `Streamer.java`,
 * `ControlMessage.java`, `ControlMessageReader.java`); `src/main/android/scrcpyProtocol.ts`
 * carries the same definitions with the measurements that established them. This module is the
 * browser-side twin and must not import from `src/main/**`.
 *
 * Video stream: a raw 12-byte codec-meta prefix (codecId, width, height) followed by frames of
 * `[u64 ptsAndFlags][u32 size][payload]`, where bit 63 marks CONFIG and bit 62 marks a key frame.
 */

export const SCRCPY_CODEC_META_SIZE = 12;
export const SCRCPY_FRAME_HEADER_SIZE = 12;
export const SCRCPY_FLAG_CONFIG = 1n << 63n;
export const SCRCPY_FLAG_KEY_FRAME = 1n << 62n;

/** `ControlMessage.TYPE_*` (v2.4). */
export const CONTROL_TYPE_KEYCODE = 0;
export const CONTROL_TYPE_TOUCH = 2;
export const CONTROL_TYPE_SCROLL = 3;
export const CONTROL_TYPE_BACK_OR_SCREEN_ON = 4;
export const CONTROL_TYPE_SCREEN_POWER = 10;
export const CONTROL_TYPE_ROTATE = 11;

/** `MotionEvent.ACTION_*`. */
export const TOUCH_ACTION_DOWN = 0;
export const TOUCH_ACTION_UP = 1;
export const TOUCH_ACTION_MOVE = 2;

/** `KeyEvent.ACTION_*`. */
const KEY_ACTION_DOWN = 0;
const KEY_ACTION_UP = 1;

/** `SurfaceControl.POWER_MODE_*`. */
export const SCREEN_POWER_OFF = 0;
export const SCREEN_POWER_NORMAL = 2;

/** Android keycodes the toolbar exposes. */
export const KEYCODE_HOME = 3;
export const KEYCODE_BACK = 4;
export const KEYCODE_POWER = 26;
export const KEYCODE_APP_SWITCH = 187;

/** scrcpy's own single-pointer id (`Controller.POINTER_ID_MOUSE`). */
const POINTER_ID_MOUSE = -1n;

export type AndroidStreamStatus = 'connecting' | 'streaming' | 'closed' | 'error';

export interface AndroidStreamHandlers {
  onStatus(s: AndroidStreamStatus, message?: string): void;
  /** Codec description, once the stream's codec-meta prefix has been parsed. */
  onCodecMeta(meta: { codecId: number; width: number; height: number }): void;
  onFrame(frame: { data: Uint8Array; isKeyFrame: boolean; pts: bigint; isConfig: boolean }): void;
}

/**
 * Splits an H.264 Annex B byte stream into NAL units (start codes stripped).
 *
 * The scrcpy video payloads are Annex B (`00 00 00 01 …`), measured live: the CONFIG packet
 * is `00 00 00 01 67 … 00 00 00 01 68 …`. Both 3- and 4-byte start codes are accepted, and
 * emulation-prevention bytes are left untouched (they belong to the NAL payload).
 */
export function splitAnnexBNals(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  const push = (end: number): void => {
    if (start >= 0 && end > start) units.push(data.slice(start, end));
  };
  let i = 0;
  while (i + 2 < data.length) {
    const isFour = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    const isThree = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (isFour || isThree) {
      if (start >= 0) push(i);
      i += isFour ? 4 : 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0) push(data.length);
  return units;
}

/**
 * Builds the WebCodecs `description` (ISO avcC box) from a CONFIG packet's Annex B payload.
 *
 * WebCodecs does NOT accept Annex B as the description — passing the raw `00 00 00 01 67 …`
 * bytes fails `configure()` with "Failed to parse avcC". The box is:
 * `01 profile constraints level FF E1 <spsLen:16> <sps> 01 <ppsLen:16> <pps>`.
 * Returns null when no SPS (NAL type 7) is present; extra NALs (SEI, …) are ignored.
 */
export function buildAvcCDescription(configPayload: Uint8Array): Uint8Array | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const nal of splitAnnexBNals(configPayload)) {
    const type = nal[0] & 0x1f;
    if (type === 7 && !sps) sps = nal;
    else if (type === 8 && !pps) pps = nal;
  }
  if (!sps || sps.length < 4) return null;
  const out = new Uint8Array(11 + sps.length + (pps?.length ?? 0));
  out[0] = 0x01;
  out[1] = sps[1];
  out[2] = sps[2];
  out[3] = sps[3];
  out[4] = 0xff;
  out[5] = 0xe1;
  out[6] = (sps.length >> 8) & 0xff;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  let o = 8 + sps.length;
  out[o++] = pps ? 1 : 0;
  if (pps) {
    out[o++] = (pps.length >> 8) & 0xff;
    out[o++] = pps.length & 0xff;
    out.set(pps, o);
  }
  return out;
}

/**
 * Codec string from an SPS NAL (`avc1.<profile><constraints><level>` in hex).
 * Returns null when the payload holds no usable SPS.
 */
export function codecStringFromConfig(configPayload: Uint8Array): string | null {
  for (const nal of splitAnnexBNals(configPayload)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) {
      const hex = (v: number): string => v.toString(16).padStart(2, '0');
      return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
    }
  }
  return null;
}

/**
 * Converts one Annex B frame payload to avcC (length-prefixed NALs) for `EncodedVideoChunk`.
 *
 * WebCodecs decodes `avc1.*` chunks as avcC: each NAL prefixed by its 4-byte big-endian length.
 * Feeding Annex B start codes instead decodes as garbage or rejects the chunk, so every video
 * frame is converted here. Zero-copy when the payload holds a single NAL is not worth the
 * branch: frames are small and the copy is one allocation.
 */
export function annexBFrameToAvcC(framePayload: Uint8Array): Uint8Array {
  const nals = splitAnnexBNals(framePayload);
  if (nals.length === 0) return framePayload;
  let total = 0;
  for (const nal of nals) total += 4 + nal.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const nal of nals) {
    out[o++] = (nal.length >>> 24) & 0xff;
    out[o++] = (nal.length >>> 16) & 0xff;
    out[o++] = (nal.length >>> 8) & 0xff;
    out[o++] = nal.length & 0xff;
    out.set(nal, o);
    o += nal.length;
  }
  return out;
}

export class AndroidStreamClient {

  private ws: WebSocket | null = null;
  private closed = false;
  private buffer: Uint8Array = new Uint8Array(0);
  private expectCodecMeta = true;
  private viewportWidth = 0;
  private viewportHeight = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly handlers: AndroidStreamHandlers
  ) {}

  /** Connect to the stream WebSocket. */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closed = false;
    this.buffer = new Uint8Array(0);
    this.expectCodecMeta = true;
    this.handlers.onStatus('connecting');

    try {
      const ws = new WebSocket(this.wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (this.closed || this.ws !== ws) {
          try {
            ws.close();
          } catch {
            // The socket is already closing; nothing to recover from.
          }
          return;
        }
        this.handlers.onStatus('streaming');
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.closed || this.ws !== ws) return;

        // Server->client text frames carry JSON status, codec metadata, or errors
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'error') {
              this.handlers.onStatus('error', msg.message || 'Stream error');
            } else if (msg.type === 'codec') {
              // A late joiner gets the meta as JSON because it missed the 12-byte binary prefix.
              // The binary parser must NOT then read the first frame header as that prefix — doing
              // so shifts every subsequent packet and the decoder never configures (black canvas).
              this.expectCodecMeta = false;
              this.handlers.onCodecMeta({ codecId: msg.codecId, width: msg.width, height: msg.height });
            } else if (msg.type === 'status') {
              this.handlers.onStatus(msg.message === 'streaming' ? 'streaming' : 'connecting', msg.message);
            }
          } catch {
            // Ignore non-JSON or malformed text frames
          }
          return;
        }

        // Server->client binary frames carry raw scrcpy stream bytes
        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryChunk(new Uint8Array(event.data));
        }
      };

      ws.onerror = () => {
        if (this.closed || this.ws !== ws) return;
        this.handlers.onStatus('error', 'WebSocket connection error');
      };

      ws.onclose = () => {
        if (this.closed || this.ws !== ws) return;
        this.closed = true;
        this.ws = null;
        this.handlers.onStatus('closed');
      };

      this.ws = ws;
    } catch (err) {
      this.handlers.onStatus('error', (err as Error).message);
    }
  }

  /** Idempotent close. Closes the WebSocket and cleans up parser state. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // close() is idempotent; a second call on a closing socket is expected.
      }
    }

    this.buffer = new Uint8Array(0);
    this.handlers.onStatus('closed');
  }

  /** Caches the current viewport so touch/scroll messages can carry it without a round-trip. */
  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /**
   * TYPE_INJECT_TOUCH_EVENT — 32 bytes:
   * `[02][action][pointerId i64][x i32][y i32][screenW u16][screenH u16][pressure u16][actionButton i32][buttons i32]`.
   */
  sendTouch(action: 0 | 1 | 2, x: number, y: number): void {
    const buf = new ArrayBuffer(32);
    const view = new DataView(buf);
    view.setUint8(0, CONTROL_TYPE_TOUCH);
    view.setUint8(1, action);
    view.setBigInt64(2, POINTER_ID_MOUSE, false);
    view.setInt32(10, Math.round(x), false);
    view.setInt32(14, Math.round(y), false);
    view.setUint16(18, Math.max(0, Math.min(0xffff, Math.round(this.viewportWidth))), false);
    view.setUint16(20, Math.max(0, Math.min(0xffff, Math.round(this.viewportHeight))), false);
    // u16 fixed point: 1.0 is 0xffff
    view.setUint16(22, action === TOUCH_ACTION_UP ? 0 : 0xffff, false);
    view.setInt32(24, action === TOUCH_ACTION_UP ? 0 : 1, false);
    view.setInt32(28, 0, false);
    this.sendBinary(buf);
  }

  /**
   * TYPE_INJECT_SCROLL_EVENT — 21 bytes:
   * `[03][x i32][y i32][screenW u16][screenH u16][hScroll i16][vScroll i16][buttons i32]`.
   *
   * Scroll deltas are i16 fixed point in [-1, 1]; wheel pixels are converted by dividing by a
   * page so a normal wheel notch moves the list without flinging it.
   */
  sendScroll(x: number, y: number, hScrollPixels: number, vScrollPixels: number): void {
    const toFixed = (pixels: number) => Math.round(Math.max(-1, Math.min(1, pixels / 480)) * 0x8000);
    const buf = new ArrayBuffer(21);
    const view = new DataView(buf);
    view.setUint8(0, CONTROL_TYPE_SCROLL);
    view.setInt32(1, Math.round(x), false);
    view.setInt32(5, Math.round(y), false);
    view.setUint16(9, Math.max(0, Math.min(0xffff, Math.round(this.viewportWidth))), false);
    view.setUint16(11, Math.max(0, Math.min(0xffff, Math.round(this.viewportHeight))), false);
    view.setInt16(13, toFixed(hScrollPixels), false);
    view.setInt16(15, toFixed(vScrollPixels), false);
    view.setInt32(17, 0, false);
    this.sendBinary(buf);
  }

  /**
   * TYPE_INJECT_KEYCODE — 14 bytes, sent as a press/release pair so a button tap is one action:
   * `[00][action][keycode i32][repeat i32][metaState i32]`.
   */
  sendKey(keycode: number): void {
    for (const action of [KEY_ACTION_DOWN, KEY_ACTION_UP]) {
      const buf = new ArrayBuffer(14);
      const view = new DataView(buf);
      view.setUint8(0, CONTROL_TYPE_KEYCODE);
      view.setUint8(1, action);
      view.setInt32(2, keycode, false);
      view.setInt32(6, 0, false);
      view.setInt32(10, 0, false);
      this.sendBinary(buf);
    }
  }

  /**
   * BACK is scrcpy's combined "back or screen-on" message (`TYPE_BACK_OR_SCREEN_ON`), which
   * turns the screen on when it is off instead of doing nothing.
   */
  sendBack(): void {
    for (const action of [KEY_ACTION_DOWN, KEY_ACTION_UP]) {
      const buf = new ArrayBuffer(2);
      const view = new DataView(buf);
      view.setUint8(0, CONTROL_TYPE_BACK_OR_SCREEN_ON);
      view.setUint8(1, action);
      this.sendBinary(buf);
    }
  }

  /** TYPE_SET_SCREEN_POWER_MODE — 2 bytes: `[10][mode]`. */
  sendScreenPower(mode: typeof SCREEN_POWER_OFF | typeof SCREEN_POWER_NORMAL): void {
    const buf = new ArrayBuffer(2);
    const view = new DataView(buf);
    view.setUint8(0, CONTROL_TYPE_SCREEN_POWER);
    view.setUint8(1, mode);
    this.sendBinary(buf);
  }

  /** TYPE_ROTATE_DEVICE — 1 byte: `[11]`. */
  sendRotate(): void {
    this.sendBinary(new Uint8Array([CONTROL_TYPE_ROTATE]).buffer);
  }

  private sendBinary(data: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * Incremental parser for the video stream: 12-byte codec-meta prefix, then frames of
   * `[u64 ptsAndFlags][u32 size][payload]`.
   */
  private handleBinaryChunk(chunk: Uint8Array): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      const combined = new Uint8Array(this.buffer.length + chunk.length);
      combined.set(this.buffer, 0);
      combined.set(chunk, this.buffer.length);
      this.buffer = combined;
    }

    if (this.expectCodecMeta) {
      if (this.buffer.length < SCRCPY_CODEC_META_SIZE) {
        return;
      }
      const metaView = new DataView(this.buffer.buffer, this.buffer.byteOffset, SCRCPY_CODEC_META_SIZE);
      this.expectCodecMeta = false;
      this.handlers.onCodecMeta({
        codecId: metaView.getUint32(0, false),
        width: metaView.getUint32(4, false),
        height: metaView.getUint32(8, false),
      });
      this.buffer = this.buffer.slice(SCRCPY_CODEC_META_SIZE);
    }

    while (this.buffer.length >= SCRCPY_FRAME_HEADER_SIZE) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const rawPts = view.getBigUint64(0, false);
      const size = view.getUint32(8, false);

      if (this.buffer.length < SCRCPY_FRAME_HEADER_SIZE + size) {
        // Incomplete packet; wait for more data
        break;
      }

      const data = this.buffer.slice(SCRCPY_FRAME_HEADER_SIZE, SCRCPY_FRAME_HEADER_SIZE + size);
      const consumed = SCRCPY_FRAME_HEADER_SIZE + size;
      this.buffer = this.buffer.length === consumed ? new Uint8Array(0) : this.buffer.slice(consumed);

      this.handlers.onFrame({
        data,
        isConfig: (rawPts & SCRCPY_FLAG_CONFIG) !== 0n,
        isKeyFrame: (rawPts & SCRCPY_FLAG_KEY_FRAME) !== 0n,
        pts: rawPts & ~(SCRCPY_FLAG_CONFIG | SCRCPY_FLAG_KEY_FRAME),
      });
    }
  }
}
