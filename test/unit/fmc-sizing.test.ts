import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectFmcRequestVolume } from '../../src/backends/fmc/sizing.ts';

test('projectFmcRequestVolume: the DESIGN.md worked example (50 devices x 5 families at 60s) warns with the projected 250/min figure', () => {
  const projection = projectFmcRequestVolume(50, 5, 60);
  assert.equal(projection.requestsPerMinute, 250);
  assert.ok(projection.warning !== undefined);
  assert.ok(projection.warning?.includes('250.0'));
});

test('projectFmcRequestVolume: 10 devices x 5 families at 60s does not warn', () => {
  const projection = projectFmcRequestVolume(10, 5, 60);
  assert.equal(projection.requestsPerMinute, 50);
  assert.equal(projection.warning, undefined);
});

test('projectFmcRequestVolume: exactly at the 70% threshold (210/min) does not warn; just above does', () => {
  const atThreshold = projectFmcRequestVolume(210, 1, 60);
  assert.equal(atThreshold.requestsPerMinute, 210);
  assert.equal(atThreshold.warning, undefined);

  const justAbove = projectFmcRequestVolume(211, 1, 60);
  assert.ok(justAbove.warning !== undefined);
});

test('projectFmcRequestVolume: raising the poll interval reduces the projection below the threshold', () => {
  const fast = projectFmcRequestVolume(50, 5, 60);
  const slow = projectFmcRequestVolume(50, 5, 120);
  assert.ok(fast.warning !== undefined);
  assert.equal(slow.requestsPerMinute, 125);
  assert.equal(slow.warning, undefined);
});
