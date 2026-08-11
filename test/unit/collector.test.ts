import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mapSccResponse } from '../../src/backends/scc/map.ts';
import type { DeviceHealthSnapshot } from '../../src/domain/snapshot.ts';
import { parseExposition } from './support/exposition.ts';
import { createTestRenderer } from './support/render.ts';

function loadFixture(relativePath: string): unknown {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return JSON.parse(readFileSync(`${fixturesDir}/${relativePath}`, 'utf8'));
}

function loadGolden(name: string): string {
  const goldenDir = fileURLToPath(new URL('../fixtures/golden', import.meta.url));
  return readFileSync(`${goldenDir}/${name}`, 'utf8');
}

function mapDevices(fixture: string): DeviceHealthSnapshot[] {
  return mapSccResponse(loadFixture(fixture)).snapshots;
}

// --- Testing step 1: golden-output tests --------------------------------

test('golden: full-live.json renders byte-exact expected exposition text', async () => {
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/full-live.json'));
  const text = await renderer.text();
  assert.equal(text, loadGolden('scc-full-live.prom'));
});

test('golden: provisional-all-groups-present.json renders byte-exact expected exposition text', async () => {
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/provisional-all-groups-present.json'));
  const text = await renderer.text();
  assert.equal(text, loadGolden('scc-all-groups.prom'));
});

test('golden: zero-values.json renders byte-exact expected exposition text', async () => {
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/zero-values.json'));
  const text = await renderer.text();
  assert.equal(text, loadGolden('scc-zero-values.prom'));
});

// --- Testing step 2: exposition-format validity --------------------------

for (const fixture of [
  'scc/full-live.json',
  'scc/cpu-group-absent.json',
  'scc/provisional-all-groups-present.json',
  'scc/zero-values.json',
  'scc/interface-name-absent.json',
  'scc/malformed.json',
  'scc/s2s-1000-tunnels.json',
]) {
  test(`exposition-format validity: ${fixture} parses under the strict grammar`, async () => {
    const renderer = createTestRenderer();
    renderer.render(mapDevices(fixture));
    const text = await renderer.text();
    // Throws on any malformed HELP/TYPE ordering, label escaping, or numeric formatting.
    const families = parseExposition(text);
    assert.ok(families.length > 0);
  });
}

// --- Testing step 3: series disappearance (§4.8) --------------------------

test('series disappearance: a device removed between renders leaves no trace', async () => {
  const renderer = createTestRenderer();
  const deviceA: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    cpu: { lina: 1, snort: 2, system: 3 },
    memory: { lina: 4, snort: 5, system: 6 },
    disk: { totalUsagePercent: 7 },
  };
  const deviceB: DeviceHealthSnapshot = {
    deviceUid: 'device-b',
    deviceName: 'ftd-b',
    cpu: { lina: 10, snort: 20, system: 30 },
    memory: { lina: 40, snort: 50, system: 60 },
    disk: { totalUsagePercent: 70 },
  };

  renderer.render([deviceA, deviceB]);
  const textWithBoth = await renderer.text();
  assert.match(textWithBoth, /device_uid="device-b"/);

  renderer.render([deviceA]);
  const textWithOnlyA = await renderer.text();
  assert.doesNotMatch(textWithOnlyA, /device_uid="device-b"/);
  assert.match(textWithOnlyA, /device_uid="device-a"/);
});

test('series disappearance: every metric family clears device-b, not only CPU', async () => {
  // DESIGN.md §4.8's top risk explicitly: resetting only some families
  // while one stale family lingers. Check every group, not just CPU.
  const renderer = createTestRenderer();
  const deviceA: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    cpu: { lina: 1 },
  };
  const deviceB: DeviceHealthSnapshot = {
    deviceUid: 'device-b',
    deviceName: 'ftd-b',
    cpu: { lina: 1 },
    memory: { lina: 1 },
    disk: { totalUsagePercent: 1 },
    interfaces: [{ interface: 'Ethernet1/1', interfaceName: 'outside', linkStatus: 'UP' }],
    chassis: { fans: [{ fan: '1', rpmAvg: 4000 }], psus: [{ psu: '1', inputStatus: 'UP' }] },
    ha: { nodeStatus: 'NORMAL', nodeType: 'PRIMARY' },
    raVpn: { activeSessionsAvg: 1 },
    s2sTunnels: [{ tunnelId: 't1', tunnelName: 'tun', tunnelState: 'TUNNEL_UP' }],
    windowStart: new Date('2026-07-31T09:00:00Z'),
    windowEnd: new Date('2026-07-31T09:05:00Z'),
  };

  renderer.render([deviceA, deviceB]);
  renderer.render([deviceA]);
  const text = await renderer.text();
  assert.doesNotMatch(text, /device_uid="device-b"/);
});

