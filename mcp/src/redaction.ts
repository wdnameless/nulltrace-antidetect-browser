export const REDACTED_MARKER = '[REDACTED]';

/**
 * Sensitive key pattern matching tokens, passwords, secrets, credentials,
 * auth/authorization headers, cookies, proxy passwords.
 * Case-insensitive, word-boundary aware.
 * Examples matching:
 * - token, api_token, authToken, token_id
 * - password, pass, pwd, proxy_password, proxyPassword
 * - secret, client_secret, api_secret
 * - credential, credentials, proxy_credential
 * - auth, authorization
 * - cookie, cookies
 * Examples NOT matching:
 * - proxy_user, proxy_host, proxy_port, author, authenticate (if not ending/starting on boundary or non-sensitive)
 */
const SENSITIVE_KEY_REGEX = /(?:^|[_\-.])(?:token|password|pass|pwd|secret|credential|credentials|auth|authorization|cookie|cookies)(?:[_\-.]|$)/i;

/**
 * Container keys whose SUBTREE is entirely credential material (e.g. proxy
 * credential bags). They are recursed into so sensitive leaves get masked and
 * harmless siblings (proxy_user, proxy_host) survive — matching the spec's
 * "redaction filters for sensitive fields" semantics.
 */
const CONTAINER_CREDENTIAL_KEYS = new Set(['credentials', 'credential']);

const isSensitiveLeafKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  if (lower === 'code' || lower === 'script_code' || lower === 'scriptcode') {
    return true;
  }
  if (CONTAINER_CREDENTIAL_KEYS.has(lower)) {
    return false; // recurse instead of wholesale masking
  }
  if (SENSITIVE_KEY_REGEX.test(key)) {
    return true;
  }
  // camelCase / concatenated variants: proxyPassword, authToken, clientSecret, proxy_password
  const boundary = /(?:token|password|pass|pwd|secret|credential|auth|cookie)/.test(lower);
  if (!boundary) {
    return false;
  }
  // Avoid false positives on non-sensitive identifiers
  if (lower.includes('user') || lower.includes('host') || lower.includes('port') || lower.includes('author')) {
    return lower.includes('password') || lower.includes('secret') || lower.includes('token') || lower.includes('credential');
  }
  return true;
}

/**
 * Deep-clones and replaces values whose key matches sensitive patterns
 * with "[REDACTED]". Recursively traverses objects and arrays.
 * Preserves non-sensitive keys and non-object primitives.
 */
export function redactSensitiveArgs<T = unknown>(args: T): T {
  if (args === null || args === undefined || typeof args !== 'object') {
    return args;
  }

  if (Array.isArray(args)) {
    return args.map((item) => redactSensitiveArgs(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (isSensitiveLeafKey(key) || (CONTAINER_CREDENTIAL_KEYS.has(key.toLowerCase()) && typeof value !== 'object')) {
      result[key] = REDACTED_MARKER;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveArgs(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
