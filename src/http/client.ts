/**
 * The single HTTP client for every upstream call (DESIGN.md §9.5 — "the
 * exporter must never issue a non-GET request... enforced in the HTTP
 * client layer, which exposes only a `get()` method, so a write is not
 * merely discouraged but unrepresentable"). Composes the per-backend
 * `undici` Agent (agent.ts), the retry policy (retry.ts), and per-attempt
 * request/response metrics (DESIGN.md §11's `ftd_exporter_upstream_*`
 * pair) into the one call site both backend adapters use.
 *
 * `beforeAttempt` is how the SCC spacing guard, the FMC budget guard, and
 * the FMC concurrency limiter attach to *every* attempt including retries
 * — not just the first — which is what makes "retries count against the
 * limit" (DESIGN.md §3.2.4 point 4, §14.10) true by construction rather
 * than by the caller remembering to re-check it after every retry.
 *
 * Redirects are never followed: this function issues exactly one
 * `undici.request()` per attempt and treats any non-2xx status —
 * including a 3xx with a `Location` header — as a status to classify,
 * never as a cue to issue a second request. This is what DESIGN.md §9.1
 * means by "redirects are not followed automatically for authenticated
 * requests": there is no code path in this module that reads a `Location`
 * header at all.
 *
 * The timeout budget is total, not per-attempt: a fixed real-wall-clock
 * deadline is computed at the top of `get()` and every attempt's
 * `AbortSignal.timeout()` is sized to the time remaining until that
 * deadline (Opus review finding F6 — a fresh signal per attempt let 3
 * retries each consume the full budget, so a configured 30s
 * `REQUEST_TIMEOUT_SECONDS` could stretch to ~90s of attempts plus backoff
 * sleep before giving up, contradicting DESIGN.md §2.5's "every upstream
 * request gets an explicit total-time budget"). Backoff sleeps between
 * attempts count against the same budget, since they are time the caller
 * is waiting on this `get()` call regardless of whether a socket is open.
 *
 * `beforeAttempt` — the SCC spacing guard, the FMC budget guard, and the
 * FMC concurrency limiter — is the one exception: waiting for our *own*
 * cooperative rate limiter is not the request taking too long, it is this
 * client deliberately not sending the request yet, so that wait must not
 * eat into the budget the caller configured for "the request." Two
 * independent Stage 7/8 adversarial reviews found the same bug from
 * opposite sides: a single mandatory 30s SCC spacing wait, or an FMC
 * budget-guard defer, consumed the entire `REQUEST_TIMEOUT_SECONDS` budget
 * before the first byte was ever sent, so a healthy poll landing inside
 * the spacing/budget window failed with a `transient`/`timeout`
 * classification instead of the correct one (or, for a real 429/5xx,
 * failed with a misleading `reason` label and zero retries instead of the
 * configured 3). The fix: each attempt's wait inside `beforeAttempt` is
 * timed with `performance.now()` (real time, deliberately independent of
 * the injected `Clock` — see clock.ts's own note on why this timeout
 * mechanism never depends on a fake clock being advanced) and the deadline
 * is pushed out by exactly that duration before the attempt's own signal
 * is sized. A request that has to wait for rate-limiting still gets its
 * full configured budget once it actually starts.
 */

import type { Dispatcher } from 'undici';
import { request as undiciRequest } from 'undici';
import type { Clock } from './clock.ts';
import { classifyNetworkError, classifyStatusCode, type HttpError } from './errors.ts';
import { parseRetryAfterMs, withRetry } from './retry.ts';

export interface HttpClientOptions {
  dispatcher: Dispatcher;
  clock: Clock;
  /** DESIGN.md §2.5 default: 30 s, from `REQUEST_TIMEOUT_SECONDS`. */
  defaultTimeoutMs: number;
  /** Fired once per completed attempt that received an HTTP response (network-level failures never reach here — there is no status code to label them with). */
  onRequest?: (endpoint: string, statusCode: number, durationSeconds: number) => void;
  onRetry?: (endpoint: string, error: HttpError, attemptNumber: number, delayMs: number) => void;
}