test('series disappearance: an interface removed from a device vanishes at interface granularity', async () => {
  const withTwoInterfaces: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    interfaces: [
      { interface: 'Ethernet1/1', interfaceName: 'outside', linkStatus: 'UP' },
      { interface: 'Ethernet1/2', interfaceName: 'inside', linkStatus: 'UP' },
    ],
  };
  const withOneInterface: DeviceHealthSnapshot = {
    ...withTwoInterfaces,
    interfaces: [{ interface: 'Ethernet1/1', interfaceName: 'outside', linkStatus: 'UP' }],
  };

  const renderer = createTestRenderer();
  renderer.render([withTwoInterfaces]);
  const textBefore = await renderer.text();
  assert.match(textBefore, /interface="Ethernet1\/2"/);

  renderer.render([withOneInterface]);
  const textAfter = await renderer.text();
  assert.doesNotMatch(textAfter, /interface="Ethernet1\/2"/);
  assert.match(textAfter, /interface="Ethernet1\/1"/);
});

// --- Testing step 4: absent-group non-emission ----------------------------

test('absent-group non-emission: full-live.json (all conditional groups absent) emits zero chassis/ha/ravpn/s2s series', async () => {
  // HELP/TYPE header lines for these families are always present — every
  // declared metric family is documented on /metrics whether or not it has
  // samples, which is normal Prometheus practice. What must never appear is
  // an actual *sample line* for one of these families.
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/full-live.json'));
  const text = await renderer.text();
  const families = parseExposition(text);
  for (const prefix of ['ftd_ha_', 'ftd_chassis_', 'ftd_ravpn_', 'ftd_s2s_']) {
    for (const family of families.filter((f) => f.name.startsWith(prefix))) {
      assert.equal(family.samples.length, 0, `expected no samples for ${family.name}`);
    }
  }
});

test('absent-group non-emission: ftd_ha_node_status never appears with value 0 when HA is entirely absent', async () => {
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/full-live.json'));
  const text = await renderer.text();
  const families = parseExposition(text);
  const haStatus = families.find((f) => f.name === 'ftd_ha_node_status');
  assert.ok(haStatus);
  assert.equal(haStatus.samples.length, 0);
});

// --- Testing step 5: state-set completeness --------------------------------

test('state-set completeness: with HA present, all five status= series exist and exactly one is 1', async () => {
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/provisional-all-groups-present.json'));
  const text = await renderer.text();
  const families = parseExposition(text);
  const haFamily = families.find((f) => f.name === 'ftd_ha_node_status');
  assert.ok(haFamily);
  assert.equal(haFamily.samples.length, 5);
  const statuses = haFamily.samples.map((s) => s.labels.status).sort();
  assert.deepEqual(statuses, ['disabled', 'error', 'normal', 'unknown', 'warning']);
  const onesCount = haFamily.samples.filter((s) => s.value === 1).length;
  assert.equal(onesCount, 1);
  assert.equal(haFamily.samples.find((s) => s.value === 1)?.labels.status, 'normal');
});

// --- Testing step 6: boolean naming ----------------------------------------

test('boolean naming: linkStatus DOWN renders ftd_interface_link_up as present, valued 0', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    interfaces: [{ interface: 'Ethernet1/1', interfaceName: 'outside', linkStatus: 'DOWN' }],
  };
  renderer.render([device]);
  const text = await renderer.text();
  const families = parseExposition(text);
  const linkUp = families.find((f) => f.name === 'ftd_interface_link_up');
  assert.ok(linkUp);
  assert.equal(linkUp.samples.length, 1);
  assert.equal(linkUp.samples[0]?.value, 0);
});

