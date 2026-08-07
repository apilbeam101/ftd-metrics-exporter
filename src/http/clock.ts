/**
 * Injectable time source for the spacing/budget/retry guards (DESIGN.md §3.2.4,
 * §3.3.4, §2.5). Two clocks are exposed because they answer different
 * questions: `now()` is monotonic (`performance.now()`-backed) and is what the
 * SCC spacing guard measures elapsed time against, per DESIGN.md §3.2.4's
 * explicit "monotonic-clock guard... so a wall-clock adjustment or NTP step
 * cannot let a burst through." `wallNow()` is real wall-clock time
 * (`Date.now()`-backed) and exists only for resolving an HTTP-date-form
 * `Retry-After` header into a delay, which is inherently an absolute
 * wall-clock computation.
 *
 * `sleep()` is the one method a fake clock must intercept for tests to run
 * without waiting on real timers — see the risk note in
 * IMPLEMENTATION_PLAN.md Stage 6 ("undici has internal timers; a naive fake
 * clock can deadlock a test"). Only *our* retry/limiter/guard code is routed
 * through this `Clock`; the per-request `AbortSignal` timeout budget in
 * client.ts deliberately uses real `setTimeout` so it never depends on a
 * fake clock being advanced.
 */
export interface Clock {
  now(): number;
  wallNow(): number;
  sleep(ms: number): Promise<void>;
}

export function createRealClock(): Clock {
  return {
    now: () => performance.now(),
    wallNow: () => Date.now(),
    sleep: (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
