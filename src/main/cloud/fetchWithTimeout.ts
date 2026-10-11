import fetch, { RequestInit, Response } from 'node-fetch';

export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
export const PAYLOAD_FETCH_TIMEOUT_MS = 300_000;

export function extractHost(url: unknown): string {
  try {
    const raw = typeof url === 'string' ? url : String(url);
    const parsed = new URL(raw);
    return parsed.host || 'unknown-host';
  } catch {
    return 'unknown-host';
  }
}

export function formatTimeoutError(url: unknown, ms: number): Error {
  const host = extractHost(url);
  const seconds = ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
  return new Error(`Request to ${host} timed out after ${seconds} (${ms}ms)`);
}

/**
 * fetchWithTimeout wraps node-fetch with AbortSignal.timeout to guarantee that
 * every Google API request times out predictably rather than hanging indefinitely.
 *
 * Defaults to 60s for metadata calls and accepts 300s for large payload transfers.
 * On timeout, the error message includes the timeout ceiling and the URL host,
 * strictly excluding any auth tokens or query parameters.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  ms: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(ms);
  const signal =
    init?.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([init.signal as AbortSignal, timeoutSignal])
      : (init?.signal ?? timeoutSignal);

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (timeoutSignal.aborted) {
      reject(formatTimeoutError(url, ms));
      return;
    }
    onAbort = () => reject(formatTimeoutError(url, ms));
    timeoutSignal.addEventListener('abort', onAbort, { once: true });
  });

  // Attach a no-op handler to avoid unhandled rejection if fetch settles first.
  abortPromise.catch(() => {});

  try {
    const requestUrl = typeof url === 'string' ? url : url.toString();
    return await Promise.race([
      fetch(requestUrl, {
        ...init,
        signal,
      }),
      abortPromise,
    ]);
  } catch (err: unknown) {
    const record = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : null;
    const isTimeout =
      timeoutSignal.aborted ||
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
      record?.type === 'aborted' ||
      record?.code === 'ETIMEDOUT';
    if (isTimeout) {
      throw formatTimeoutError(url, ms);
    }
    throw err;
  } finally {
    if (onAbort) {
      timeoutSignal.removeEventListener('abort', onAbort);
    }
  }
}

export default fetchWithTimeout;
