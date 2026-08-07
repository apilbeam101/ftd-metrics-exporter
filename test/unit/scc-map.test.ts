import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mapSccResponse } from '../../src/backends/scc/map.ts';

function loadFixture(relativePath: string): unknown {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return JSON.parse(readFileSync(`${fixturesDir}/${relativePath}`, 'utf8'));
}

test('full-live.json maps 1 device, 9 interfaces, CPU/MEM/DISK populated with exact expected floats', () => {
  const result = mapSccResponse(loadFixture('scc/full-live.json'));
  assert.equal(result.snapshots.length, 1);
  const device = result.snapshots[0];
  assert.ok(device);
  assert.equal(device.deviceUid, '00000000-0000-4000-8000-000000000001');
  assert.equal(device.cpu?.lina, 4.1811);
  assert.equal(device.cpu?.snort, 1.1782);
  assert.equal(device.cpu?.system, 50.4653);
  assert.equal(device.memory?.lina, 30.85);
  assert.equal(device.disk?.totalUsagePercent, 16.9952);
  assert.equal(device.interfaces?.length, 9);
});

test('full-live.json: all conditional groups are undefined, not zero-valued objects', () => {
  const result = mapSccResponse(loadFixture('scc/full-live.json'));
  const device = result.snapshots[0];
  assert.ok(device);
  assert.equal(device.chassis, undefined);
  assert.equal(device.ha, undefined);
  assert.equal(device.raVpn, undefined);
  assert.equal(device.s2sTunnels, undefined);
});

test('cpu-group-absent.json: cpu is undefined while memory/disk/interfaces are populated', () => {
  const result = mapSccResponse(loadFixture('scc/cpu-group-absent.json'));
  const device = result.snapshots[0];
  assert.ok(device);
  assert.equal(device.cpu, undefined);
  assert.ok(device.memory);
  assert.ok(device.disk);
  assert.ok(device.interfaces && device.interfaces.length > 0);
  // Absence of a group must produce no diagnostic — it is normal.
  assert.deepEqual(result.parseErrors, []);
});

test('provisional-all-groups-present.json: all five conditional groups mapped with exact field values', () => {
  const result = mapSccResponse(loadFixture('scc/provisional-all-groups-present.json'));
  const device = result.snapshots[0];
  assert.ok(device);
  assert.deepEqual(device.chassis?.fans, [
    { fan: '1', rpmAvg: 4200 },
    { fan: '2', rpmAvg: 4150 },
    { fan: '3', rpmAvg: 4180 },
    { fan: '4', rpmAvg: 4190 },
  ]);
  assert.deepEqual(device.chassis?.psus[1], {
    psu: '2',
    fanStatus: 'UP',
    inputStatus: 'UP',
    outputStatus: 'DOWN',
  });
  assert.deepEqual(device.ha, { nodeStatus: 'NORMAL', nodeType: 'PRIMARY' });
  assert.equal(device.raVpn?.activeSessionsAvg, 42);
  assert.equal(device.raVpn?.peakConcurrentSessions, 58);
  assert.equal(device.s2sTunnels?.length, 2);
  assert.equal(device.s2sTunnels?.[1]?.tunnelState, 'TUNNEL_DOWN');
});

test('interface-name-absent.json: interfaceName falls back to the hardware interface id', () => {
  const result = mapSccResponse(loadFixture('scc/interface-name-absent.json'));
  const device = result.snapshots[0];
  const iface = device?.interfaces?.[0];
  assert.ok(iface);
  assert.equal(iface.interface, 'Ethernet1/2');
  assert.equal(iface.interfaceName, 'Ethernet1/2');
});

test('zero-values.json: a genuine 0 CPU reading is emitted, not swallowed by truthiness', () => {
  const result = mapSccResponse(loadFixture('scc/zero-values.json'));
  const device = result.snapshots[0];
  assert.ok(device);
  assert.equal(device.cpu?.lina, 0);
  assert.equal(device.cpu?.snort, 0);
  assert.equal(device.cpu?.system, 0);
  assert.equal(device.memory?.lina, 0);
  assert.equal(device.disk?.totalUsagePercent, 0);
});

