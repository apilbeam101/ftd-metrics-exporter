import type { HealthBackend } from '../backends/types.ts';
import type { Clock } from '../http/clock.ts';
import {
  classifyNetworkError,
  HttpError,
  POLL_ERROR_REASON_VALUES,
  type PollErrorReason,
} from '../http/errors.ts';
import type { Logger } from '../log/logger.ts';
import type { SelfMetrics } from '../metrics/self.ts';
import type { MetricsCache } from './cache.ts';

/**
 * The poll loop (DESIGN.md §2.2, §2.5, plan Stage 9). Self-schedules with
 * `Clock.sleep()` rather than a fixed-rate `setInterval` — the next cycle's
 * delay is only computed, and its wait only begins, after the current
 * cycle's `fetchSnapshot()` call has fully settled. This makes "cycles
 * never overlap" a structural property of the loop rather than a runtime
 * check: there is no timer that can fire while a cycle is still running,
 * because no such timer is ever armed until the running cycle finishes.
 *
 * Scheduling goes through the injected `Clock` (not a bare `setTimeout`)
 * for the same reason the spacing/budget guards do (clock.ts) — it is a
 * cooperative, non-network wait, so a fake clock in tests can resolve it
 * instantly and drive many cycles without real wall-clock delay. This is
 * distinct from client.ts's request-level `AbortSignal.timeout()`, which
 * deliberately never depends on a fake clock for the reasons documented
 * there.
 *
 * `HealthBackend.fetchSnapshot()` takes no `AbortSignal` (DESIGN.md §2.3's
 * interface is verbatim and not renegotiated here), so an in-flight upstream
 * call cannot actually be cancelled at the socket level. "Abortable via
 * AbortSignal for shutdown" therefore means: once the supplied signal fires,
 * the loop stops scheduling further cycles, and if a cycle is already
 * in-flight, its eventual result (success or failure) is discarded rather
 * than committed to the cache or metrics — the cycle's outcome is simply
 * never observed, so shutdown never races a cache write.
 *
 * Two properties this module holds itself to, both found missing by an
 * Opus review of the first cut of this stage:
 *
 * (1) **A resolved `fetchSnapshot()` with zero devices is not automatically
 *     "success."** Both adapters resolve to `[]` (never throw) on a total
 *     upstream failure — SCC on an unparseable/non-array body, FMC when
 *     every device/family request in the cycle fails. Treating that the
 *     same as a genuinely empty fleet would invert DESIGN.md §2.2's central
 *     guarantee: `up`, `cache_age_seconds`, and
 *     `last_successful_poll_timestamp_seconds` would all report "healthy
 *     and fresh" while the cache silently went empty — worse than a gap,
 *     since none of the staleness signals would ever fire. `fetchSnapshot()`
 *     itself carries no such signal (DESIGN.md §2.3's interface is fixed),
 *     so this module relies on `ParseErrorTracker` (below), which the
 *     caller wires to the adapter's own `onParseError` callback: a cycle
 *     that resolves to zero devices *and* recorded at least one parse error
 *     is treated as a failure, not a success. A resolved zero-device result
 *     with zero recorded parse errors is still a legitimate empty snapshot.
 * (2) **`runCycle()` must never reject, and `loop()` must never let one bad
 *     cycle end the schedule.** A throw from anything downstream of the
 *     `fetchSnapshot()` call — a broken `onCycleComplete` consumer, or the
 *     default logger sink hitting `EPIPE` on a dead stdout — used to become
 *     an unhandled rejection that permanently stopped scheduling further
 *     cycles, with `ftd_exporter_up` frozen at whatever it last was
 *     (typically `1`): a fully dead poller that still reports healthy.
 *     Every side effect after the classification step is now individually
 *     guarded so one failing side effect cannot suppress the others or the
 *     loop itself; `loop()` and `start()` each carry their own backstop on
 *     top of that as defense in depth.
 */

export interface PollCycleResult {
  outcome: 'success' | 'failure';
  deviceCount: number;
  durationSeconds: number;
  reason?: PollErrorReason;
}

export type PollerMetrics = Pick<
  SelfMetrics,
  | 'up'
  | 'pollTotal'
  | 'pollErrorsTotal'
  | 'pollDurationSeconds'
  | 'lastSuccessfulPollTimestampSeconds'
  | 'devices'
>;

/**
 * Bridges a per-device/per-group `ParseError` stream (the adapters' existing
 * `onParseError` callback — see `CreateSccAdapterOptions`/
 * `CreateFmcAdapterOptions`) to the poller's own "was this cycle's
 * zero-device result actually a total parse failure" check. The caller
 * (whoever constructs both the backend adapter and the poller — Stage 11's
 * `index.ts`) MUST wire `record()` as part of the adapter's `onParseError`
 * callback for property (1) in this module's doc comment to actually hold;
 * without it, `parseErrorTracker` is simply absent and a zero-device parse
 * failure is indistinguishable from a genuinely empty fleet, exactly as it
 * was before this fix.
 */
