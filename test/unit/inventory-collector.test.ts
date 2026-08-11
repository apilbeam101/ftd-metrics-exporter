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