test('zero-values.json: all-zero interfaces are present, not filtered', () => {
  const result = mapSccResponse(loadFixture('scc/zero-values.json'));
  const device = result.snapshots[0];
  const iface = device?.interfaces?.[0];
  assert.ok(iface);
  assert.equal(iface.inputBytesAvg, 0);
  assert.equal(iface.outputBytesAvg, 0);
});

test('full-live.json: down and unused interfaces are exported, not filtered', () => {
  const result = mapSccResponse(loadFixture('scc/full-live.json'));
  const device = result.snapshots[0];
  const names = device?.interfaces?.map((i) => i.interface);
  assert.ok(names?.includes('Ethernet1/4')); // DOWN
  assert.ok(names?.includes('Ethernet1/6')); // DOWN, unused
});

test('malformed.json: a device with a broken group still yields its other groups', () => {
  const result = mapSccResponse(loadFixture('scc/malformed.json'));
  const brokenCpuDevice = result.snapshots.find(
    (d) => d.deviceUid === '00000000-0000-4000-8000-000000000010',
  );
  assert.ok(brokenCpuDevice);
  assert.equal(brokenCpuDevice.cpu, undefined);
  assert.ok(brokenCpuDevice.memory);
  assert.ok(brokenCpuDevice.disk);
  assert.ok(brokenCpuDevice.interfaces && brokenCpuDevice.interfaces.length > 0);
  assert.ok(
    result.parseErrors.some(
      (e) => e.deviceUid === '00000000-0000-4000-8000-000000000010' && e.group === 'cpu',
    ),
  );
});

test('malformed.json: a device missing deviceUid is skipped entirely while siblings survive', () => {
  const result = mapSccResponse(loadFixture('scc/malformed.json'));
  assert.equal(
    result.snapshots.some((d) => d.deviceName === 'ftd-missing-uid'),
    false,
  );
  // Three of the four devices in this fixture have a valid deviceUid.
  assert.equal(result.snapshots.length, 3);
});

test('malformed.json: an unparseable startTime is dropped with a diagnostic, not fatal', () => {
  const result = mapSccResponse(loadFixture('scc/malformed.json'));
  const device = result.snapshots.find(
    (d) => d.deviceUid === '00000000-0000-4000-8000-000000000012',
  );
  assert.ok(device);
  assert.equal(device.windowStart, undefined);
  assert.equal(device.windowEnd?.toISOString(), '2026-07-31T09:53:05.000Z');
  assert.ok(result.parseErrors.some((e) => e.group === 'startTime'));
});

test('malformed.json: an unknown enum value is preserved raw on the domain object', () => {
  const result = mapSccResponse(loadFixture('scc/malformed.json'));
  const device = result.snapshots.find(
    (d) => d.deviceUid === '00000000-0000-4000-8000-000000000013',
  );
  assert.ok(device);
  // DESIGN.md §3.2.6: the mapper keeps the raw string; the renderer (Stage
  // 3) is responsible for recognizing "FLAPPING" as unknown and emitting
  // the unknown-enum diagnostic + counter. The mapper itself does not
  // reject or normalize it.
  assert.equal(device.interfaces?.[0]?.linkStatus, 'FLAPPING');
});

test('s2s-1000-tunnels.json: all 1000 tunnel entries are mapped', () => {
  const result = mapSccResponse(loadFixture('scc/s2s-1000-tunnels.json'));
  const device = result.snapshots[0];
  assert.equal(device?.s2sTunnels?.length, 1000);
});

test('a 200 response with an empty device array yields zero snapshots, not an error', () => {
  const result = mapSccResponse([]);
  assert.deepEqual(result.snapshots, []);
  assert.deepEqual(result.parseErrors, []);
});

test('a non-array payload is a root-level parse error, not a crash', () => {
  const result = mapSccResponse({ not: 'an array' });
  assert.deepEqual(result.snapshots, []);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0]?.group, 'root');
});