export interface HttpGetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Templated label value for `ftd_exporter_upstream_*{endpoint}` — never an interpolated identifier (DESIGN.md §11). */
  endpoint: string;
  /** Invoked before every attempt, including retries — the spacing/budget/limiter attachment point. */
  beforeAttempt?: () => Promise<void>;
  /**
   * Invoked with every response body actually received, regardless of
   * status code — `--dump-raw`'s attachment point (Stage 11). Fired
   * *before* `resolveError`/`withRetry` decide whether this attempt's
   * status is retryable or fatal, so a 401/404/500 error body (often the
   * single most useful capture for a contributor — Cisco's own
   * `error.messages[].description`, or a wrong-domain-UUID 404) is not
   * lost the moment the client classifies and throws. A network-level
   * failure with no response at all (DNS, connection refused) has no body
   * to offer this hook and correctly never fires it.
   */
  onRawResponse?: (statusCode: number, body: string) => void;
}

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface HttpClient {
  get(url: string, options: HttpGetOptions): Promise<HttpResponse>;
  close(): Promise<void>;
}

interface AttemptResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  retryAfterMs?: number;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  async function performAttempt(
    url: string,
    getOptions: HttpGetOptions,
    signal: AbortSignal,
  ): Promise<AttemptResult> {
    const startedAt = options.clock.now();

    let response: Dispatcher.ResponseData;
    try {
      response = await undiciRequest(url, {
        method: 'GET',
        headers: getOptions.headers ?? {},
        dispatcher: options.dispatcher,
        signal,
      });
    } catch (cause) {
      throw classifyNetworkError(cause);
    }

    const body = await response.body.text();
    const durationSeconds = (options.clock.now() - startedAt) / 1000;
    options.onRequest?.(getOptions.endpoint, response.statusCode, durationSeconds);
    getOptions.onRawResponse?.(response.statusCode, body);

    const retryAfterMs = parseRetryAfterMs(
      firstHeaderValue(response.headers['retry-after']),
      options.clock.wallNow(),
    );

    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    };
  }

  return {
    async get(url: string, getOptions: HttpGetOptions): Promise<HttpResponse> {
      const timeoutMs = getOptions.timeoutMs ?? options.defaultTimeoutMs;
      // Real (non-injected) clock, deliberately — this deadline governs a
      // real `AbortSignal.timeout()`, which never depends on a fake clock
      // being advanced (see clock.ts). Pushed out by exactly the time spent
      // in `beforeAttempt` on every attempt, so a spacing/budget/limiter
      // wait is never charged against the caller's request budget.
      let deadline = performance.now() + timeoutMs;
      const result = await withRetry<AttemptResult>({
        clock: options.clock,
        attempt: async () => {
          if (getOptions.beforeAttempt !== undefined) {
            const waitStartedAt = performance.now();
            await getOptions.beforeAttempt();
            deadline += performance.now() - waitStartedAt;
          }
          // `AbortSignal.timeout()` requires an integer millisecond count;
          // `performance.now()` is sub-millisecond, so the raw remaining
          // duration is a float (e.g. `29999.87`) and throws a RangeError.
          const remainingMs = Math.max(Math.ceil(deadline - performance.now()), 0);
          const signal = AbortSignal.timeout(remainingMs);
          return performAttempt(url, getOptions, signal);
        },
        resolveError: (response) => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            return undefined;
          }
          return classifyStatusCode(response.statusCode, response.retryAfterMs);
        },
        onRetry: (error, attemptNumber, delayMs) => {
          options.onRetry?.(getOptions.endpoint, error, attemptNumber, delayMs);
        },
      });
      return { statusCode: result.statusCode, headers: result.headers, body: result.body };
    },
    async close(): Promise<void> {
      await options.dispatcher.close();
    },
  };
}
