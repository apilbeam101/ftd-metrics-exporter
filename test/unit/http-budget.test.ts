import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBudgetGuard } from '../../src/http/budget.ts';
import { createFakeClock } from './support/fake-clock.ts';

test('createBudgetGuard: requests under the limit are never delayed', async () => {
  const clock = createFakeClock();
  const guard = createBudgetGuard({ clock, maxRequests: 300, windowMs: 60_000 });
  for (let i = 0; i < 300; i++) {
    const before = clock.now();
    await guard.acquire();
    assert.equal(clock.now(), before);
  }
});

test('createBudgetGuard: drive 400 requests in a fake minute -> throttled below 300, none dropped', async () => {
  const clock = createFakeClock();
  const guard = createBudgetGuard({ clock, maxRequests: 300, windowMs: 60_000 });

  const timestamps: number[] = [];
  for (let i = 0; i < 400; i++) {
    await guard.acquire();
    timestamps.push(clock.now());
  }

  assert.equal(timestamps.length, 400, 'no request is ever dropped, only delayed');

  for (let i = 0; i + 300 < timestamps.length; i++) {
    const windowStart = timestamps[i] as number;
    const requestsInWindow = timestamps.filter((t) => t >= windowStart && t < windowStart + 60_000);
    assert.ok(
      requestsInWindow.length <= 300,
      `found ${requestsInWindow.length} requests within a 60s window starting at ${windowStart}`,
    );
  }
});

test('createBudgetGuard: increments the deferral counter once budget is exhausted', async () => {
  const clock = createFakeClock();
  let deferrals = 0;
  const guard = createBudgetGuard({
    clock,
    maxRequests: 2,
    windowMs: 60_000,
    onDefer: () => {
      deferrals++;
    },
  });

  await guard.acquire();
  await guard.acquire();
  await guard.acquire();
  assert.equal(deferrals, 1);
});

test('createBudgetGuard: counts failed attempts too — acquire() has no notion of success/failure, only of being called', async () => {
  const clock = createFakeClock();
  const guard = createBudgetGuard({ clock, maxRequests: 300, windowMs: 60_000 });

  for (let i = 0; i < 100; i++) {
    await guard.acquire();
  }

  let deferrals = 0;
  const smallGuard = createBudgetGuard({
    clock,
    maxRequests: 100,
    windowMs: 60_000,
    onDefer: () => {
      deferrals++;
    },
  });
  for (let i = 0; i < 100; i++) {
    await smallGuard.acquire();
  }
  await smallGuard.acquire();
  assert.equal(
    deferrals,
    1,
    'the 101st call (whether it represents a retry of a failed attempt or a fresh request) is deferred identically',
  );
});

test('createBudgetGuard: an expired timestamp frees a budget slot for the next caller', async () => {
  const clock = createFakeClock();
  const guard = createBudgetGuard({ clock, maxRequests: 1, windowMs: 60_000 });

  await guard.acquire();
  clock.advance(60_000);
  const before = clock.now();
  await guard.acquire();
  assert.equal(
    clock.now(),
    before,
    'no wait once the earlier timestamp has aged out of the window',
  );
});

test('createBudgetGuard: rejects a non-positive maxRequests rather than hot-spinning forever (Opus review F9)', () => {
  const clock = createFakeClock();
  assert.throws(() => createBudgetGuard({ clock, maxRequests: 0, windowMs: 60_000 }), RangeError);
});

test('createBudgetGuard: rejects a NaN maxRequests', () => {
  const clock = createFakeClock();
  assert.throws(
    () => createBudgetGuard({ clock, maxRequests: Number.NaN, windowMs: 60_000 }),
    RangeError,
  );
});

test('createBudgetGuard: rejects a non-positive windowMs', () => {
  const clock = createFakeClock();
  assert.throws(() => createBudgetGuard({ clock, maxRequests: 300, windowMs: 0 }), RangeError);
});
