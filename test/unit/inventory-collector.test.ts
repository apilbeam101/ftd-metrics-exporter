import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Counter, Registry } from 'prom-client';
import type { DeviceInventoryEntry } from '../../src/domain/device-inventory.ts';
import { renderDeviceInventoryMetrics } from '../../src/metrics/inventory-collector.ts';
import { createDeviceInventoryMetrics } from '../../src/metrics/inventory-metrics.ts';

function harness() {
  const registry = new Registry();
  const metrics = createDeviceInventoryMetrics(registry);
  const unknownEnumTotal = new Counter({
    name: 'test_unknown_enum_total',
    help: 'test-only',
    labelNames: ['metric', 'value'],
    registers: [],
  });
  return { registry, metrics, unknownEnumTotal };
}

test('renderDeviceInventoryMetrics: renders device_info=1 and connectivity_up for a normal ONLINE/HA device', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const entries: DeviceInventoryEntry[] = [
    { deviceUid: 'u1', deviceName: 'ftd-01', connectivityState: 'ONLINE', redundancyMode: 'HA' },
  ];
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, entries);

  const info = await metrics.deviceInfo.get();
  assert.equal(info.values.length, 1);
  assert.deepEqual(info.values[0]?.labels, {
    device_uid: 'u1',
    device_name: 'ftd-01',
    redundancy_mode: 'ha',
    software_version: '',
    serial: '',
    performance_tier: '',
  });
  assert.equal(info.values[0]?.value, 1);

  const up = await metrics.deviceConnectivityUp.get();
  assert.equal(up.values[0]?.value, 1);
});

test('renderDeviceInventoryMetrics: UNREACHABLE renders connectivity_up=0 — this is the fix for Finding 3', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const entries: DeviceInventoryEntry[] = [
    { deviceUid: 'u1', deviceName: 'ftd-offline', connectivityState: 'UNREACHABLE' },
  ];
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, entries);

  const up = await metrics.deviceConnectivityUp.get();
  assert.equal(up.values.length, 1);
  assert.equal(up.values[0]?.value, 0);
  // device_info still renders even for an offline device — it's the
  // identity/existence signal, independent of connectivity.
  const info = await metrics.deviceInfo.get();
  assert.equal(info.values.length, 1);
});

test('renderDeviceInventoryMetrics: absent connectivityState omits connectivity_up entirely, no diagnostic', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01' },
  ]);
  const up = await metrics.deviceConnectivityUp.get();
  assert.equal(up.values.length, 0);
  const counter = await unknownEnumTotal.get();
  assert.equal(counter.values.length, 0);
});

test('renderDeviceInventoryMetrics: an unrecognized connectivityState omits the gauge but increments the diagnostic counter', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01', connectivityState: 'DEGRADED' },
  ]);
  const up = await metrics.deviceConnectivityUp.get();
  assert.equal(up.values.length, 0);
  const counter = await unknownEnumTotal.get();
  assert.equal(
    counter.values.find((v) => v.labels.metric === 'ftd_device_connectivity_up')?.value,
    1,
  );
});

test('renderDeviceInventoryMetrics: absent redundancyMode renders "unknown" with NO diagnostic (missing field, not a new value)', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01' },
  ]);
  const info = await metrics.deviceInfo.get();
  assert.equal(info.values[0]?.labels.redundancy_mode, 'unknown');
  const counter = await unknownEnumTotal.get();
  assert.equal(counter.values.length, 0);
});

test('renderDeviceInventoryMetrics: an unrecognized redundancyMode renders "unknown" AND increments the diagnostic counter', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01', redundancyMode: 'CLUSTER' },
  ]);
  const info = await metrics.deviceInfo.get();
  assert.equal(info.values[0]?.labels.redundancy_mode, 'unknown');
  const counter = await unknownEnumTotal.get();
  assert.equal(
    counter.values.find(
      (v) => v.labels.metric === 'ftd_device_info' && v.labels.value === 'cluster',
    )?.value,
    1,
  );
});

test('renderDeviceInventoryMetrics: two entries sharing a deviceUid (an HA pair) both render independently', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'shared', deviceName: 'ftd-ha-primary', connectivityState: 'ONLINE' },
    { deviceUid: 'shared', deviceName: 'ftd-ha-secondary', connectivityState: 'ONLINE' },
  ]);
  const info = await metrics.deviceInfo.get();
  assert.equal(info.values.length, 2);
  const names = info.values.map((v) => v.labels.device_name).sort();
  assert.deepEqual(names, ['ftd-ha-primary', 'ftd-ha-secondary']);
});