test('boolean naming vs group absence: an interface with no linkStatus at all emits no ftd_interface_link_up series for it', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    interfaces: [{ interface: 'Ethernet1/1', interfaceName: 'outside' }],
  };
  renderer.render([device]);
  const text = await renderer.text();
  const families = parseExposition(text);
  const linkUp = families.find((f) => f.name === 'ftd_interface_link_up');
  assert.ok(linkUp);
  assert.equal(linkUp.samples.length, 0);
});

// --- Testing step 7: interface-name fallback in labels ---------------------

test('interface-name fallback: interface_name falls back to hardware id, never emits interface_name=""', async () => {
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/interface-name-absent.json'));
  const text = await renderer.text();
  assert.match(text, /interface_name="Ethernet1\/2"/);
  assert.doesNotMatch(text, /interface_name=""/);
});

// --- Testing step 8: zero-value emission ------------------------------------

test('zero-value emission: a genuine 0 CPU reading renders as 0, not omitted', async () => {
  const renderer = createTestRenderer();
  renderer.render(mapDevices('scc/zero-values.json'));
  const text = await renderer.text();
  const families = parseExposition(text);
  const cpu = families.find((f) => f.name === 'ftd_cpu_usage_ratio');
  assert.ok(cpu);
  assert.equal(cpu.samples.length, 3);
  assert.ok(cpu.samples.every((s) => s.value === 0));
});

// --- Testing step 9: unknown enum -------------------------------------------

test('unknown enum: linkStatus FLAPPING omits the boolean and increments ftd_exporter_unknown_enum_total', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    interfaces: [{ interface: 'Ethernet1/1', interfaceName: 'outside', linkStatus: 'FLAPPING' }],
  };
  renderer.render([device]);
  const text = await renderer.text();
  const families = parseExposition(text);
  const linkUp = families.find((f) => f.name === 'ftd_interface_link_up');
  assert.ok(linkUp);
  assert.equal(linkUp.samples.length, 0);

  const counterValue = await renderer.unknownEnumTotal
    .get()
    .then((m) =>
      m.values.find(
        (v) => v.labels.metric === 'ftd_interface_link_up' && v.labels.value === 'flapping',
      ),
    );
  assert.equal(counterValue?.value, 1);
});

test('unknown enum: a novel interface_type renders the RAW value unchanged, not "unknown", but still increments the counter', async () => {
  // Confirmed live against SCC (2026-08-11): interface_type is purely
  // informational, and its rendered value is the versioned public API
  // (DESIGN.md §13/§4.3) — unlike every other enum, an unrecognized value
  // must never be coerced to a fallback label. The diagnostic counter still
  // fires so a genuinely new upstream value is visible without changing what
  // anyone currently sees.
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    interfaces: [
      {
        interface: 'Port-channel1',
        interfaceName: 'uplink',
        interfaceType: 'VirtualPortChannel',
        linkStatus: 'UP',
      },
    ],
  };
  renderer.render([device]);
  const text = await renderer.text();
  assert.doesNotMatch(text, /interface_type="unknown"/);
  assert.match(text, /interface_type="VirtualPortChannel"/);

  const counterValue = await renderer.unknownEnumTotal
    .get()
    .then((m) =>
      m.values.find(
        (v) => v.labels.metric === 'ftd_interface_type' && v.labels.value === 'virtualportchannel',
      ),
    );
  assert.equal(counterValue?.value, 1);
});

test('unknown enum: every documented interface_type value increments no counter', async () => {
  // Negative-side coverage for the same guard, mirroring the HA "already
  // recognized literal" test below — SubInterface is the newest confirmed
  // live value (2026-08-11 FTDv subinterface capture).
  for (const raw of ['Ethernet', 'Management', 'SubInterface', 'GigabitEthernet']) {
    const renderer = createTestRenderer();
    const device: DeviceHealthSnapshot = {
      deviceUid: 'device-a',
      deviceName: 'ftd-a',
      interfaces: [
        {
          interface: 'Ethernet1/1',
          interfaceName: 'outside',
          interfaceType: raw,
          linkStatus: 'UP',
        },
      ],
    };
    renderer.render([device]);
    await renderer.text();
    const counterValues = await renderer.unknownEnumTotal.get();
    assert.equal(counterValues.values.length, 0, `${raw} unexpectedly flagged as unrecognized`);
    assert.match(await renderer.text(), new RegExp(`interface_type="${raw}"`));
  }
});

