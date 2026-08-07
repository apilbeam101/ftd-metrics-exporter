/**
 * Error normalization — DESIGN.md §9.4's "most commonly missed leak path":
 * HTTP client libraries (undici included) routinely attach the full
 * request, headers included, to a thrown error. An unhandled rejection or
 * a careless `logger.error('x', { err })` can print a bearer token if the
 * error object is serialized wholesale.
 *
 * The fix is a small extraction allowlist, not a generic walk: pull only
 * method, sanitized URL, status code, and message off the error (and off
 * each `cause` in the chain, with the same rule), and discard everything
 * else the error object happens to carry.
 */

import { sanitizeUrl } from './sanitize-url.ts';

const MAX_CAUSE_DEPTH = 5;

export interface NormalizedError {
  method?: string;
  url?: string;
  statusCode?: number;
  message: string;
  cause?: NormalizedError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Keys whose presence, alongside a string `message`, is good evidence a
 * plain object is an error that crossed a serialization boundary (e.g.
 * a hand-serialized `err.toJSON()`, which drops the `Error` prototype)
 * rather than an arbitrary domain object that happens to carry a
 * `message` field — `ParseError` (src/domain/diagnostics.ts) is exactly
 * such a domain object, and normalizing it here would silently drop its
 * `deviceUid`/`group` fields. Requiring one of these request/response-ish
 * hints keeps the duck-type narrow enough that `redact.ts` can reuse it
 * for prototype-less errors without also swallowing ordinary data.
 *
 * Deliberately EXCLUDES bare `url`/`path`/`method`: a routine
 * `logger.debug('request', { url, responseSize })` call legitimately
 * combines a `message` (added by the logger) with a `url` field, and an
 * earlier version of this list treated that combination as
 * "error-shaped," which silently discarded the rest of the log line
 * (found by this stage's own level-filtering regression test — see
 * test/unit/log-logger.test.ts). `request`/`response`/`options`/`cause`/
 * `statusCode`/`status` are far less likely to appear on a plain
 * non-error log field, so they remain sufficient on their own.
 */
const ERROR_SHAPE_HINT_KEYS = [
  'request',
  'response',
  'options',
  'cause',
  'statusCode',
  'status',
] as const;

/**
 * Duck-typed check for "looks enough like an error to extract from",
 * used both for `cause` values (which the language allows to be
 * anything, not just an `Error` instance) and, per review finding R7, by
 * `redact.ts` so a prototype-less error object is normalized the same
 * way a real `Error` instance would be — the two call sites must agree
 * on what counts as an error, or one of them is a redaction bypass.
 */
export function isNormalizableError(value: unknown): value is Record<string, unknown> {
  if (value instanceof Error) {
    return true;
  }
  if (!isRecord(value) || typeof value.message !== 'string') {
    return false;
  }
  return ERROR_SHAPE_HINT_KEYS.some((key) => key in value);
}

function extractMethod(err: Record<string, unknown>): string | undefined {
  const direct = readString(err.method);
  if (direct) return direct;
  const request = err.request;
  if (isRecord(request)) {
    const method = readString(request.method);
    if (method) return method;
  }
  const options = err.options;
  if (isRecord(options)) {
    const method = readString(options.method);
    if (method) return method;
  }
  return undefined;
}

function extractUrl(err: Record<string, unknown>): string | undefined {
  const direct = readString(err.url) ?? readString(err.path);
  if (direct) return sanitizeUrl(direct);

  const request = err.request;
  if (isRecord(request)) {
    const value = readString(request.url) ?? readString(request.path);
    if (value) return sanitizeUrl(value);
  }
  const options = err.options;
  if (isRecord(options)) {
    const value = readString(options.url) ?? readString(options.path);
    if (value) return sanitizeUrl(value);
  }
  return undefined;
}

function extractStatusCode(err: Record<string, unknown>): number | undefined {
  const direct = readNumber(err.statusCode) ?? readNumber(err.status);
  if (direct !== undefined) return direct;

  const response = err.response;
  if (isRecord(response)) {
    return readNumber(response.statusCode) ?? readNumber(response.status);
  }
  return undefined;
}

/**
 * Normalizes any value into the four-field shape the logger is allowed to
 * emit for errors, walking `cause` chains to a bounded depth (and guarding
 * against a `cause` cycle, which the language does not forbid).
 */
export function normalizeError(err: unknown, seen: Set<unknown> = new Set()): NormalizedError {
  if (!isNormalizableError(err)) {
    return { message: typeof err === 'string' ? err : 'Unknown error' };
  }

  const record = err as Record<string, unknown>;
  const normalized: NormalizedError = {
    message: readString(record.message) ?? 'Unknown error',
  };

  const method = extractMethod(record);
  if (method !== undefined) normalized.method = method;

  const url = extractUrl(record);
  if (url !== undefined) normalized.url = url;

  const statusCode = extractStatusCode(record);
  if (statusCode !== undefined) normalized.statusCode = statusCode;

  const cause = record.cause;
  if (cause !== undefined && cause !== null && !seen.has(cause) && seen.size < MAX_CAUSE_DEPTH) {
    seen.add(cause);
    normalized.cause = normalizeError(cause, seen);
  }

  return normalized;
}
