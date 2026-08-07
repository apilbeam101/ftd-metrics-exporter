/**
 * SCC's minimum-spacing guard (DESIGN.md §3.2.4): at least `minSpacingMs`
 * must elapse between requests, enforced in the adapter itself rather than
 * documented as advice. Uses the injected `Clock.now()` (monotonic,
 * `performance.now()`-backed) rather than wall-clock time specifically so
 * a wall-clock adjustment or NTP step cannot let a burst through — see the
 * comment on `Clock` in clock.ts.
 *
 * `wait()` reserves its slot (writes `nextReleaseAt`) synchronously,
 * before awaiting the sleep — Opus review finding F4: an earlier version
 * only wrote `lastReleaseAt` *after* the sleep resolved, so N concurrent
 * `wait()` callers all read the same stale `lastReleaseAt`, all computed
 * the same `remaining`, and all released together (a real-clock repro
 * measured four `wait()` calls releasing at [0, 304, 304, 304]ms against a
 * 300ms floor — three requests fired together at the 304ms mark instead
 * of being serialized 300ms apart). Reserving the next slot up front makes
 * concurrent callers queue behind each other by construction: the second
 * caller's reservation is computed from the first caller's *reservation*,
 * not from when the first caller's sleep happened to finish.
 *
 * One guard instance corresponds to one rate-limited resource (DESIGN.md
 * §3.2.4 phrases the limit as "per FMC UID"; in practice one adapter
 * instance talks to exactly one FMC UID, so one guard per adapter
 * instance is the correct granularity — see DESIGN.md §2.3's "exactly one
 * backend is active per process instance").
 */

import type { Clock } from './clock.ts';

export interface SpacingGuardOptions {
  clock: Clock;
  minSpacingMs: number;
  /** Fired once per `wait()` call that could not proceed immediately, feeding `ftd_exporter_rate_limit_deferrals_total` (DESIGN.md §11) — the SCC backend's only source of that signal, since its concurrency is 1 by construction. */
  onDefer?: () => void;
}

export interface SpacingGuard {
  /** Resolves once at least `minSpacingMs` has elapsed since the previous call's reserved slot. */
  wait(): Promise<void>;
}

export function createSpacingGuard(options: SpacingGuardOptions): SpacingGuard {
  if (!Number.isFinite(options.minSpacingMs) || options.minSpacingMs < 0) {
    throw new RangeError(`minSpacingMs must be a finite number >= 0, got ${options.minSpacingMs}`);
  }

  let nextReleaseAt: number | undefined;

  return {
    async wait(): Promise<void> {
      const now = options.clock.now();
      const releaseAt = nextReleaseAt !== undefined ? Math.max(nextReleaseAt, now) : now;
      const delay = releaseAt - now;
      nextReleaseAt = releaseAt + options.minSpacingMs;
      if (delay > 0) {
        options.onDefer?.();
        await options.clock.sleep(delay);
      }
    },
  };
}