test('unknown enum: an unrecognized HA node status sets status="unknown" active and increments the counter', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    ha: { nodeStatus: 'TOTALLY_NEW_STATE', nodeType: 'PRIMARY' },
  };
  renderer.render([device]);
  const text = await renderer.text();
  const families = parseExposition(text);
  const haStatus = families.find((f) => f.name === 'ftd_ha_node_status');
  assert.ok(haStatus);
  assert.equal(haStatus.samples.find((s) => s.labels.status === 'unknown')?.value, 1);
  assert.equal(haStatus.samples.find((s) => s.labels.status === 'normal')?.value, 0);

  const counterValue = await renderer.unknownEnumTotal
    .get()
    .then((m) =>
      m.values.find(
        (v) => v.labels.metric === 'ftd_ha_node_status' && v.labels.value === 'totally_new_state',
      ),
    );
  assert.equal(counterValue?.value, 1);
});

test('unknown enum: the already-recognized literal HA status "UNKNOWN" does not increment the diagnostic counter', async () => {
  // DESIGN.md's HaNodeStatus vocabulary includes the literal upstream value
  // "UNKNOWN" as a normal, expected enum member — distinct from a value
  // this exporter has never seen before. Only the latter is schema drift.
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    ha: { nodeStatus: 'UNKNOWN', nodeType: 'PRIMARY' },
  };
  renderer.render([device]);
  await renderer.text();
  const counterValues = await renderer.unknownEnumTotal.get();
  assert.equal(counterValues.values.length, 0);
});

// --- Testing step 10: timestamp gauges ---------------------------------------

test('timestamp gauges: window start/end render as unix-second gauge values matching the parsed fixture dates (SCC/ISO 8601)', async () => {
  const renderer = createTestRenderer();
  const devices = mapDevices('scc/full-live.json');
  const device = devices[0];
  assert.ok(device?.windowStart);
  assert.ok(device.windowEnd);
  renderer.render(devices);
  const text = await renderer.text();
  const families = parseExposition(text);
  const start = families.find((f) => f.name === 'ftd_health_window_start_timestamp_seconds');
  const end = families.find((f) => f.name === 'ftd_health_window_end_timestamp_seconds');
  assert.equal(start?.samples[0]?.value, device.windowStart.getTime() / 1000);
  assert.equal(end?.samples[0]?.value, device.windowEnd.getTime() / 1000);
});

// --- Testing step 11: cardinality tripwire -----------------------------------

test('cardinality tripwire: s2s-1000-tunnels.json series_total matches an independently computed count', async () => {
  const renderer = createTestRenderer();
  const devices = mapDevices('scc/s2s-1000-tunnels.json');
  const device = devices[0];
  assert.equal(device?.s2sTunnels?.length, 1000);

  const result = renderer.render(devices);
  const text = await renderer.text();

  // Independently computed: 1000 tunnels * 3 state-set series each, plus
  // the fixture's own windowStart/windowEnd timestamps (it has no
  // CPU/memory/disk/interfaces/chassis/HA/RA VPN).
  assert.ok(device.windowStart);
  assert.ok(device.windowEnd);
  const expected = 1000 * 3 + 2;
  assert.equal(result.seriesCount, expected);

  // Informal budget signal per the plan: the byte size itself is not asserted on,
  // only that rendering 3000+ series completes and produces non-empty output.
  const byteSize = Buffer.byteLength(text, 'utf8');
  assert.ok(byteSize > 0);
});

// --- Testing step 12: reset() correctness under concurrency ------------------

test('reset() correctness under concurrency: two overlapping synchronous renders never interleave', async () => {
  // renderDeviceMetrics has no await inside its reset-then-repopulate loop,
  // so within a single synchronous call there is no yield point for a
  // second render to interleave at. This test proves that property by
  // driving two renders back-to-back with no intervening microtask and
  // asserting the final state is wholly the second render's, never a mix.
  const renderer = createTestRenderer();
  const deviceA: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    cpu: { lina: 1 },
  };
  const deviceB: DeviceHealthSnapshot = {
    deviceUid: 'device-b',
    deviceName: 'ftd-b',
    cpu: { lina: 2 },
  };

  renderer.render([deviceA]);
  renderer.render([deviceB]);
  const text = await renderer.text();
  assert.doesNotMatch(text, /device_uid="device-a"/);
  assert.match(text, /device_uid="device-b"/);
});

