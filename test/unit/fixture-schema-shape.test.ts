import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  FmcAggregateMetricsResponse,
  FmcDeviceRecordsResponse,
} from '../../src/backends/fmc/schema.ts';
import type {
  SccInventoryDeviceEntry,
  SccInventoryResponse,
} from '../../src/backends/scc/inventory-schema.ts';
import type { SccHealthMetricsResponse } from '../../src/backends/scc/schema.ts';

/**
 * A narrow structural check per fixture — not full runtime validation, just
 * enough to catch a mangled sanitization pass (e.g. a version string like
 * "3.9.3.1-61" corrupted into "203.0.113.1-61" by an overzealous IPv4
 * sweep, which is exactly what happened here before the sanitizer regex
 * was tightened — see src/util/sanitize.ts). If a sanitizer bug reshapes
 * or corrupts a value these assertions look at, this test is the guard.
 */

const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

function readFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(`${fixturesDir}/${relativePath}`, 'utf8')) as T;
}

test('scc/full-live.json matches the expected SccHealthMetricsResponse shape', () => {
  const response = readFixture<SccHealthMetricsResponse>('scc/full-live.json');
  assert.equal(response.length, 1);
  const device = response[0];
  assert.ok(device);
  assert.match(device.deviceUid, /^[0-9a-f-]{36}$/i);
  assert.equal(typeof device.deviceName, 'string');
  assert.ok(device.cpuHealthMetrics);
  assert.equal(typeof device.cpuHealthMetrics.linaUsageAvg, 'number');
  assert.equal(device.interfaceHealthMetrics?.length, 9);
  // Regression guard for the version-string/IPv4 sanitizer collision: no
  // interface field should look like an IP address post-sanitization.
  for (const iface of device.interfaceHealthMetrics ?? []) {
    assert.doesNotMatch(iface.interface, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  }
});

test('scc/cpu-group-absent.json has memory/disk/interfaces but no cpuHealthMetrics key', () => {
  const response = readFixture<SccHealthMetricsResponse>('scc/cpu-group-absent.json');
  const device = response[0];
  assert.ok(device);
  assert.equal('cpuHealthMetrics' in device, false);
  assert.ok(device.memoryHealthMetrics);
  assert.ok(device.diskHealthMetrics);
  assert.ok(device.interfaceHealthMetrics && device.interfaceHealthMetrics.length > 0);
});

test('fmc/interface.json matches the verified FMC interfaceHealthMetricsList shape', () => {
  const response = readFixture<FmcAggregateMetricsResponse>('fmc/interface.json');
  const item = response.items?.[0];
  assert.ok(item);
  assert.ok(item.interfaceHealthMetricsList);
  assert.equal(item.interfaceHealthMetricsList.length, 9);
  for (const iface of item.interfaceHealthMetricsList) {
    assert.equal(typeof iface.interface, 'string');
    assert.ok(iface.currentLinkStatus === undefined || typeof iface.currentLinkStatus === 'string');
    // Regression guard: a real duplexMode/interfaceName value must never be
    // reshaped into something IP-shaped by sanitization.
    if (iface.duplexMode !== undefined) {
      assert.doesNotMatch(iface.duplexMode, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    }
  }
  // FMC timestamps are "YYYY-MM-DD HH:mm:ss.SSS UTC", not ISO 8601.
  assert.match(item.startTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC$/);
});

test('fmc/cpu.json, fmc/mem.json, fmc/disk-stats.json share the single-item wrapper shape', () => {
  const cpu = readFixture<FmcAggregateMetricsResponse>('fmc/cpu.json');
  const mem = readFixture<FmcAggregateMetricsResponse>('fmc/mem.json');
  const disk = readFixture<FmcAggregateMetricsResponse>('fmc/disk-stats.json');

  assert.equal(cpu.items?.length, 1);
  assert.ok(cpu.items?.[0]?.cpuHealthMetrics);
  assert.equal(typeof cpu.items?.[0]?.cpuHealthMetrics?.linaUsageAvg, 'number');

  assert.equal(mem.items?.length, 1);
  assert.ok(mem.items?.[0]?.memoryHealthMetrics);

  assert.equal(disk.items?.length, 1);
  assert.ok(disk.items?.[0]?.diskHealthMetrics);
});

test('fmc/empty-family.json is a capability-absent response: no items key, count 0', () => {
  const response = readFixture<FmcAggregateMetricsResponse>('fmc/empty-family.json');
  assert.equal('items' in response, false);
  assert.equal(response.paging.count, 0);
});

test('fmc/device-not-connected.json and fmc/unsupported-device.json are FmcErrorResponse shapes', () => {
  const deviceNotConnected = readFixture<{ error: { messages: Array<{ description: string }> } }>(
    'fmc/device-not-connected.json',
  );
  assert.equal(deviceNotConnected.error.messages[0]?.description, 'Device not connected.');

  const unsupportedDevice = readFixture<{ error: { messages: Array<{ description: string }> } }>(
    'fmc/unsupported-device.json',
  );
  assert.equal(unsupportedDevice.error.messages[0]?.description, 'Unsupported device');
});

test('fmc/devicerecords-page1.json has 4 devices with sanitized-but-plausible metadata', () => {
  const response = readFixture<FmcDeviceRecordsResponse>('fmc/devicerecords-page1.json');
  assert.equal(response.items?.length, 4);
  for (const device of response.items ?? []) {
    assert.match(device.id, /^[0-9a-f-]{36}$/i);
    assert.equal(typeof device.name, 'string');
  }
  // Regression guard: snortVersion ("3.9.3.1-61") must survive sanitization
  // unmangled — this is the exact field the IPv4-sweep bug corrupted.
  const raw = readFileSync(`${fixturesDir}/fmc/devicerecords-page1.json`, 'utf8');
  assert.match(raw, /"snortVersion":\s*"3\.9\.3\.1-61"/);
  assert.doesNotMatch(raw, /"snortVersion":\s*"203\.0\.113/);
});

test('fmc/provisional-chassis-stats.json is a valid FmcAggregateMetricsResponse for the real CHASSIS_STATS family', () => {
  const response = readFixture<FmcAggregateMetricsResponse & { _comment?: string }>(
    'fmc/provisional-chassis-stats.json',
  );
  assert.equal(typeof response._comment, 'string');
  assert.equal(response.items?.length, 1);
  assert.ok(response.items?.[0]?.chassisStatsHealthMetrics);
  assert.equal(response.paging.count, 1);
});

test('fmc/paginated-40-devices-page1.json + page2.json together cover 40 unique devices', () => {
  const page1 = readFixture<FmcDeviceRecordsResponse>('fmc/paginated-40-devices-page1.json');
  const page2 = readFixture<FmcDeviceRecordsResponse>('fmc/paginated-40-devices-page2.json');
  assert.equal(page1.items?.length, 25);
  assert.equal(page2.items?.length, 15);
  const ids = new Set([...(page1.items ?? []), ...(page2.items ?? [])].map((d) => d.id));
  assert.equal(ids.size, 40);
});

test('scc/inventory.json matches the expected SccInventoryResponse shape (GET /v1/inventory/devices)', () => {
  // Review finding: SccInventoryDeviceEntry/SccInventoryResponse were dead
  // code with no fixture-shape guard at all -- exactly the kind of gap that
  // let the `uid`-vs-`deviceUid` field-name error ship undetected until a
  // live smoke test caught it after the fact. This is that guard.
  const response = readFixture<SccInventoryResponse>('scc/inventory.json');
  assert.equal(response.items.length, 3);

  const ftds = response.items.filter(
    (item: SccInventoryDeviceEntry) => item.deviceType === 'CDFMC_MANAGED_FTD',
  );
  assert.equal(ftds.length, 2, 'the Meraki entry must not be a CDFMC_MANAGED_FTD');

  for (const device of ftds) {
    assert.match(device.uid, /^[0-9a-f-]{36}$/i);
    assert.equal(typeof device.name, 'string');
    assert.ok(
      device.connectivityState === 'ONLINE' || device.connectivityState === 'UNREACHABLE',
      `unexpected connectivityState: ${device.connectivityState}`,
    );
    assert.ok(
      device.redundancyMode === 'STANDALONE' || device.redundancyMode === 'HA',
      `unexpected redundancyMode: ${device.redundancyMode}`,
    );
  }

  const haDevice = ftds.find((d) => d.redundancyMode === 'HA');
  assert.ok(haDevice, 'expected one HA-paired device in the fixture');
  const unreachableDevice = ftds.find((d) => d.connectivityState === 'UNREACHABLE');
  assert.ok(unreachableDevice, 'expected one UNREACHABLE device in the fixture');

  const meraki = response.items.find((item) => item.deviceType === 'MERAKI_MX');
  assert.ok(meraki, 'expected the non-FTD MERAKI_MX entry to still be present in the raw fixture');
});

test('scc/s2s-1000-tunnels.json has exactly 1000 unique tunnel entries', () => {
  const response = readFixture<SccHealthMetricsResponse>('scc/s2s-1000-tunnels.json');
  const tunnels = response[0]?.s2sVpnTunnelHealthMetrics ?? [];
  assert.equal(tunnels.length, 1000);
  const ids = new Set(tunnels.map((t) => t.tunnelId));
  assert.equal(ids.size, 1000);
});
