import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRealClock } from '../../src/http/clock.ts';

test('createRealClock: now() is monotonic and non-decreasing across calls', () => {
  const clock = createRealClock();
  const a = clock.now();
  const b = clock.now();
  assert.ok(b >= a);
});

test('createRealClock: sleep() resolves after roughly the requested delay', async () => {
  const clock = createRealClock();
  const start = Date.now();
  await clock.sleep(20);
  assert.ok(Date.now() - start >= 15);
});

test('createRealClock: wallNow() tracks Date.now(), not a monotonic offset', () => {
  const clock = createRealClock();
  const before = Date.now();
  const wall = clock.wallNow();
  const after = Date.now();
  assert.ok(wall >= before && wall <= after);
});