// --- Additional: counters survive a device-metrics render (risk: self metrics must not be reset here) ---

test('renderDeviceMetrics never touches the unknown-enum counter except to increment it — a pre-existing count survives a scrape with no unknown values', async () => {
  const renderer = createTestRenderer();
  renderer.unknownEnumTotal.inc({ metric: 'ftd_interface_link_up', value: 'flapping' });
  const before = await renderer.unknownEnumTotal.get();
  assert.equal(before.values[0]?.value, 1);

  renderer.render(mapDevices('scc/full-live.json'));

  const after = await renderer.unknownEnumTotal.get();
  assert.equal(after.values[0]?.value, 1);
});

// --- Empty-string labels are never emitted (DESIGN.md §4.3) ------------------

test('empty-string labels are never emitted: an interface with an empty interfaceType string omits the label entirely', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    interfaces: [{ interface: 'Ethernet1/1', interfaceName: 'outside', interfaceType: '' }],
  };
  renderer.render([device]);
  const text = await renderer.text();
  assert.doesNotMatch(text, /interface_type=""/);
});

// --- Regression: interfaceName present-but-empty must still fall back (review finding 1) ---

test('interface_name never emits an empty string: a present-but-empty interfaceName falls back to the hardware id', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    interfaces: [{ interface: 'Ethernet1/1', interfaceName: '', linkStatus: 'UP' }],
  };
  renderer.render([device]);
  const text = await renderer.text();
  assert.doesNotMatch(text, /interface_name=""/);
  assert.match(text, /interface_name="Ethernet1\/1"/);
});

// --- Regression: series_total must count distinct series, not set() calls (review finding 2) ---

test('cardinality tripwire counts distinct series, not set() calls: duplicate tunnel labels collapse to one series', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    s2sTunnels: [
      { tunnelId: 't1', tunnelName: 'n1', tunnelState: 'TUNNEL_UP' },
      { tunnelId: 't1', tunnelName: 'n1', tunnelState: 'TUNNEL_DOWN' },
    ],
  };
  const result = renderer.render([device]);
  const text = await renderer.text();
  const families = parseExposition(text);
  const tunnelFamily = families.find((f) => f.name === 'ftd_s2s_tunnel_state');
  assert.ok(tunnelFamily);
  // Same tunnel_id/tunnel_name means the second entry's 3 state-set writes
  // land on the same 3 label combinations as the first's — 3 series total,
  // not 6, however many times the upstream array repeats the same tunnel.
  assert.equal(tunnelFamily.samples.length, 3);
  assert.equal(result.seriesCount, 3);
});

// --- Regression: unrecognized HA node_type must be flagged, not silently minted (review finding 3) ---

test('unrecognized HA node_type still renders ftd_ha_node_info (never omitted) with a bounded "unknown" label, and increments the unknown-enum counter with the raw value', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    ha: { nodeStatus: 'NORMAL', nodeType: 'ARBITER' },
  };
  renderer.render([device]);
  const text = await renderer.text();
  const families = parseExposition(text);
  const haInfo = families.find((f) => f.name === 'ftd_ha_node_info');
  assert.ok(haInfo);
  assert.equal(haInfo.samples.length, 1);
  assert.equal(haInfo.samples[0]?.labels.node_type, 'unknown');
  assert.equal(haInfo.samples[0]?.value, 1);

  const counterValue = await renderer.unknownEnumTotal
    .get()
    .then((m) =>
      m.values.find((v) => v.labels.metric === 'ftd_ha_node_info' && v.labels.value === 'arbiter'),
    );
  assert.equal(counterValue?.value, 1);
});

test('a documented HA node_type (PRIMARY/SECONDARY) never increments the unknown-enum counter for ftd_ha_node_info', async () => {
  const renderer = createTestRenderer();
  const device: DeviceHealthSnapshot = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    ha: { nodeStatus: 'NORMAL', nodeType: 'PRIMARY' },
  };
  renderer.render([device]);
  await renderer.text();
  const values = await renderer.unknownEnumTotal.get();
  assert.equal(values.values.filter((v) => v.labels.metric === 'ftd_ha_node_info').length, 0);
});
