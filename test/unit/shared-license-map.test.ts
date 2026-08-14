import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapLicenseResponse } from '../../src/backends/shared/license-map.ts';

test('mapLicenseResponse: the live SCC shape (2026-08-14) maps every field', () => {
  const result = mapLicenseResponse({
    links: { self: 'https://api.eu.security.cisco.com/firewall/...' },
    items: [
      {
        regStatus: 'REGISTERED',
        metadata: {
          authStatus: 'AUTHORIZED',
          virtualAccount: 'aspilbea',
          exportControl: true,
          evalUsed: true,
          evalExpiresInDays: 0,
          lastSynchronizedTime: '2026-08-11T13:02:22UTC',
          lastRenewedTime: '2026-02-27T10:14:37UTC',
        },
        type: 'SmartLicense',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  });
  assert.deepEqual(result.parseErrors, []);
  assert.ok(result.status);
  assert.equal(result.status.regStatus, 'REGISTERED');
  assert.equal(result.status.authStatus, 'AUTHORIZED');
  assert.equal(result.status.evalUsed, true);
  assert.equal(result.status.evalExpiresInDays, 0);
  assert.equal(result.status.lastSynchronizedTime?.toISOString(), '2026-08-11T13:02:22.000Z');
  assert.equal(result.status.lastRenewedTime?.toISOString(), '2026-02-27T10:14:37.000Z');
});

test('mapLicenseResponse: the live FMC shape (2026-08-14) maps every field, including a duplicate "metadata" key', () => {
  // FMC's real response had `metadata` appear twice in the same JSON object
  // (both occurrences identical) -- JSON.parse resolves that to the last
  // occurrence before this mapper ever sees the object, so there is nothing
  // special to assert beyond "the fields still come through correctly."
  const result = mapLicenseResponse(
    JSON.parse(
      '{"items":[{"regStatus":"REGISTERED","metadata":{"authStatus":"OUT_OF_COMPLIANCE","evalUsed":false,"evalExpiresInDays":0},"type":"SmartLicense","metadata":{"authStatus":"OUT_OF_COMPLIANCE","evalUsed":false,"evalExpiresInDays":0}}]}',
    ),
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.status?.regStatus, 'REGISTERED');
  assert.equal(result.status?.authStatus, 'OUT_OF_COMPLIANCE');
  assert.equal(result.status?.evalUsed, false);
});

test('mapLicenseResponse: an empty items array is "no license record" -- undefined status, no parse error', () => {
  const result = mapLicenseResponse({ items: [] });
  assert.equal(result.status, undefined);
  assert.deepEqual(result.parseErrors, []);
});

test('mapLicenseResponse: a non-object payload is a parse error, not a crash', () => {
  const result = mapLicenseResponse([1, 2, 3]);
  assert.equal(result.status, undefined);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0]?.group, 'license');
});

test('mapLicenseResponse: a response with no "items" array is a parse error', () => {
  const result = mapLicenseResponse({ count: 0 });
  assert.equal(result.status, undefined);
  assert.equal(result.parseErrors.length, 1);
});

test('mapLicenseResponse: an item missing regStatus is a parse error, status undefined', () => {
  const result = mapLicenseResponse({ items: [{ metadata: {} }] });
  assert.equal(result.status, undefined);
  assert.equal(result.parseErrors.length, 1);
});

test('mapLicenseResponse: only the first item is rendered when more than one is present, and it is flagged with a diagnostic (Opus review finding, 2026-08-14)', () => {
  const result = mapLicenseResponse({
    items: [{ regStatus: 'REGISTERED' }, { regStatus: 'UNREGISTERED' }],
  });
  assert.equal(result.status?.regStatus, 'REGISTERED');
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0]?.group, 'license');
  assert.match(result.parseErrors[0]?.message ?? '', /2 items, expected exactly 1/);
});

test('mapLicenseResponse: an empty-string regStatus is treated the same as missing, not rendered as "" (Opus review finding, 2026-08-14)', () => {
  const result = mapLicenseResponse({ items: [{ regStatus: '' }] });
  assert.equal(result.status, undefined);
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /missing regStatus/);
});

test('mapLicenseResponse: an absent metadata object leaves every metadata-derived field undefined, not an error', () => {
  const result = mapLicenseResponse({ items: [{ regStatus: 'REGISTERED' }] });
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.status?.authStatus, undefined);
  assert.equal(result.status?.evalUsed, undefined);
  assert.equal(result.status?.evalExpiresInDays, undefined);
});

test('mapLicenseResponse: a wrong-typed evalUsed is a parse error, the rest of the record still maps', () => {
  const result = mapLicenseResponse({
    items: [{ regStatus: 'REGISTERED', metadata: { evalUsed: 'yes', authStatus: 'AUTHORIZED' } }],
  });
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.status?.evalUsed, undefined);
  assert.equal(result.status?.authStatus, 'AUTHORIZED');
});

test('mapLicenseResponse: an unparseable lastSynchronizedTime is a parse error, does not drop the rest of the record', () => {
  const result = mapLicenseResponse({
    items: [{ regStatus: 'REGISTERED', metadata: { lastSynchronizedTime: 'not-a-timestamp' } }],
  });
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.status?.regStatus, 'REGISTERED');
  assert.equal(result.status?.lastSynchronizedTime, undefined);
});
