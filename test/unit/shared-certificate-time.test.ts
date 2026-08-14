import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCertificateExpiry } from '../../src/backends/shared/certificate-time.ts';

test('parseCertificateExpiry: accepts the confirmed-live minute-precision shape (no seconds)', () => {
  const date = parseCertificateExpiry('2034-07-16T14:23Z');
  assert.ok(date instanceof Date);
  assert.equal(date?.toISOString(), '2034-07-16T14:23:00.000Z');
});

test('parseCertificateExpiry: also accepts a seconds-bearing value', () => {
  const date = parseCertificateExpiry('2028-01-13T14:15:00Z');
  assert.equal(date?.toISOString(), '2028-01-13T14:15:00.000Z');
});

test('parseCertificateExpiry: does NOT special-case the "-" sentinel — that is the mapper\'s job, not this parser\'s', () => {
  assert.equal(parseCertificateExpiry('-'), undefined);
});

test('parseCertificateExpiry: rejects the license endpoint\'s "UTC"-suffixed shape — different endpoint, different format', () => {
  assert.equal(parseCertificateExpiry('2026-08-14T09:10:21UTC'), undefined);
});

test('parseCertificateExpiry: rejects garbage and empty string', () => {
  assert.equal(parseCertificateExpiry('not-a-timestamp'), undefined);
  assert.equal(parseCertificateExpiry(''), undefined);
});

test('parseCertificateExpiry: rejects a value that matches the shape but is not a real calendar date', () => {
  assert.equal(parseCertificateExpiry('2034-99-99T14:23Z'), undefined);
});

test('parseCertificateExpiry: rejects a calendar-overflow day that `new Date()` would silently roll into the next month (Opus review finding, 2026-08-14)', () => {
  // 2034 is not a leap year -- `new Date('2034-02-30T14:23Z')` silently
  // resolves to March 2nd rather than throwing or producing NaN.
  assert.equal(parseCertificateExpiry('2034-02-30T14:23Z'), undefined);
});
