import type { Clock } from '../../http/clock.ts';

/**
 * Generic refresh-if-due cache, split into an async poll-path half and a
 * sync render-path half — the same shape `scc/inventory.ts` established for
 * SCC device inventory, generalized here because the license-status and
 * device-certificates features need the identical split on *both* backends
 * (four call sites total), unlike device inventory, which stays SCC-only
 * and is not retrofitted onto this generic to avoid touching already-
 * reviewed code with no behavioral need to change.
 *
 * `refreshIfDue()` must only ever be called from the poll path, never the
 * render path (DESIGN.md §2.2's poll-cache-serve contract) — the render
 * path calls only `getCached()`, which is synchronous and network-free.
 * A refresh failure keeps the previous value and does not throw, so an
 * inventory/license/certificate hiccup never fails an otherwise-successful
 * health poll cycle.
 */
export interface CreateRefreshCacheOptions<T> {
  clock: Clock;
  intervalMs: number;
  fetch: () => Promise<T>;
  initialValue: T;
  onFailure?: () => void;
}

export interface RefreshCache<T> {
  refreshIfDue(): Promise<void>;
  getCached(): T;
}

export function createRefreshCache<T>(options: CreateRefreshCacheOptions<T>): RefreshCache<T> {
  let cached = options.initialValue;
  let lastSuccessAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  async function runRefresh(): Promise<void> {
    try {
      cached = await options.fetch();
      lastSuccessAt = options.clock.now();
    } catch {
      options.onFailure?.();
    }
  }

  return {
    refreshIfDue(): Promise<void> {
      if (inFlight !== undefined) {
        return inFlight;
      }
      const isDue =
        lastSuccessAt === undefined || options.clock.now() - lastSuccessAt >= options.intervalMs;
      if (!isDue) {
        return Promise.resolve();
      }
      const promise = runRefresh().finally(() => {
        if (inFlight === promise) {
          inFlight = undefined;
        }
      });
      inFlight = promise;
      return promise;
    },
    getCached(): T {
      return cached;
    },
  };
}
