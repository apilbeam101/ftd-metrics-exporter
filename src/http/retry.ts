/**
 * Retry policy from DESIGN.md §2.5: max 3 attempts, exponential backoff
 * with full jitter (base 500 ms, cap 8 s), retrying only transient classes
 * and 429 (rate_limited); `Retry-After` honored when present. Idempotent
 * GETs only, so retrying is always safe (DESIGN.md §9.5 — the client only
 * ever issues GET).
 */

import type { Clock } from './clock.ts';
import { classifyNetworkError, HttpError, isRetryable } from './errors.ts';

export const MAX_ATTEMPTS = 3;
export const BASE_DELAY_MS = 500;
export const CAP_DELAY_MS = 8_000;

export interface RetryableResponse {
  statusCode: number;
}

export interface RetryOptions<T extends RetryableResponse> {
  clock: Clock;
  /** Performs one attempt; rejects with the thrown network-level error on failure. */
  attempt: () => Promise<T>;
  /** True for the small set of statuses this attempt should raise as an error rather than return, e.g. `resolveError(res)` -> `HttpError | undefined`. */
  resolveError: (response: T) => HttpError | undefined;
  onRetry?: (error: HttpError, attemptNumber: number, delayMs: number) => void;
}

/**
 * Parses `Retry-After` (RFC 9110 §10.2.3: either an integer number of
 * seconds or an HTTP-date). Rejects anything that is not all-digits before
 * treating it as seconds — `"5.5"` and `"-5"` previously fell through to
 * `Date.parse`, which accepts both as free-form date strings and returns a
 * bogus (near-zero-clamped) delay rather than being rejected outright
 * (Opus review finding F3). The parsed seconds value is also capped at
 * `MAX_RETRY_AFTER_MS` — RFC 9110 permits an arbitrarily large
 * `Retry-After`, but DESIGN.md §2.5 bounds this client's own backoff at
 * `CAP_DELAY_MS` and a legal-but-huge upstream value (a malicious or
 * misconfigured proxy sending `Retry-After: 86400`) must not be allowed to
 * block a `get()` call for a day.
 */
const MAX_RETRY_AFTER_MS = CAP_DELAY_MS;

/**
 * Malformed-but-numeric-looking values (`"5.5"`, `"-5"`, `"+5"`) must be
 * rejected outright rather than falling through to `Date.parse` — Opus
 * review finding F3: `Date.parse('5.5')` and `Date.parse('-5')` both
 * "succeed" (parsed as an implausible date decades away), producing a
 * near-zero clamped delay once the delta is taken against `wallNowMs`.
 * The practical effect is an instant retry against an endpoint that just
 * asked for backoff — a self-inflicted retry storm. This pattern matches
 * anything that looks like a decimal/signed number so it is rejected
 * before `Date.parse` ever sees it; a genuine HTTP-date never matches it.
 */
const MALFORMED_NUMERIC_PATTERN = /^[+-]?\d*\.?\d+$/;

export function parseRetryAfterMs(
  value: string | undefined,
  wallNowMs: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
  }
  if (MALFORMED_NUMERIC_PATTERN.test(trimmed)) {
    return undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  const delta = dateMs - wallNowMs;
  return Math.min(Math.max(delta, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Full-jitter backoff (AWS's "Exponential Backoff And Jitter" formula):
 * a uniformly random delay in `[0, min(cap, base * 2^attempt)]`. Full
 * jitter (rather than capped-exponential-with-no-jitter) is what
 * DESIGN.md §2.5 asks for, and is also what prevents a fleet of restarted
 * replicas from retrying in lockstep.
 */
export function computeBackoffMs(attemptNumber: number): number {
  const envelope = Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** attemptNumber);
  return Math.random() * envelope;
}

/**
 * Thrown when the retry budget is exhausted. Extends `HttpError` itself
 * (rather than wrapping one) so a caller reading `.class`/`.reason` off a
 * caught error gets the *last* attempt's real classification —
 * `reason="rate_limited"` for a 429 that never recovered,
 * `reason="http_5xx"` for a 503 that never recovered — instead of a
 * taxonomy-less `unknown` (Opus review finding F2: the previous plain
 * `Error` subclass had no `.class`/`.reason` fields at all, so every
 * exhausted-retry outcome collapsed to `reason="unknown"` regardless of
 * why it was retried, which defeats DESIGN.md §3.2.4 point 5's
 * requirement that a 429 specifically increment
 * `poll_errors_total{reason="rate_limited"}`).
 */
export class RetriesExhaustedError extends HttpError {
  constructor(lastError: HttpError) {
    super({
      class: lastError.class,
      reason: lastError.reason,
      message: `retries exhausted: ${lastError.message}`,
      ...(lastError.statusCode !== undefined && { statusCode: lastError.statusCode }),
      ...(lastError.retryAfterMs !== undefined && { retryAfterMs: lastError.retryAfterMs }),
      cause: lastError,
    });
    this.name = 'RetriesExhaustedError';
  }
}

/**
 * Runs `attempt()` up to `MAX_ATTEMPTS` times. Non-retryable classes
 * (fatal_config, auth_recoverable, auth_fatal, schema_parse) propagate
 * immediately on the first occurrence — DESIGN.md §2.5's table lists these
 * as "no retry" outcomes, not merely "retry less." Because
 * `classifyNetworkError` is idempotent (errors.ts), a `beforeAttempt` hook
 * (the Stage 7/8 spacing/budget/token-manager attachment point) that
 * throws an already-classified `HttpError` — e.g. `auth_fatal` from a
 * failed re-auth — passes through unchanged here rather than being
 * relabelled `transient`/`network` and incorrectly retried.
 */
export async function withRetry<T extends RetryableResponse>(options: RetryOptions<T>): Promise<T> {
  let lastError: HttpError | undefined;

  for (let attemptNumber = 0; attemptNumber < MAX_ATTEMPTS; attemptNumber++) {
    let response: T;
    try {
      response = await options.attempt();
    } catch (cause) {
      const error = classifyNetworkError(cause);
      if (!isRetryable(error) || attemptNumber === MAX_ATTEMPTS - 1) {
        throw isRetryable(error) ? new RetriesExhaustedError(error) : error;
      }
      lastError = error;
      const delayMs = computeBackoffMs(attemptNumber);
      options.onRetry?.(error, attemptNumber + 1, delayMs);
      await options.clock.sleep(delayMs);
      continue;
    }

    const httpError = options.resolveError(response);
    if (httpError === undefined) {
      return response;
    }
    if (!isRetryable(httpError) || attemptNumber === MAX_ATTEMPTS - 1) {
      throw isRetryable(httpError) ? new RetriesExhaustedError(httpError) : httpError;
    }
    lastError = httpError;
    const delayMs =
      httpError.retryAfterMs !== undefined
        ? httpError.retryAfterMs
        : computeBackoffMs(attemptNumber);
    options.onRetry?.(httpError, attemptNumber + 1, delayMs);
    await options.clock.sleep(delayMs);
  }

  throw new RetriesExhaustedError(lastError as HttpError);
}
