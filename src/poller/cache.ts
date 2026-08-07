import type { DeviceHealthSnapshot } from '../domain/snapshot.ts';
import type { Clock } from '../http/clock.ts';

/**
 * DESIGN.md §2.2: "an internal timer polls upstream and caches the last-good
 * result... atomically replaces an in-memory cache." A single mutable
 * binding holding an immutable `CacheEntry`, replaced only by reference
 * assignment in `set()` — never mutated in place — is what makes a
 * concurrent render (Stage 3's `renderDeviceMetrics`, called synchronously
 * with no `await` in between) always see either wholly the old entry or
 * wholly the new one, never a partially-updated one. `get()` returns
 * `undefined` before the first successful poll, which is exactly the signal
 * Stage 10's `/readyz` needs (DESIGN.md §7.2: 503 until the cache has been
 * populated).
 *
 * `fetchedAt` is a monotonic (`Clock.now()`-backed) timestamp, not a wall
 * timestamp — cache age is an elapsed-time computation and must not be
 * disturbed by a wall-clock adjustment or NTP step, matching every other
 * elapsed-time measurement in this codebase (see clock.ts).
 */
export interface CacheEntry {
  readonly snapshots: readonly DeviceHealthSnapshot[];
  readonly fetchedAt: number;
}

export interface MetricsCache {
  /** `undefined` until the first successful poll populates the cache. */
  get(): CacheEntry | undefined;
  set(entry: CacheEntry): void;
}

export function createMetricsCache(): MetricsCache {
  let current: CacheEntry | undefined;
  return {
    get(): CacheEntry | undefined {
      return current;
    },
    set(entry: CacheEntry): void {
      current = entry;
    },
  };
}

/**
 * `ftd_exporter_cache_age_seconds` (DESIGN.md §11) is "computed at scrape
 * time," per self.ts's `cacheAgeSecondsCollect` hook — this is the pure
 * function that hook calls. Age is `0` before the first successful poll
 * (an empty cache has no staleness to report; `/readyz` being `503` at that
 * point is the correct signal, not a large or negative age value).
 *
 * Clamped at 0 rather than returning a raw (possibly negative) delta: while
 * the poller and this collector share one `Clock` instance today, they are
 * wired independently by Stage 10/11's caller, and `Clock.now()` is
 * `performance.now()`-backed with an origin that is only guaranteed
 * consistent within one such instance — a negative "age" on this gauge
 * would be a nonsensical, confusing value to alert on.
 */
export function cacheAgeSecondsCollector(cache: MetricsCache, clock: Clock): () => number {
  return () => {
    const entry = cache.get();
    return entry === undefined ? 0 : Math.max(0, (clock.now() - entry.fetchedAt) / 1000);
  };
}
