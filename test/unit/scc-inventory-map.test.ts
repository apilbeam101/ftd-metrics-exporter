import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapSccInventoryResponse } from '../../src/backends/scc/inventory-map.ts';

test('mapSccInventoryResponse: filters out non-FTD deviceType entries, keeps CDFMC_MANAGED_FTD', () => {
  const result = mapSccInventoryResponse({
    items: [
      { name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' },
      { name: 'meraki-01', uid: 'u2', deviceType: 'MERAKI_MX' },
    ],
  });
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0]?.deviceName, 'ftd-01');
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: an entry with no deviceType at all is silently excluded, not a parse error', () => {
  // Fail-closed: never render a device we cannot confirm is an FTD (Finding
  // 3's Meraki-phantom-device hazard) — absence is treated the same as a
  // confirmed non-FTD type, not as a malformed entry worth flagging.
  const result = mapSccInventoryResponse({
    items: [{ name: 'unknown-device', uid: 'u1' }],
  });
  assert.equal(result.snapshots.length, 0);
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: captures connectivityState and redundancyMode when present', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-01',
        uid: 'u1',
        deviceType: 'CDFMC_MANAGED_FTD',
        connectivityState: 'ONLINE',
        redundancyMode: 'HA',
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.equal(entry.connectivityState, 'ONLINE');
  assert.equal(entry.redundancyMode, 'HA');
});

test('mapSccInventoryResponse: absent connectivityState/redundancyMode leave the fields undefined, not defaulted', () => {
  const result = mapSccInventoryResponse({
    items: [{ name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' }],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.equal(entry.connectivityState, undefined);
  assert.equal(entry.redundancyMode, undefined);
});

test('mapSccInventoryResponse: an FTD entry missing deviceUid/name is skipped with a parse error, siblings survive', () => {
  const result = mapSccInventoryResponse({
    items: [
      { name: 'ftd-broken', deviceType: 'CDFMC_MANAGED_FTD' }, // no uid
      { name: 'ftd-ok', uid: 'u2', deviceType: 'CDFMC_MANAGED_FTD' },
    ],
  });
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0]?.deviceName, 'ftd-ok');
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0]?.group, 'inventory');
});

test('mapSccInventoryResponse: two array entries sharing a deviceUid (an SCC HA pair) both map — no dedup by deviceUid', () => {
  const result = mapSccInventoryResponse({
    items: [
      { name: 'ftd-ha-primary', uid: 'shared', deviceType: 'CDFMC_MANAGED_FTD' },
      { name: 'ftd-ha-secondary', uid: 'shared', deviceType: 'CDFMC_MANAGED_FTD' },
    ],
  });
  assert.equal(result.snapshots.length, 2);
  assert.deepEqual(result.snapshots.map((s) => s.deviceName).sort(), [
    'ftd-ha-primary',
    'ftd-ha-secondary',
  ]);
});

test('mapSccInventoryResponse: a response with no "items" array is a root-level parse error, not a crash', () => {
  const result = mapSccInventoryResponse({ count: 0 });
  assert.deepEqual(result.snapshots, []);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0]?.group, 'inventory');
});

test('mapSccInventoryResponse: a non-object payload is a parse error, not a crash', () => {
  const result = mapSccInventoryResponse([1, 2, 3]);
  assert.deepEqual(result.snapshots, []);
  assert.equal(result.parseErrors.length, 1);
});

test('mapSccInventoryResponse: a non-object item in the items array is skipped with a parse error', () => {
  const result = mapSccInventoryResponse({
    items: ['not an object', { name: 'ftd-ok', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' }],
  });
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.parseErrors.length, 1);
});

test('mapSccInventoryResponse: captures uidOnFmc — the certificate-endpoint join key (DESIGN.md §4.6.2), distinct from uid/deviceUid', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-01',
        uid: 'u1',
        deviceType: 'CDFMC_MANAGED_FTD',
        uidOnFmc: 'fmc-record-uuid-1',
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.equal(entry.deviceUid, 'u1');
  assert.equal(entry.uidOnFmc, 'fmc-record-uuid-1');
});

test('mapSccInventoryResponse: absent uidOnFmc leaves the field undefined, not a parse error', () => {
  const result = mapSccInventoryResponse({
    items: [{ name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' }],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.equal(entry.uidOnFmc, undefined);
  assert.deepEqual(result.parseErrors, []);
});
