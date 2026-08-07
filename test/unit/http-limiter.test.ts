import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConcurrencyLimiter } from '../../src/http/limiter.ts';

test('createConcurrencyLimiter: observed in-flight count never exceeds the cap, all complete', async () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 5 });
  let maxObserved = 0;
  let completed = 0;

  const tasks = Array.from({ length: 50 }, () =>
    limiter.run(async () => {
      maxObserved = Math.max(maxObserved, limiter.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed++;
    }),
  );

  await Promise.all(tasks);
  assert.ok(maxObserved <= 5, `observed ${maxObserved} in-flight, cap was 5`);
  assert.equal(completed, 50);
});

test('createConcurrencyLimiter: increments the deferral counter for queued (non-immediate) calls', async () => {
  let deferrals = 0;
  const limiter = createConcurrencyLimiter({
    maxConcurrent: 1,
    onDefer: () => {
      deferrals++;
    },
  });

  let releaseFirst: (() => void) | undefined;
  const first = limiter.run(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  const second = limiter.run(async () => {});

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(deferrals, 1);

  releaseFirst?.();
  await Promise.all([first, second]);
});

test('createConcurrencyLimiter: rejects a non-positive maxConcurrent', () => {
  assert.throws(() => createConcurrencyLimiter({ maxConcurrent: 0 }), RangeError);
});

test('createConcurrencyLimiter: rejects a NaN maxConcurrent rather than silently deadlocking every task (Opus review F9)', () => {
  assert.throws(() => createConcurrencyLimiter({ maxConcurrent: Number.NaN }), RangeError);
});

test('createConcurrencyLimiter: rejects a non-integer maxConcurrent', () => {
  assert.throws(() => createConcurrencyLimiter({ maxConcurrent: 2.5 }), RangeError);
});

test('createConcurrencyLimiter: a task that throws releases its slot for the next queued task', async () => {
  const limiter = createConcurrencyLimiter({ maxConcurrent: 1 });
  await assert.rejects(
    limiter.run(async () => {
      throw new Error('boom');
    }),
  );
  let ran = false;
  await limiter.run(async () => {
    ran = true;
  });
  assert.ok(ran, 'slot must be released even when the prior task threw');
});
