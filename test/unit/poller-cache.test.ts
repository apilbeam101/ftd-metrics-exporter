import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheAgeSecondsCollector, createMetricsCache } from '../../src/poller/cache.ts';
import { createFakeClock } from './support/fake-clock.ts';

test('createMetricsCache: get() returns undefined before any set()', () => {
  const cache = createMetricsCache();
  assert.equal(cache.get(), undefined);
});

test('createMetricsCache: set() then get() returns the same entry by reference', () => {
  const cache = createMetricsCache();
  const entry = { snapshots: [], fetchedAt: 123 };
  cache.set(entry);
  assert.equal(cache.get(), entry);
});

test('createMetricsCache: a later set() replaces the entry wholesale, never mutating the previous one', () => {
  const cache = createMetricsCache();
  const first = { snapshots: [{ deviceUid: 'a', deviceName: 'a' }], fetchedAt: 1 };
  cache.set(first);
  const second = { snapshots: [{ deviceUid: 'b', deviceName: 'b' }], fetchedAt: 2 };
  cache.set(second);
  assert.equal(cache.get(), second);
  assert.deepEqual(
    first.snapshots,
    [{ deviceUid: 'a', deviceName: 'a' }],
    'previous entry must be untouched',
  );
});

// --- Testing step 11: cache_age_seconds is computed at scrape time ---

test('cacheAgeSecondsCollector: reports 0 before the cache has ever been populated', () => {
  const cache = createMetricsCache();
  const clock = createFakeClock();
  const collect = cacheAgeSecondsCollector(cache, clock);
  clock.advance(60_000);
  assert.equal(collect(), 0);
});

test('cacheAgeSecondsCollector: grows between two scrapes with no poll in between', () => {
  const cache = createMetricsCache();
  const clock = createFakeClock();
  cache.set({ snapshots: [], fetchedAt: clock.now() });
  const collect = cacheAgeSecondsCollector(cache, clock);

  const first = collect();
  clock.advance(30_000);
  const second = collect();
  assert.equal(first, 0);
  assert.equal(second, 30);
  assert.ok(second > first, 'cache age must grow with elapsed time, not just at poll time');
});

test('cacheAgeSecondsCollector: resets to (near) 0 immediately after a fresh poll updates the cache', () => {
  const cache = createMetricsCache();
  const clock = createFakeClock();
  cache.set({ snapshots: [], fetchedAt: clock.now() });
  const collect = cacheAgeSecondsCollector(cache, clock);

  clock.advance(90_000);
  assert.equal(collect(), 90);

  cache.set({ snapshots: [], fetchedAt: clock.now() });
  assert.equal(collect(), 0);
});

test('cacheAgeSecondsCollector: clamps at 0 rather than reporting a negative age (Opus review F7)', () => {
  const cache = createMetricsCache();
  const clock = createFakeClock();
  // fetchedAt ahead of clock.now() is possible in production once the
  // collector and the poller are wired from independently-obtained Clock
  // instances (Stage 10/11) — a negative "age" would be a nonsensical value
  // for an operator to alert on.
  cache.set({ snapshots: [], fetchedAt: clock.now() + 9_000 });
  const collect = cacheAgeSecondsCollector(cache, clock);
  assert.equal(collect(), 0);
});
