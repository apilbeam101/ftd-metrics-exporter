import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRealClock } from '../../src/http/clock.ts';
import { createSpacingGuard } from '../../src/http/spacing.ts';
import { createFakeClock } from './support/fake-clock.ts';

test('createSpacingGuard: the first wait() resolves immediately with no prior call', async () => {
  const clock = createFakeClock();
  const guard = createSpacingGuard({ clock, minSpacingMs: 30_000 });
  const start = clock.now();
  await guard.wait();
  assert.equal(clock.now(), start, 'no delay should be introduced before any prior request');
});

test('createSpacingGuard: two calls back-to-back delay the second by >= minSpacingMs', async () => {
  const clock = createFakeClock();
  const guard = createSpacingGuard({ clock, minSpacingMs: 30_000 });

  await guard.wait();
  const beforeSecond = clock.now();
  await guard.wait();
  const elapsed = clock.now() - beforeSecond;
  assert.ok(elapsed >= 30_000, `expected >= 30000ms elapsed, got ${elapsed}`);
});

test('createSpacingGuard: a call that arrives after minSpacingMs has already elapsed is not delayed further', async () => {
  const clock = createFakeClock();
  const guard = createSpacingGuard({ clock, minSpacingMs: 30_000 });

  await guard.wait();
  clock.advance(31_000);
  const before = clock.now();
  await guard.wait();
  assert.equal(
    clock.now(),
    before,
    'no additional delay once the spacing window has already elapsed',
  );
});

test('createSpacingGuard: retries under the guard cannot exceed 2 requests in any rolling 60s window', async () => {
  const clock = createFakeClock();
  const guard = createSpacingGuard({ clock, minSpacingMs: 30_000 });

  const requestTimestamps: number[] = [];
  for (let i = 0; i < 5; i++) {
    await guard.wait();
    requestTimestamps.push(clock.now());
  }

  for (let i = 0; i + 1 < requestTimestamps.length; i++) {
    const windowStart = requestTimestamps[i] as number;
    const requestsInWindow = requestTimestamps.filter(
      (t) => t >= windowStart && t < windowStart + 60_000,
    );
    assert.ok(
      requestsInWindow.length <= 2,
      `found ${requestsInWindow.length} requests within a 60s window starting at ${windowStart}`,
    );
  }
});

test('createSpacingGuard: concurrent wait() calls serialize by minSpacingMs each, not by when the first sleep happens to resolve (Opus review F4)', async () => {
  // Uses createRealClock(), not the fake clock: the fake clock's sleep()
  // advances time synchronously at the call site, which collapses
  // concurrent timers onto the same instant and cannot reproduce the race
  // this test guards against (verified: the fake-clock version of this
  // test reports all four callers releasing at the same tick regardless of
  // whether the F4 fix is present or reverted, so it would silently pass
  // either way — a real clock is required to observe genuine interleaving).
  const clock = createRealClock();
  const guard = createSpacingGuard({ clock, minSpacingMs: 100 });
  const start = clock.now();

  const releaseTimes = await Promise.all(
    [guard.wait(), guard.wait(), guard.wait(), guard.wait()].map(async (p) => {
      await p;
      return clock.now() - start;
    }),
  );

  const sorted = [...releaseTimes].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] as number) - (sorted[i - 1] as number);
    assert.ok(
      gap >= 90,
      `expected each release to be spaced by ~100ms from the previous one, got a gap of ${gap}ms (releases: ${sorted.join(', ')})`,
    );
  }
});

test('createSpacingGuard: onDefer fires once per wait() call that had to wait (Opus review F7)', async () => {
  const clock = createFakeClock();
  let deferrals = 0;
  const guard = createSpacingGuard({
    clock,
    minSpacingMs: 30_000,
    onDefer: () => {
      deferrals++;
    },
  });

  await guard.wait();
  assert.equal(deferrals, 0, 'the first call, with no prior request, must not count as deferred');
  await guard.wait();
  assert.equal(deferrals, 1);
  clock.advance(30_000);
  await guard.wait();
  assert.equal(deferrals, 1, 'a call that did not need to wait must not increment the counter');
});

test('createSpacingGuard: rejects a negative minSpacingMs (Opus review F9)', () => {
  const clock = createFakeClock();
  assert.throws(() => createSpacingGuard({ clock, minSpacingMs: -1 }), RangeError);
});

test('createSpacingGuard: rejects a NaN minSpacingMs rather than silently disabling the floor (Opus review F9)', () => {
  const clock = createFakeClock();
  assert.throws(() => createSpacingGuard({ clock, minSpacingMs: Number.NaN }), RangeError);
});
