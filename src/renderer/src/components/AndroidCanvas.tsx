import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  AndroidStreamClient,
  TOUCH_ACTION_DOWN,
  TOUCH_ACTION_MOVE,
  TOUCH_ACTION_UP,
  SCREEN_POWER_NORMAL,
  SCREEN_POWER_OFF,
  buildAvcCDescription,
  codecStringFromConfig,
  annexBFrameToAvcC,
  type AndroidStreamStatus,
} from '../androidStream';

export interface AndroidCanvasProps {
  wsUrl: string;
  screen: { width: number; height: number };
  onStatus?(s: AndroidStreamStatus, message?: string): void;
  /**
   * Requests a fresh stream ticket. Tickets are single-use, so a reconnect cannot reuse `wsUrl`:
   * the second upgrade is rejected with INVALID_TICKET and the canvas would sit on a dead socket.
   */
  onRetry?(): void | Promise<void>;
  /** Live served size (codec meta, then decoded frames) for header labels. */
  onVideoSize?(size: { width: number; height: number }): void;
}

export function AndroidCanvas({ wsUrl, screen, onStatus, onRetry, onVideoSize }: AndroidCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<AndroidStreamClient | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);

  const [status, setStatus] = useState<AndroidStreamStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPointerDown, setIsPointerDown] = useState(false);
  const [screenAwake, setScreenAwake] = useState(true);
  // What the stream actually serves (codec meta, then every decoded frame). The encoder rounds
  // the requested 412x915 down to 408x912, so the phone frame must follow the video — not the
  // ticket — or the layout is a 412x915 box around a 408x912 picture. Frozen from the FIRST
  // ticket: the prop object is rebuilt every parent render, so reading it live would reset the
  // layout on each poll.
  const initialScreenRef = useRef(screen);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number }>(initialScreenRef.current);
  // Measured content box of the container (ResizeObserver below). Pixel numbers, not CSS
  // percentages: % heights resolve against an auto-height parent and collapse the maths.
  const [boxSize, setBoxSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  // Check if WebCodecs VideoDecoder is available in this environment
  const isWebCodecsSupported =
    typeof window !== 'undefined' &&
    'VideoDecoder' in window &&
    typeof window.VideoDecoder === 'function';

  /**
   * The parent passes `onStatus` as an inline arrow, so it is a fresh function on every render.
   * Held in a ref and read through a stable callback: otherwise `handleStatusChange` changes
   * identity each render, the connect effect below re-runs, and every status update tears down
   * the WebSocket and opens a new one with a stream ticket that was already consumed.
   */
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onVideoSizeRef = useRef(onVideoSize);
  onVideoSizeRef.current = onVideoSize;

  const handleStatusChange = useCallback((newStatus: AndroidStreamStatus, message?: string) => {
    setStatus(newStatus);
    if (newStatus === 'error') {
      setErrorMessage(message || 'Stream connection error');
    } else if (newStatus === 'closed') {
      setErrorMessage(message || 'Stream closed');
    } else {
      setErrorMessage(null);
    }
    onStatusRef.current?.(newStatus, message);
  }, []);

  // Connect stream client and initialize VideoDecoder
  useEffect(() => {
    if (!isWebCodecsSupported) {
      handleStatusChange('error', 'WebCodecs VideoDecoder is unavailable in this environment');
      return undefined;
    }

    let isDisposed = false;
    let configured = false;

    try {
      const decoder = new window.VideoDecoder({
        output: (frame: VideoFrame) => {
          try {
            if (isDisposed) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            // The frame IS the truth: size the canvas from what the decoder produced. The
            // codec-meta path below is a hint; this assignment is what survives a stream that
            // never sends meta (late joiner) or sends it mid-flight (rotation/resize).
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            onVideoSizeRef.current?.({ width: frame.displayWidth, height: frame.displayHeight });
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
              setVideoSize({ width: frame.displayWidth, height: frame.displayHeight });
            }
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          } finally {
            // CRITICAL: frame.close() in finally block to prevent decoder stall
            frame.close();
          }
        },
        error: (err: DOMException | Error) => {
          console.error('[AndroidCanvas] VideoDecoder error:', err);
          handleStatusChange('error', err.message);
        },
      });

      decoderRef.current = decoder;
    } catch (decoderInitErr) {
      console.error('[AndroidCanvas] Failed to construct VideoDecoder:', decoderInitErr);
      handleStatusChange('error', (decoderInitErr as Error).message);
      return undefined;
    }

    // Create stream client
    const client = new AndroidStreamClient(wsUrl, {
      onStatus: (newStatus, msg) => {
        if (!isDisposed) {
          handleStatusChange(newStatus, msg);
        }
      },
      onCodecMeta: (meta) => {
        if (isDisposed) return;
        const canvas = canvasRef.current;
        if (canvas && (canvas.width !== meta.width || canvas.height !== meta.height)) {
          canvas.width = meta.width;
          canvas.height = meta.height;
        }
        setVideoSize((prev) =>
          prev.width === meta.width && prev.height === meta.height
            ? prev
            : { width: meta.width, height: meta.height },
        );
        // The guest validates every touch against the video's exact dimensions
        // (`Device.getPhysicalPoint` returns null otherwise and the event is dropped with
        // "Ignore touch event, it was generated for a different device size"). The encoder
        // rounds the requested 412x915 down to 408x912, so the pointer size must come from the
        // stream, not from the profile.
        client.setViewport(meta.width, meta.height);
      },
      onFrame: ({ data, isKeyFrame, pts, isConfig }) => {
        if (isDisposed) return;
        const decoder = decoderRef.current;
        if (!decoder || decoder.state === 'closed') return;

        if (isConfig) {
          // The CONFIG packet is Annex B SPS/PPS, not a decodable frame — and not a valid
          // WebCodecs description either. The description must be an ISO avcC box; passing the
          // raw bytes fails configure() with "Failed to parse avcC" (measured).
          const description = buildAvcCDescription(data);
          if (!description) return;
          const codec = codecStringFromConfig(data) ?? 'avc1.42E01E';
          try {
            // SAFETY: WebCodecs accepts any ArrayBufferView as AllowSharedBufferSource; the
            // avcC box is freshly allocated above and never detached while the decoder reads it.
            decoder.configure({ codec, description: description as unknown as BufferSource, optimizeForLatency: true });
            configured = true;
          } catch (cfgErr) {
            console.error('[AndroidCanvas] Failed to configure with CONFIG packet:', cfgErr);
          }
          return;
        }

        if (!configured) {
          // A delta frame before any CONFIG packet cannot be decoded; wait for the next key frame.
          if (!isKeyFrame) return;
          try {
            decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true });
            configured = true;
          } catch (cfgErr) {
            console.error('[AndroidCanvas] Failed to configure decoder:', cfgErr);
            return;
          }
        }

        try {
          decoder.decode(
            new window.EncodedVideoChunk({
              type: isKeyFrame ? 'key' : 'delta',
              timestamp: Number(pts),
              // Frames arrive as Annex B; WebCodecs avc1 chunks must be avcC (length-prefixed).
              // SAFETY: same AllowSharedBufferSource rule; the converted copy is owned by this call.
              data: annexBFrameToAvcC(data) as unknown as BufferSource,
            })
          );
        } catch (decErr) {
          console.error('[AndroidCanvas] Failed to decode chunk:', decErr);
        }
      },
    });

    clientRef.current = client;
    client.setViewport(screen.width, screen.height);
    client.connect();

    return () => {
      isDisposed = true;
      if (decoderRef.current) {
        try {
          if (decoderRef.current.state !== 'closed') {
            decoderRef.current.close();
          }
        } catch {
          // Decoder already torn down.
        }
        decoderRef.current = null;
      }
      if (clientRef.current) {
        try {
          clientRef.current.close();
        } catch {
          // Client already closed.
        }
        clientRef.current = null;
      }
    };
  // wsUrl only: screen.* is a fresh object each parent render — depending on it would
  // tear down the decoder + WebSocket mid-stream on every poll. Viewport size arrives via
  // onCodecMeta, which is the stream truth anyway.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  // Measures the container content box so the phone frame gets pixel-exact dimensions.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBoxSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The canvas is sized from the stream's codec metadata (see onCodecMeta), so no observer is
  // needed: the CSS box scales the video, and pointer coordinates are converted against it.


  // Pointer event handlers: scale coordinates from CSS pixels to guest screen size
  const getScaledCoordinates = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    return {
      x: Math.max(0, Math.min(canvas.width, Math.round(cssX * scaleX))),
      y: Math.max(0, Math.min(canvas.height, Math.round(cssY * scaleY))),
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsPointerDown(true);
    const { x, y } = getScaledCoordinates(e);
    clientRef.current?.sendTouch(TOUCH_ACTION_DOWN, x, y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPointerDown) return;
    e.preventDefault();
    const { x, y } = getScaledCoordinates(e);
    clientRef.current?.sendTouch(TOUCH_ACTION_MOVE, x, y);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPointerDown) return;
    e.preventDefault();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture is already gone (pointer left the element); releasing again is a no-op.
    }
    setIsPointerDown(false);
    const { x, y } = getScaledCoordinates(e);
    clientRef.current?.sendTouch(TOUCH_ACTION_UP, x, y);
  };

  // Wheel event handler: map to sendScroll
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const x = Math.max(0, Math.min(canvas.width, Math.round(cssX * scaleX)));
    const y = Math.max(0, Math.min(canvas.height, Math.round(cssY * scaleY)));

    clientRef.current?.sendScroll(x, y, Math.round(e.deltaX), Math.round(e.deltaY));
  };

  // If WebCodecs is unsupported, render clear, explicit notice
  if (!isWebCodecsSupported) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '36px 20px',
          gap: 12,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text)',
          textAlign: 'center',
          maxWidth: 480,
          margin: '24px auto',
        }}
      >
        <div style={{ color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width={36} height={36} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          WebCodecs VideoDecoder Unavailable
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          The hardware-accelerated WebCodecs API is not supported or enabled in this browser environment.
          An H.264 compatible VideoDecoder is required to stream the Android emulator screen.
        </div>
      </div>
    );
  }

  const frameBox = (() => {
    const availW = Math.max(0, boxSize.width - 32);
    const availH = Math.max(0, boxSize.height - 32 - 56);
    const vw = Math.max(1, videoSize.width);
    const vh = Math.max(1, videoSize.height);
    if (availW <= 0 || availH <= 0) return { width: vw, height: vh };
    const scale = Math.min(availW / vw, availH / vh);
    return { width: Math.max(1, Math.floor(vw * scale)), height: Math.max(1, Math.floor(vh * scale)) };
  })();

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        position: 'relative',
        background: 'var(--bg-app)',
        padding: '16px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Phone Frame with Letterboxed Canvas */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Pixel-exact box from the ResizeObserver math above: the frame IS the video
          // ratio, so the canvas (100%x100%) cannot stretch. No max-clamps — they reintroduced
          // the mismatch this replaces.
          width: frameBox.width,
          height: frameBox.height,
          background: '#000000',
          borderRadius: 'var(--radius-lg)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          width={screen.width}
          height={screen.height}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            touchAction: 'none',
            cursor: isPointerDown ? 'grabbing' : 'default',
          }}
        />

        {/* Status / Error Overlay */}
        {status !== 'streaming' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(9, 9, 11, 0.82)',
              backdropFilter: 'blur(4px)',
              padding: '20px',
              textAlign: 'center',
              gap: 12,
              zIndex: 10,
            }}
          >
            {status === 'connecting' && (
              <>
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: '2px solid var(--divider)',
                    borderTopColor: 'var(--text)',
                    animation: 'spin 1s linear infinite',
                  }}
                />
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                  Connecting to Android stream...
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Awaiting H.264 video feed
                </div>
              </>
            )}

            {(status === 'error' || status === 'closed') && (
              <>
                <div style={{ color: status === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
                  <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="10" />
                    {status === 'error' ? (
                      <>
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </>
                    ) : (
                      <>
                        <line x1="8" y1="12" x2="16" y2="12" />
                      </>
                    )}
                  </svg>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                  {status === 'error' ? 'Stream Error' : 'Stream Closed'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 300 }}>
                  {errorMessage ||
                    (status === 'error'
                      ? 'Failed to establish scrcpy video stream.'
                      : 'The stream connection was closed.')}
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    // A ticket is single-use, so reconnecting needs a new one from the host.
                    if (onRetry) {
                      void onRetry();
                    } else {
                      clientRef.current?.connect();
                    }
                  }}
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    padding: '6px 16px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--control-bg)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    cursor: 'pointer',
                  }}
                >
                  {status === 'error' ? 'Retry Connection' : 'Reconnect'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Android Hardware Navigation Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          marginTop: 12,
          padding: '6px 14px',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-full)',
          boxShadow: 'var(--shadow-sm)',
          zIndex: 5,
        }}
      >
        {/* Back (Key 4) */}
        <button
          type="button"
          onClick={() => clientRef.current?.sendBack()}
          title="Back"
          aria-label="Back"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-full)',
            background: 'var(--control-bg)',
            border: '1px solid transparent',
            color: 'var(--text)',
            cursor: 'pointer',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--control-bg-hover)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--control-bg)';
            e.currentTarget.style.borderColor = 'transparent';
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <polygon points="19,4 6,12 19,20" fill="currentColor" stroke="none" />
          </svg>
        </button>

        {/* Home (Key 3) */}
        <button
          type="button"
          onClick={() => clientRef.current?.sendKey(3)}
          title="Home (Keycode 3)"
          aria-label="Home"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-full)',
            background: 'var(--control-bg)',
            border: '1px solid transparent',
            color: 'var(--text)',
            cursor: 'pointer',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--control-bg-hover)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--control-bg)';
            e.currentTarget.style.borderColor = 'transparent';
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth={2.5} fill="none" />
          </svg>
        </button>

        {/* Recents (Key 187) */}
        <button
          type="button"
          onClick={() => clientRef.current?.sendKey(187)}
          title="Recents (Keycode 187)"
          aria-label="Recents"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-full)',
            background: 'var(--control-bg)',
            border: '1px solid transparent',
            color: 'var(--text)',
            cursor: 'pointer',
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--control-bg-hover)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--control-bg)';
            e.currentTarget.style.borderColor = 'transparent';
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth={2.5} fill="none" />
          </svg>
        </button>

        <div style={{ width: 1, height: 18, background: 'var(--divider)', margin: '0 2px' }} />

        {/* Power (Key 26) */}
        <button
          type="button"
          onClick={() => {
            const next = !screenAwake;
            clientRef.current?.sendScreenPower(next ? SCREEN_POWER_NORMAL : SCREEN_POWER_OFF);
            setScreenAwake(next);
          }}
          title="Power (screen on/off)"
          aria-label="Power"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-full)',
            background: 'var(--control-bg)',
            border: '1px solid transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'background 0.15s, border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--control-bg-hover)';
            e.currentTarget.style.borderColor = 'var(--border)';
            e.currentTarget.style.color = 'var(--text)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--control-bg)';
            e.currentTarget.style.borderColor = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
        </button>

        {/* Rotate */}
        <button
          type="button"
          onClick={() => clientRef.current?.sendRotate()}
          title="Rotate Screen"
          aria-label="Rotate"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 'var(--radius-full)',
            background: 'var(--control-bg)',
            border: '1px solid transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'background 0.15s, border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--control-bg-hover)';
            e.currentTarget.style.borderColor = 'var(--border)';
            e.currentTarget.style.color = 'var(--text)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--control-bg)';
            e.currentTarget.style.borderColor = 'transparent';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M21.5 2v6h-6" />
            <path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
          </svg>
        </button>
      </div>
    </div>
  );
}
