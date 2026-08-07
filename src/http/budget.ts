/**
 * FMC's rolling-window request budget guard (DESIGN.md §3.3.4: throttle to
 * stay under 300 GETs per 60 seconds). Implemented as a sliding-window
 * log: each `acquire()` records a monotonic timestamp, and a request is
 * let through immediately only if fewer than `maxRequests` timestamps
 * remain within the trailing `windowMs`; otherwise it waits until the
 * oldest timestamp ages out of the window.
 *
 * `acquire()` must be called for every upstream attempt, including
 * retries of a failed request — DESIGN.md §14.10's open question ("does a
 * failed request count against the limit?") is answered conservatively
 * as yes, per the plan's Stage 6 scope ("counts every attempt including
 * retries, per the conservative reading of §14.10"). Call sites therefore
 * call `acquire()` inside the retry loop, once per attempt, not once per
 * logical request.
 */

import type { Clock } from './clock.ts';

export interface BudgetGuardOptions {
  clock: Clock;
  maxRequests: number;
  windowMs: number;
  onDefer?: () => void;
}

export interface BudgetGuard {
  /** Resolves once the request is within budget, recording it against the rolling window. */
  acquire(): Promise<void>;
}

export function createBudgetGuard(options: BudgetGuardOptions): BudgetGuard {
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
    throw new RangeError(`maxRequests must be an integer >= 1, got ${options.maxRequests}`);
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
    throw new RangeError(`windowMs must be a finite number > 0, got ${options.windowMs}`);
  }

  const timestamps: number[] = [];

  function pruneExpired(now: number): void {
    while (timestamps.length > 0 && now - (timestamps[0] as number) >= options.windowMs) {
      timestamps.shift();
    }
  }

  return {
    async acquire(): Promise<void> {
      let deferred = false;
      for (;;) {
        const now = options.clock.now();
        pruneExpired(now);
        if (timestamps.length < options.maxRequests) {
          timestamps.push(now);
          return;
        }
        if (!deferred) {
          deferred = true;
          options.onDefer?.();
        }
        const oldest = timestamps[0] as number;
        const waitMs = options.windowMs - (now - oldest);
        await options.clock.sleep(Math.max(waitMs, 1));
      }
    },
  };
}