export interface ParseErrorTracker {
  /** Call once per `ParseError` produced anywhere during a `fetchSnapshot()` call. */
  record(): void;
  /** Called once per poll cycle by the poller: returns the count recorded since the last call and resets it to 0. */
  consumeSinceLastCycle(): number;
}

export function createParseErrorTracker(): ParseErrorTracker {
  let count = 0;
  return {
    record(): void {
      count++;
    },
    consumeSinceLastCycle(): number {
      const consumed = count;
      count = 0;
      return consumed;
    },
  };
}

export interface CreatePollerOptions {
  backend: HealthBackend;
  cache: MetricsCache;
  clock: Clock;
  logger: Logger;
  pollIntervalSeconds: number;
  metrics: PollerMetrics;
  /** See `ParseErrorTracker`'s doc comment — required for a total-parse-failure cycle to be correctly treated as a failure rather than an empty success. */
  parseErrorTracker?: ParseErrorTracker;
  /** Fires when shutdown should begin (Stage 11). An in-flight cycle's result is discarded once this signal fires. */
  signal?: AbortSignal;
  /** Test hook overriding the startup-jitter source; defaults to `Math.random`. */
  random?: () => number;
  /** DESIGN.md §2.5: escalating poll-level backoff caps at 10 minutes. Overridable for tests. */
  maxBackoffMs?: number;
  /** Fired after every completed (non-aborted) cycle — lets tests observe cycle outcomes without parsing log lines. */
  onCycleComplete?: (result: PollCycleResult) => void;
}

export interface Poller {
  /** Schedules the first poll (after startup jitter) and every subsequent one. Calling more than once is a no-op. */
  start(): void;
  /** Stops scheduling further cycles. Idempotent. */
  stop(): void;
}

const DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000;
/** DESIGN.md §2.5: "a small random delay (0-10% of the poll interval)". */
const JITTER_FRACTION = 0.1;

/**
 * Races `clock.sleep(ms)` against `signal` firing, so `stop()` interrupts an
 * in-progress jitter/interval/backoff wait immediately rather than only
 * taking effect on the next loop iteration — real-clock backoff can reach
 * 10 minutes (DESIGN.md §2.5's cap), and shutdown must not have to wait that
 * long. The underlying `clock.sleep()` timer is not cancelled (`Clock` has
 * no cancellation primitive, by design — see clock.ts); it simply fires
 * later into a loop that has already exited and observes no effect. Timer
 * handle lifetime (ref/unref) is explicitly Stage 11's concern, not this
 * function's (IMPLEMENTATION_PLAN.md Stage 9 risks) — but note that an
 * Opus review measured this concretely: a real, still-ref'd `setTimeout`
 * from an in-progress sleep keeps the process alive for up to the full
 * pending delay (10 minutes at the backoff cap) after `stop()` returns,
 * which Stage 11 must account for against Kubernetes'
 * `terminationGracePeriodSeconds` (commonly 30s) — `stop()` alone is not
 * sufficient for a fast, clean process exit; `clock.ts` or this function
 * will need a cancellable sleep primitive to close that gap.
 */
function abortableSleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    clock.sleep(ms).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/** `httpError.reason` is typed to the bounded `PollErrorReason` union, but an already-classified `HttpError` can arrive here from anywhere upstream (a cast, a future taxonomy change, a hand-constructed test double) — re-validated at this boundary rather than trusted, since an unbounded value on the exporter's *own* `poll_errors_total{reason}` is itself the cardinality bug DESIGN.md §11 exists to prevent. */
function boundedReason(reason: PollErrorReason): PollErrorReason {
  return POLL_ERROR_REASON_VALUES.includes(reason) ? reason : 'unknown';
}

