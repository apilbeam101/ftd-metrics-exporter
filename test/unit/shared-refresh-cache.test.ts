import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRefreshCache } from '../../src/backends/shared/refresh-cache.ts';
import { createFakeClock } from './support/fake-clock.ts';

test('createRefreshCache: refreshIfDue() fetches on the first call regardless of interval', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const cache = createRefreshCache<number>({
    clock,
    intervalMs: 300_000,
    initialValue: -1,
    fetch: async () => {
      calls++;
      return 42;
    },
  });
  assert.equal(cache.getCached(), -1);
  await cache.refreshIfDue();
  assert.equal(calls, 1);
  assert.equal(cache.getCached(), 42);
});

test('createRefreshCache: a second refreshIfDue() before intervalMs has elapsed does not re-fetch', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const cache = createRefreshCache<number>({
    clock,
    intervalMs: 300_000,
    initialValue: 0,
    fetch: async () => {
      calls++;
      return 1;
    },
  });
  await cache.refreshIfDue();
  clock.advance(1_000);
  await cache.refreshIfDue();
  assert.equal(calls, 1);
});

test('createRefreshCache: refetches once intervalMs has elapsed since the last successful refresh', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const cache = createRefreshCache<number>({
    clock,
    intervalMs: 300_000,
    initialValue: 0,
    fetch: async () => {
      calls++;
      return calls;
    },
  });
  await cache.refreshIfDue();
  clock.advance(300_000);
  await cache.refreshIfDue();
  assert.equal(calls, 2);
  assert.equal(cache.getCached(), 2);
});

test('createRefreshCache: a failed refresh keeps the previous value, does not throw, and calls onFailure', async () => {
  const clock = createFakeClock();
  let onFailureCalls = 0;
  let shouldFail = false;
  const cache = createRefreshCache<number>({
    clock,
    intervalMs: 1_000,
    initialValue: 0,
    fetch: async () => {
      if (shouldFail) throw new Error('network error');
      return 7;
    },
    onFailure: () => {
      onFailureCalls++;
    },
  });
  await cache.refreshIfDue();
  assert.equal(cache.getCached(), 7);

  shouldFail = true;
  clock.advance(1_000);
  await assert.doesNotReject(() => cache.refreshIfDue());
  assert.equal(onFailureCalls, 1);
  assert.equal(cache.getCached(), 7, 'the previous good value must survive a failed refresh');
});

test('createRefreshCache: a failed refresh does NOT count as due-satisfying — the next call retries, not waits a full interval', async () => {
  const clock = createFakeClock();
  let calls = 0;
  let shouldFail = true;
  const cache = createRefreshCache<number>({
    clock,
    intervalMs: 300_000,
    initialValue: 0,
    fetch: async () => {
      calls++;
      if (shouldFail) throw new Error('network error');
      return 9;
    },
    onFailure: () => {},
  });
  await cache.refreshIfDue();
  assert.equal(calls, 1);
  shouldFail = false;
  clock.advance(1_000); // far short of the 300s interval
  await cache.refreshIfDue();
  assert.equal(calls, 2, 'a prior failure must not be treated as a fresh success for due-checking');
});

test('createRefreshCache: concurrent refreshIfDue() calls single-flight to one fetch() call', async () => {
  const clock = createFakeClock();
  let calls = 0;
  let resolveFetch: (() => void) | undefined;
  const cache = createRefreshCache<number>({
    clock,
    intervalMs: 300_000,
    initialValue: 0,
    fetch: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
      return 5;
    },
  });
  const first = cache.refreshIfDue();
  const second = cache.refreshIfDue();
  resolveFetch?.();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
