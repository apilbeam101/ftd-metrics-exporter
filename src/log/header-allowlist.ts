/**
 * Request headers are logged only if their name is on this explicit
 * allowlist (DESIGN.md §9.4: allowlist, not denylist, so a header a future
 * contributor adds — including a new auth scheme — cannot leak by
 * default just by existing). Anything not listed here is absent from log
 * output entirely; it is not present-and-redacted.
 */
export const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'content-type',
  'content-length',
  'user-agent',
  'x-request-id',
  'retry-after',
]);

/**
 * Filters `headers` down to only the allowlisted names, lowercasing keys
 * for consistent output regardless of the case the upstream call used.
 */
export function filterHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (headers === undefined) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (ALLOWED_REQUEST_HEADERS.has(key.toLowerCase())) {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}