export function createPoller(options: CreatePollerOptions): Poller {
  const intervalMs = options.pollIntervalSeconds * 1000;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;

  const controller = new AbortController();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  let consecutiveFailures = 0;
  let started = false;

  function nextDelayMs(): number {
    if (consecutiveFailures === 0) {
      return intervalMs;
    }
    return Math.min(intervalMs * 2 ** consecutiveFailures, maxBackoffMs);
  }

  /**
   * Runs `fn`, logging and swallowing any throw rather than letting it
   * propagate — used for every post-classification side effect (metrics,
   * logging, the caller's `onCycleComplete`) so one failing side effect
   * (Opus review F2: a broken `onCycleComplete` consumer, or the default
   * logger sink hitting `EPIPE` on a dead stdout) cannot suppress the
   * others or, worse, escape `runCycle()` as an unhandled rejection that
   * permanently stops the loop with `ftd_exporter_up` frozen healthy.
   */
  function safely(description: string, fn: () => void): void {
    try {
      fn();
    } catch (cause) {
      try {
        options.logger.error(`poller: ${description} failed and was suppressed`, {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } catch {
        // The logger itself is the thing that's broken (e.g. a dead stdout
        // sink) — there is nothing further this function can do.
      }
    }
  }

  async function runCycle(): Promise<void> {
    const startedAt = options.clock.now();
    let result: PollCycleResult;

    try {
      const snapshots = await options.backend.fetchSnapshot();
      if (controller.signal.aborted) {
        return;
      }

      const parseErrorsThisCycle = options.parseErrorTracker?.consumeSinceLastCycle() ?? 0;
      if (snapshots.length === 0 && parseErrorsThisCycle > 0) {
        // A resolved, zero-device fetchSnapshot() that also recorded a
        // parse error is a total parse/mapping failure that happened not
        // to throw (both adapters return [] rather than reject on this
        // class of failure) — routed through the same catch block below so
        // it is classified and recorded as a poll failure, not committed to
        // the cache as a healthy empty snapshot (see this module's doc
        // comment, property (1)).
        throw new HttpError({
          class: 'schema_parse',
          reason: 'parse',
          message:
            `fetchSnapshot() produced zero devices after ${parseErrorsThisCycle} parse ` +
            'error(s) recorded this cycle — treated as a failed poll, not an empty snapshot',
        });
      }

      const durationSeconds = (options.clock.now() - startedAt) / 1000;
      result = { outcome: 'success', deviceCount: snapshots.length, durationSeconds };
      options.cache.set({ snapshots, fetchedAt: options.clock.now() });
      options.metrics.up.set(1);
      options.metrics.lastSuccessfulPollTimestampSeconds.set(options.clock.wallNow() / 1000);
      options.metrics.devices.set(snapshots.length);
      consecutiveFailures = 0;
    } catch (cause) {
      if (controller.signal.aborted) {
        return;
      }
      const durationSeconds = (options.clock.now() - startedAt) / 1000;
      const httpError = classifyNetworkError(cause);
      const reason = boundedReason(httpError.reason);
      result = {
        outcome: 'failure',
        deviceCount: 0,
        durationSeconds,
        reason,
      };
      options.metrics.up.set(0);
      options.metrics.pollErrorsTotal.inc({ reason });
      consecutiveFailures++;
    }

    safely('incrementing poll_total', () => options.metrics.pollTotal.inc());
    safely('observing poll_duration_seconds', () =>
      options.metrics.pollDurationSeconds.observe(result.durationSeconds),
    );
    safely('logging poll cycle completion', () =>
      options.logger.info('poll cycle complete', {
        outcome: result.outcome,
        devices: result.deviceCount,
        duration_seconds: result.durationSeconds,
        ...(result.reason !== undefined && { reason: result.reason }),
      }),
    );
    if (result.durationSeconds * 1000 > intervalMs) {
      safely('logging slow-cycle warning', () =>
        options.logger.warn(
          'poll cycle took longer than POLL_INTERVAL_SECONDS — the next poll is delayed rather ' +
            'than overlapping; consider raising POLL_INTERVAL_SECONDS or reducing request volume',
          {
            duration_seconds: result.durationSeconds,
            poll_interval_seconds: options.pollIntervalSeconds,
          },
        ),
      );
    }
    safely('invoking onCycleComplete', () => options.onCycleComplete?.(result));
  }

  async function loop(): Promise<void> {
    const jitterMs = random() * intervalMs * JITTER_FRACTION;
    await abortableSleep(options.clock, jitterMs, controller.signal);
    while (!controller.signal.aborted) {
      try {
        await runCycle();
      } catch (cause) {
        // runCycle() is designed to never reject (see this module's doc
        // comment, property (2)) — this is a last-resort backstop, not the
        // primary defense, so a defect in that guarantee still leaves the
        // loop scheduling further cycles rather than dying silently.
        safely('running a poll cycle', () => {
          throw cause;
        });
      }
      if (controller.signal.aborted) {
        return;
      }
      await abortableSleep(options.clock, nextDelayMs(), controller.signal);
    }
  }

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      // `loop()` should never reject given the try/catch above; this
      // `.catch()` is pure defense-in-depth so `start()` can never produce
      // an unhandled rejection under any circumstance.
      loop().catch(() => {});
    },
    stop(): void {
      controller.abort();
    },
  };
}
