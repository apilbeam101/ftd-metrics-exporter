/**
 * Deterministic clock for the http/* unit tests (IMPLEMENTATION_PLAN.md
 * Stage 6 dependency: "Every limiter/retry test depends on this").
 * `sleep()` advances the fake clock's own time immediately rather than
 * waiting on a real timer, and `advance()` lets a test move time forward
 * without a corresponding sleep (e.g. simulating "30 minutes passed").
 *
 * Known limitation (Opus review finding F11): because `sleep()` advances
 * time synchronously at the call site rather than yielding to a real
 * timer queue, concurrent callers racing on `await clock.sleep(...)` all
 * observe the same instant regardless of call order — this clock cannot
 * reproduce a genuine interleaving/ordering bug among concurrent async
 * callers (see the "concurrent wait() calls serialize" test in
 * http-spacing.test.ts, which uses `createRealClock()` for exactly this
 * reason). Use the fake clock for single-caller sequencing and for
 * asserting elapsed-time math; reach for the real clock whenever a test's
 * point is to verify behavior *under concurrency*.
 */
import type { Clock } from '../../../src/http/clock.ts';

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function createFakeClock(startMs = 0): FakeClock {
  let monotonic = startMs;
  let wall = startMs;

  return {
    now: () => monotonic,
    wallNow: () => wall,
    advance(ms: number) {
      monotonic += ms;
      wall += ms;
    },
    sleep(ms: number): Promise<void> {
      monotonic += ms;
      wall += ms;
      return Promise.resolve();
    },
  };
}
