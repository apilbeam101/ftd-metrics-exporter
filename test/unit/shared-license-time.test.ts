import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLicenseTimestamp } from '../../src/backends/shared/license-time.ts';

test('parseLicenseTimestamp: accepts the confirmed-live "YYYY-MM-DDTHH:MM:SSUTC" shape', () => {
  const date = parseLicenseTimestamp('2026-08-14T09:10:21UTC');
  assert.ok(date instanceof Date);
  assert.equal(date?.toISOString(), '2026-08-14T09:10:21.000Z');
});

test('parseLicenseTimestamp: rejects a bare ISO 8601 "Z" suffix — this endpoint never uses it', () => {
  assert.equal(parseLicenseTimestamp('2026-08-14T09:10:21Z'), undefined);
});

test('parseLicenseTimestamp: rejects a value missing seconds', () => {
  assert.equal(parseLicenseTimestamp('2026-08-14T09:10UTC'), undefined);
});

test('parseLicenseTimestamp: rejects garbage', () => {
  assert.equal(parseLicenseTimestamp('not-a-timestamp'), undefined);
  assert.equal(parseLicenseTimestamp(''), undefined);
});

test('parseLicenseTimestamp: rejects a value that matches the shape but is not a real calendar date', () => {
  // Date.parse('2026-99-99T00:00:00Z') is NaN -- confirms the NaN guard, not just the regex.
  assert.equal(parseLicenseTimestamp('2026-99-99T00:00:00UTC'), undefined);
});

test('parseLicenseTimestamp: rejects a calendar-overflow day that `new Date()` would silently roll into the next month (Opus review finding, 2026-08-14)', () => {
  // 2026 is not a leap year, so February has 28 days -- `new Date('2026-02-30T00:00:00Z')`
  // does NOT throw or produce NaN; it silently resolves to March 2nd. The round-trip check
  // must catch this even though the regex shape and the NaN guard both pass.
  assert.equal(parseLicenseTimestamp('2026-02-30T00:00:00UTC'), undefined);
});
