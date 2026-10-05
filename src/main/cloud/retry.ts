/**
 * Transient network dropouts, rate-limit throttling (HTTP 429), and remote gateway
 * hiccups (HTTP 5xx) must not terminate sync flows or lose encrypted profile backups.
 * This wrapper provides exponential backoff with jitter and honours Retry-After headers.
 */

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  // Numeric header gives the delay directly in seconds
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // HTTP-date header specifies an absolute deadline
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function extractHeaderValue(source: unknown): string | null | undefined {
  if (!source || typeof source !== 'object') return undefined;

  if ('headers' in source && source.headers && typeof source.headers === 'object') {
    const h = source.headers;
    if ('get' in h && typeof h.get === 'function') {
      const val = h.get('retry-after');
      if (typeof val === 'string' || val === null) return val;
    }
    if ('retry-after' in h && typeof h['retry-after'] === 'string') {
      return h['retry-after'];
    }
    if ('Retry-After' in h && typeof h['Retry-After'] === 'string') {
      return h['Retry-After'];
    }
  }

  if ('get' in source && typeof source.get === 'function') {
    const val = source.get('retry-after');
    if (typeof val === 'string' || val === null) return val;
  }

  return undefined;
}

function extractHttpStatusAndRetryAfter(target: unknown): {
  status?: number;
  retryAfterMs?: number;
} {
  if (!target || typeof target !== 'object') {
    return {};
  }

  let status: number | undefined;
  if ('status' in target && typeof target.status === 'number') {
    status = target.status;
  } else if ('statusCode' in target && typeof target.statusCode === 'number') {
    status = target.statusCode;
  } else if ('response' in target && target.response && typeof target.response === 'object') {
    const resp = target.response;
    if ('status' in resp && typeof resp.status === 'number') {
      status = resp.status;
    } else if ('statusCode' in resp && typeof resp.statusCode === 'number') {
      status = resp.statusCode;
    }
  }

  const rawHeader =
    extractHeaderValue(target) ??
    ('response' in target && target.response ? extractHeaderValue(target.response) : undefined);
  const retryAfterMs = parseRetryAfter(rawHeader);

  return { status, retryAfterMs };
}

function computeBackoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }
  // Jittered exponential backoff prevents synchronized thundering herd retries against Google APIs
  const baseDelay = 500 * Math.pow(2, attempt - 1);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(baseDelay * jitter);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; onRetry?: (attempt: number, err: Error) => void }
): Promise<T> {
  const maxAttempts = opts?.attempts !== undefined && opts.attempts > 0 ? opts.attempts : 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();

      // Functions returning HTTP responses (such as node-fetch) may resolve without throwing
      // even on 429 or 5xx, requiring status inspection to trigger retry.
      const { status, retryAfterMs } = extractHttpStatusAndRetryAfter(result);
      if (status !== undefined && (status === 429 || (status >= 500 && status < 600))) {
        if (attempt < maxAttempts) {
          const err = new Error(`HTTP ${status}`);
          opts?.onRetry?.(attempt, err);
          await sleep(computeBackoffDelay(attempt, retryAfterMs));
          continue;
        }
      }

      return result;
    } catch (err: unknown) {
      const { status, retryAfterMs } = extractHttpStatusAndRetryAfter(err);

      // Permanent client errors (400, 401, 403, 404, etc.) must fail fast immediately to avoid
      // burning API quotas or masking revoked credentials with unhelpful retries.
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (status !== undefined && status < 400) {
        throw err;
      }

      // Exhausted attempts must propagate the original error intact so callers receive
      // the real root failure rather than a synthetic retry abstraction.
      if (attempt >= maxAttempts) {
        throw err;
      }

      const errorInstance = err instanceof Error ? err : new Error(String(err));
      opts?.onRetry?.(attempt, errorInstance);
      await sleep(computeBackoffDelay(attempt, retryAfterMs));
    }
  }

  throw new Error('Retry exhausted without result or error');
}
