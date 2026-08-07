/**
 * The six-class error taxonomy from DESIGN.md §2.5. `HttpError` is a real
 * `Error` subclass (not a plain object) — Opus review finding F10: a
 * plain-object error has no stack trace, stringifies as `[object Object]`
 * through generic error-handling paths, and is silently discarded by
 * `error-normalize.ts`'s error-shape duck-typing at the logger boundary.
 * Carrying `.class`/`.reason` as fields on a real `Error` lets a caller
 * `switch` on them exhaustively while still behaving like every other
 * thrown error in the codebase.
 *
 * `classifyNetworkError` is idempotent — passing an already-classified
 * `HttpError` back through it returns the same instance unchanged (review
 * finding F1: `withRetry`'s catch block previously called
 * `classifyNetworkError` on whatever `attempt()` threw without checking
 * whether it was already an `HttpError`, e.g. from a `beforeAttempt` hook
 * throwing a classified `auth_fatal`/`fatal_config` error. Since an
 * `HttpError` is not an `instanceof Error`-compatible network exception,
 * re-classifying it collapsed its real class/reason to
 * `transient`/`network` and stringified it to `[object Object]`, which
 * both destroyed the diagnostic message and caused a non-retryable error
 * to be retried 3 times instead of propagating immediately). Every call
 * site that might receive an already-classified error from a nested
 * operation MUST go through `classifyNetworkError`, not construct its own
 * fallback, so this idempotence guarantee is the thing that makes that
 * safe.
 */

export type HttpErrorClass =
  | 'fatal_config'
  | 'auth_recoverable'
  | 'auth_fatal'
  | 'rate_limited'
  | 'transient'
  | 'schema_parse';

export type PollErrorReason =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'http_5xx'
  | 'parse'
  | 'unknown';

/** Runtime-checkable form of `PollErrorReason` (DESIGN.md §11's bounded label set) — used at the poller/self-metrics boundary to guard against a value that type-checks today but reaches that boundary through an `unknown`-typed catch or a future taxonomy change. */
export const POLL_ERROR_REASON_VALUES: readonly PollErrorReason[] = [
  'auth',
  'rate_limited',
  'timeout',
  'network',
  'http_5xx',
  'parse',
  'unknown',
];

export interface HttpErrorInit {
  class: HttpErrorClass;
  reason: PollErrorReason;
  message: string;
  statusCode?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class HttpError extends Error {
  readonly class: HttpErrorClass;
  readonly reason: PollErrorReason;
  declare readonly statusCode?: number;
  declare readonly retryAfterMs?: number;

  constructor(init: HttpErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'HttpError';
    this.class = init.class;
    this.reason = init.reason;
    if (init.statusCode !== undefined) {
      this.statusCode = init.statusCode;
    }
    if (init.retryAfterMs !== undefined) {
      this.retryAfterMs = init.retryAfterMs;
    }
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

const RETRYABLE_CLASSES: ReadonlySet<HttpErrorClass> = new Set(['transient', 'rate_limited']);

export function isRetryable(error: HttpError): boolean {
  return RETRYABLE_CLASSES.has(error.class);
}

/**
 * Classifies a completed HTTP response by status code alone (DESIGN.md
 * §2.5's table: 429 -> rate limited; 5xx -> transient; 401/403 -> not
 * retried (auth-fatal, split from auth-recoverable by the caller since
 * that distinction depends on which backend is asking). Anything else
 * (3xx, 1xx, or a 4xx other than 401/403/429) has no row in DESIGN.md's
 * table — `schema_parse`/`unknown` is the closest fit as "not a status
 * this client has a specific bucket for," not a claim that a response
 * body failed to parse. The message is deliberately specific per status
 * range so an operator reading `ftd_exporter_poll_errors_total` or a log
 * line can tell a 302 (client.ts never follows redirects, DESIGN.md §9.1)
 * from a plain unexpected 4xx, even though both land on the same bounded
 * `reason=unknown` label value.
 */
export function classifyStatusCode(statusCode: number, retryAfterMs?: number): HttpError {
  if (statusCode === 429) {
    return new HttpError({
      class: 'rate_limited',
      reason: 'rate_limited',
      message: 'upstream returned 429 Too Many Requests',
      statusCode,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
  }
  if (statusCode === 401 || statusCode === 403) {
    return new HttpError({
      class: 'auth_fatal',
      reason: 'auth',
      message: `upstream returned ${statusCode}`,
      statusCode,
    });
  }
  if (statusCode >= 500) {
    return new HttpError({
      class: 'transient',
      reason: 'http_5xx',
      message: `upstream returned ${statusCode}`,
      statusCode,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
  }
  if (statusCode >= 300 && statusCode < 400) {
    return new HttpError({
      class: 'schema_parse',
      reason: 'unknown',
      message: `upstream returned an unfollowed redirect (${statusCode}) — this client never follows redirects for authenticated requests (DESIGN.md §9.1)`,
      statusCode,
    });
  }
  return new HttpError({
    class: 'schema_parse',
    reason: 'unknown',
    message: `upstream returned unexpected status ${statusCode}`,
    statusCode,
  });
}

const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

/**
 * Classifies a network-level failure (connection refused, DNS failure, TLS
 * handshake failure, or an aborted request) into the taxonomy. TLS/cert
 * errors are deliberately `transient` here rather than a dedicated class:
 * DESIGN.md doesn't carve out a seventh category for them, and treating a
 * persistent cert misconfiguration as transient just means it retries
 * (bounded, per the retry policy) and then surfaces as a poll failure —
 * the operator-facing signal DESIGN.md actually wants is the loud startup
 * warning / `ftd_exporter_tls_verification_disabled` metric, not a special
 * runtime error class.
 */
export function classifyNetworkError(cause: unknown): HttpError {
  if (cause instanceof HttpError) {
    return cause;
  }
  if (cause instanceof Error && ABORT_ERROR_NAMES.has(cause.name)) {
    return new HttpError({
      class: 'transient',
      reason: 'timeout',
      message: 'request aborted (timeout budget exceeded)',
      cause,
    });
  }
  const message = cause instanceof Error ? cause.message : safeStringify(cause);
  return new HttpError({
    class: 'transient',
    reason: 'network',
    message,
    cause,
  });
}

/**
 * `String(cause)` throws for a value with no usable `toString`/`Symbol.toPrimitive`
 * (e.g. `Object.create(null)`, or `{ toString: null }`) — a thrown non-Error
 * value is already the unusual case; a value this hostile must not crash the
 * classification path itself, since that path runs inside `withRetry`'s and
 * `poller.ts`'s own catch blocks and has no further fallback above it.
 */
function safeStringify(value: unknown): string {
  try {
    return String(value);
  } catch {
    return `[unstringifiable value of type ${typeof value}]`;
  }
}
