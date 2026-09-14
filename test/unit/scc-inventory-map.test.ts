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

test('mapSccInventoryResponse: captures the remaining device fields (DESIGN.md §4.6.3) confirmed live 2026-09-14', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-01',
        uid: 'u1',
        deviceType: 'CDFMC_MANAGED_FTD',
        softwareVersion: '10.0.0',
        serial: '9AC0LCBEDRM',
        ftdPerformanceTier: 'FTDv50',
        configState: 'SYNCED',
        conflictDetectionState: 'NO_CONFLICTS',
        licenseStatus: 'LICENSED',
        complianceStatus: 'IN_COMPLIANCE',
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.deepEqual(
    {
      softwareVersion: entry.softwareVersion,
      serial: entry.serial,
      ftdPerformanceTier: entry.ftdPerformanceTier,
      configState: entry.configState,
      conflictDetectionState: entry.conflictDetectionState,
      licenseStatus: entry.licenseStatus,
      complianceStatus: entry.complianceStatus,
    },
    {
      softwareVersion: '10.0.0',
      serial: '9AC0LCBEDRM',
      ftdPerformanceTier: 'FTDv50',
      configState: 'SYNCED',
      conflictDetectionState: 'NO_CONFLICTS',
      licenseStatus: 'LICENSED',
      complianceStatus: 'IN_COMPLIANCE',
    },
  );
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: absent remaining fields leave them undefined, not defaulted or a parse error', () => {
  const result = mapSccInventoryResponse({
    items: [{ name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' }],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.equal(entry.softwareVersion, undefined);
  assert.equal(entry.serial, undefined);
  assert.equal(entry.ftdPerformanceTier, undefined);
  assert.equal(entry.configState, undefined);
  assert.equal(entry.conflictDetectionState, undefined);
  assert.equal(entry.licenseStatus, undefined);
  assert.equal(entry.complianceStatus, undefined);
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: captures ftdHaInfo.{primaryNode,secondaryNode} as haNodes, keyed by node name with role', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-ha-pair',
        uid: 'shared',
        deviceType: 'CDFMC_MANAGED_FTD',
        redundancyMode: 'HA',
        ftdHaInfo: {
          primaryNode: { name: 'ftd-01', role: 'ACTIVE' },
          secondaryNode: { name: 'ftd-02', role: 'STANDBY' },
        },
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.deepEqual(entry.haNodes, [
    { nodeName: 'ftd-01', nodeType: 'PRIMARY', role: 'ACTIVE' },
    { nodeName: 'ftd-02', nodeType: 'SECONDARY', role: 'STANDBY' },
  ]);
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: absent ftdHaInfo (a standalone device) leaves haNodes undefined, not a parse error', () => {
  const result = mapSccInventoryResponse({
    items: [{ name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' }],
  });
  const entry = result.snapshots[0];
  assert.ok(entry);
  assert.equal(entry.haNodes, undefined);
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: a node missing "role" is still captured, without a role field, no parse error', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-ha-pair',
        uid: 'shared',
        deviceType: 'CDFMC_MANAGED_FTD',
        ftdHaInfo: { primaryNode: { name: 'ftd-01' } },
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.deepEqual(entry?.haNodes, [{ nodeName: 'ftd-01', nodeType: 'PRIMARY' }]);
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: a malformed single HA node is skipped with a parse error, its sibling node still captured', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-ha-pair',
        uid: 'shared',
        deviceType: 'CDFMC_MANAGED_FTD',
        ftdHaInfo: {
          primaryNode: 'not-an-object',
          secondaryNode: { name: 'ftd-02', role: 'STANDBY' },
        },
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.deepEqual(entry?.haNodes, [
    { nodeName: 'ftd-02', nodeType: 'SECONDARY', role: 'STANDBY' },
  ]);
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /primaryNode.*not an object/);
});

test('mapSccInventoryResponse: ftdHaInfo present but not an object is a parse error, device entry still produced', () => {
  const result = mapSccInventoryResponse({
    items: [
      { name: 'ftd-ha-pair', uid: 'shared', deviceType: 'CDFMC_MANAGED_FTD', ftdHaInfo: 'oops' },
    ],
  });
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0]?.haNodes, undefined);
  assert.equal(result.parseErrors.length, 1);
});

test('mapSccInventoryResponse: ftdHaInfo === null is a parse error (fails the isPlainObject check), not treated as absent', () => {
  const result = mapSccInventoryResponse({
    items: [
      { name: 'ftd-ha-pair', uid: 'shared', deviceType: 'CDFMC_MANAGED_FTD', ftdHaInfo: null },
    ],
  });
  assert.equal(result.snapshots[0]?.haNodes, undefined);
  assert.equal(result.parseErrors.length, 1);
});

test('mapSccInventoryResponse: ftdHaInfo === {} (both node keys absent) leaves haNodes undefined, not an empty array, and no parse error', () => {
  const result = mapSccInventoryResponse({
    items: [{ name: 'ftd-ha-pair', uid: 'shared', deviceType: 'CDFMC_MANAGED_FTD', ftdHaInfo: {} }],
  });
  assert.equal(result.snapshots[0]?.haNodes, undefined);
  assert.deepEqual(result.parseErrors, []);
});

test('mapSccInventoryResponse: a non-string role is a parse error but the node is still captured without a role, sibling node unaffected', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-ha-pair',
        uid: 'shared',
        deviceType: 'CDFMC_MANAGED_FTD',
        ftdHaInfo: {
          primaryNode: { name: 'ftd-01', role: 42 },
          secondaryNode: { name: 'ftd-02', role: 'STANDBY' },
        },
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.deepEqual(entry?.haNodes, [
    { nodeName: 'ftd-01', nodeType: 'PRIMARY' },
    { nodeName: 'ftd-02', nodeType: 'SECONDARY', role: 'STANDBY' },
  ]);
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /primaryNode\.role.*not a string/);
});

test('mapSccInventoryResponse: two HA nodes sharing the same "name" are deduped to the first, with a parse error, not two contradictory series', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-ha-pair',
        uid: 'shared',
        deviceType: 'CDFMC_MANAGED_FTD',
        ftdHaInfo: {
          primaryNode: { name: 'same-name', role: 'ACTIVE' },
          secondaryNode: { name: 'same-name', role: 'STANDBY' },
        },
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.deepEqual(entry?.haNodes, [
    { nodeName: 'same-name', nodeType: 'PRIMARY', role: 'ACTIVE' },
  ]);
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /same name as another node/);
});

test('mapSccInventoryResponse: a non-string remaining field is a parse error but a sibling field on the same device still maps correctly', () => {
  const result = mapSccInventoryResponse({
    items: [
      {
        name: 'ftd-01',
        uid: 'u1',
        deviceType: 'CDFMC_MANAGED_FTD',
        licenseStatus: 42,
        complianceStatus: 'IN_COMPLIANCE',
      },
    ],
  });
  const entry = result.snapshots[0];
  assert.equal(entry?.licenseStatus, undefined);
  assert.equal(entry?.complianceStatus, 'IN_COMPLIANCE');
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /licenseStatus.*is not a string/);
});