test('renderDeviceInventoryMetrics: reset-then-repopulate — a device absent from a later render disappears, not stuck at its last value', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01', connectivityState: 'ONLINE' },
  ]);
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, []);
  const info = await metrics.deviceInfo.get();
  assert.equal(info.values.length, 0);
});

test('renderDeviceInventoryMetrics: softwareVersion/serial/ftdPerformanceTier pass through raw onto device_info, empty string when absent', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      softwareVersion: '10.0.0',
      serial: 'ABC123',
      ftdPerformanceTier: 'FTDv50',
    },
    { deviceUid: 'u2', deviceName: 'ftd-02' },
  ]);
  const info = await metrics.deviceInfo.get();
  const withValues = info.values.find((v) => v.labels.device_uid === 'u1');
  assert.deepEqual(
    { softwareVersion: withValues?.labels.software_version, serial: withValues?.labels.serial },
    { softwareVersion: '10.0.0', serial: 'ABC123' },
  );
  assert.equal(withValues?.labels.performance_tier, 'FTDv50');
  const withoutValues = info.values.find((v) => v.labels.device_uid === 'u2');
  assert.deepEqual(
    {
      software_version: withoutValues?.labels.software_version,
      serial: withoutValues?.labels.serial,
      performance_tier: withoutValues?.labels.performance_tier,
    },
    { software_version: '', serial: '', performance_tier: '' },
  );
});

test('renderDeviceInventoryMetrics: device_status_info renders all four recognized states', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      configState: 'SYNCED',
      conflictDetectionState: 'NO_CONFLICTS',
      licenseStatus: 'LICENSED',
      complianceStatus: 'IN_COMPLIANCE',
    },
  ]);
  const status = await metrics.deviceStatusInfo.get();
  assert.equal(status.values.length, 1);
  assert.deepEqual(status.values[0]?.labels, {
    device_uid: 'u1',
    device_name: 'ftd-01',
    config_state: 'synced',
    conflict_detection_state: 'no_conflicts',
    license_status: 'licensed',
    compliance_status: 'in_compliance',
  });
  const counter = await unknownEnumTotal.get();
  assert.equal(counter.values.length, 0);
});

test('renderDeviceInventoryMetrics: device_status_info falls back to "unknown" with no diagnostic when all four fields are absent', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01' },
  ]);
  const status = await metrics.deviceStatusInfo.get();
  assert.deepEqual(status.values[0]?.labels, {
    device_uid: 'u1',
    device_name: 'ftd-01',
    config_state: 'unknown',
    conflict_detection_state: 'unknown',
    license_status: 'unknown',
    compliance_status: 'unknown',
  });
  const counter = await unknownEnumTotal.get();
  assert.equal(counter.values.length, 0);
});

test('renderDeviceInventoryMetrics: an unrecognized value on each of the four device_status_info fields flags its own diagnostic', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      configState: 'SYNCING',
      conflictDetectionState: 'CONFLICTS_DETECTED',
      licenseStatus: 'UNLICENSED',
      complianceStatus: 'OUT_OF_COMPLIANCE',
    },
  ]);
  const status = await metrics.deviceStatusInfo.get();
  assert.deepEqual(status.values[0]?.labels, {
    device_uid: 'u1',
    device_name: 'ftd-01',
    config_state: 'unknown',
    conflict_detection_state: 'unknown',
    license_status: 'unknown',
    compliance_status: 'unknown',
  });
  const counter = await unknownEnumTotal.get();
  const flagged = counter.values
    .filter((v) => v.labels.metric === 'ftd_device_status_info')
    .map((v) => v.labels.value)
    .sort();
  assert.deepEqual(flagged, ['conflicts_detected', 'out_of_compliance', 'syncing', 'unlicensed']);
});

test('renderDeviceInventoryMetrics: ha_role_info renders one series per HA node with active/standby roles and primary/secondary node_type', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'shared',
      deviceName: 'ftd-ha-pair',
      redundancyMode: 'HA',
      haNodes: [
        { nodeName: 'ftd-01', nodeType: 'PRIMARY', role: 'ACTIVE' },
        { nodeName: 'ftd-02', nodeType: 'SECONDARY', role: 'STANDBY' },
      ],
    },
  ]);
  const role = await metrics.deviceHaRoleInfo.get();
  assert.equal(role.values.length, 2);
  const byNode = new Map(
    role.values.map((v) => [
      v.labels.node_name,
      { role: v.labels.role, node_type: v.labels.node_type },
    ]),
  );
  assert.deepEqual(byNode.get('ftd-01'), { role: 'active', node_type: 'primary' });
  assert.deepEqual(byNode.get('ftd-02'), { role: 'standby', node_type: 'secondary' });
  const counter = await unknownEnumTotal.get();
  assert.equal(counter.values.length, 0);
});

test('renderDeviceInventoryMetrics: a standalone device (no haNodes) renders zero ha_role_info series', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01', redundancyMode: 'STANDALONE' },
  ]);
  const role = await metrics.deviceHaRoleInfo.get();
  assert.equal(role.values.length, 0);
});

test('renderDeviceInventoryMetrics: an absent node role renders "unknown" with no diagnostic; an unrecognized one renders "unknown" and flags the diagnostic', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'shared',
      deviceName: 'ftd-ha-pair',
      redundancyMode: 'HA',
      haNodes: [
        { nodeName: 'ftd-01', nodeType: 'PRIMARY' },
        { nodeName: 'ftd-02', nodeType: 'SECONDARY', role: 'FAILED' },
      ],
    },
  ]);
  const role = await metrics.deviceHaRoleInfo.get();
  const byNode = new Map(role.values.map((v) => [v.labels.node_name, v.labels.role]));
  assert.equal(byNode.get('ftd-01'), 'unknown');
  assert.equal(byNode.get('ftd-02'), 'unknown');
  const counter = await unknownEnumTotal.get();
  assert.equal(
    counter.values.find(
      (v) => v.labels.metric === 'ftd_device_ha_role_info' && v.labels.value === 'failed',
    )?.value,
    1,
  );
});

test('renderDeviceInventoryMetrics: an unrecognized node_type renders "unknown" and flags its own diagnostic', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'shared',
      deviceName: 'ftd-ha-pair',
      redundancyMode: 'HA',
      haNodes: [{ nodeName: 'ftd-01', nodeType: 'TERTIARY', role: 'ACTIVE' }],
    },
  ]);
  const role = await metrics.deviceHaRoleInfo.get();
  assert.equal(role.values[0]?.labels.node_type, 'unknown');
  const counter = await unknownEnumTotal.get();
  assert.equal(
    counter.values.find(
      (v) => v.labels.metric === 'ftd_device_ha_role_info' && v.labels.value === 'tertiary',
    )?.value,
    1,
  );
});

test('renderDeviceInventoryMetrics: ftd_exporter_series counts ha_role_info series correctly, including the variable per-device count', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const result = renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-standalone', connectivityState: 'ONLINE' },
    {
      deviceUid: 'shared',
      deviceName: 'ftd-ha-pair',
      connectivityState: 'ONLINE',
      haNodes: [
        { nodeName: 'ftd-01', nodeType: 'PRIMARY', role: 'ACTIVE' },
        { nodeName: 'ftd-02', nodeType: 'SECONDARY', role: 'STANDBY' },
      ],
    },
  ]);
  // Per device: device_info(1) + connectivity_up(1) + status_info(1) = 3, x2 devices = 6,
  // plus 2 ha_role_info series for the HA pair only = 8.
  assert.equal(result.seriesCount, 8);
});

test('renderDeviceInventoryMetrics: the cardinality tripwire does not collide two distinct devices whose passthrough label values contain "," or "="', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const result = renderDeviceInventoryMetrics({ metrics, unknownEnumTotal }, [
    { deviceUid: 'u1', deviceName: 'ftd-01', serial: 'S,software_version=V' },
    { deviceUid: 'u2', deviceName: 'ftd-02', serial: 'S', softwareVersion: 'V,software_version=' },
  ]);
  const info = await metrics.deviceInfo.get();
  assert.equal(info.values.length, 2);
  // 2 devices x (device_info + status_info) = 4; connectivity_up omitted (absent state).
  assert.equal(result.seriesCount, 4);
});
