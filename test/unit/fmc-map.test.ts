import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mapFmcFamilyResponse, mergeFmcFamilies } from '../../src/backends/fmc/map.ts';
import type { FmcAggregateMetricsResponse } from '../../src/backends/fmc/schema.ts';
import { mapSccResponse } from '../../src/backends/scc/map.ts';

function loadFixture(relativePath: string): FmcAggregateMetricsResponse {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return JSON.parse(readFileSync(`${fixturesDir}/${relativePath}`, 'utf8'));
}

const DEVICE_UID = '00000000-0000-4000-8000-000000000003';

test('fmc/cpu.json: lina/snort/system extracted from items[0].cpuHealthMetrics', () => {
  const result = mapFmcFamilyResponse(loadFixture('fmc/cpu.json'), 'CPU', DEVICE_UID);
  assert.equal(result.partial.cpu?.lina, 0.3);
  assert.equal(result.partial.cpu?.snort, 0.29);
  assert.equal(result.partial.cpu?.system, 19.0);
  assert.deepEqual(result.parseErrors, []);
});

test('fmc/interface.json: 9 interfaces read from interfaceHealthMetricsList', () => {
  const result = mapFmcFamilyResponse(loadFixture('fmc/interface.json'), 'INTERFACE', DEVICE_UID);
  assert.equal(result.partial.interfaces?.length, 9);
});

test('a payload using SCC key "interfaceHealthMetrics" instead of FMC key yields zero interfaces', () => {
  // Regression guard for the exact bug DESIGN.md §14.1 warns about: "a
  // naive adapter reusing SCC's field names verbatim against FMC would
  // silently produce empty series."
  const fmcResponse = loadFixture('fmc/interface.json');
  const item = fmcResponse.items?.[0] as unknown as Record<string, unknown>;
  const sccShaped: FmcAggregateMetricsResponse = {
    ...fmcResponse,
    items: [
      {
        ...item,
        interfaceHealthMetricsList: undefined,
        interfaceHealthMetrics: item.interfaceHealthMetricsList,
      } as never,
    ],
  };
  const result = mapFmcFamilyResponse(sccShaped, 'INTERFACE', DEVICE_UID);
  assert.equal(result.partial.interfaces, undefined);
});

test('link/operational status read from currentLinkStatus/currentOperationalStatus', () => {
  const result = mapFmcFamilyResponse(loadFixture('fmc/interface.json'), 'INTERFACE', DEVICE_UID);
  const internet = result.partial.interfaces?.find((i) => i.interface === 'GigabitEthernet0/0');
  assert.ok(internet);
  assert.equal(internet.linkStatus, 'UP');
  assert.equal(internet.operationalStatus, 'UP');
});

test('a payload using SCC key "linkStatus" instead of FMC key yields no linkStatus, not a false UP', () => {
  const fmcResponse = loadFixture('fmc/interface.json');
  const item = fmcResponse.items?.[0] as unknown as Record<string, unknown>;
  const list = item.interfaceHealthMetricsList as Array<Record<string, unknown>>;
  const first = list[0] as Record<string, unknown>;
  // Destructure rather than delete/undefined-assign: an undefined-assignment
  // would leave the key present, defeating the point of this test (the FMC
  // field must be genuinely absent, not present-but-undefined).
  const { currentLinkStatus: _omit, ...withoutCurrentLinkStatus } = first;
  const sccShapedFirst: Record<string, unknown> = {
    ...withoutCurrentLinkStatus,
    linkStatus: 'DOWN',
  };
  const sccShaped: FmcAggregateMetricsResponse = {
    ...fmcResponse,
    items: [{ ...item, interfaceHealthMetricsList: [sccShapedFirst, ...list.slice(1)] } as never],
  };
  const result = mapFmcFamilyResponse(sccShaped, 'INTERFACE', DEVICE_UID);
  const first_ = result.partial.interfaces?.[0];
  assert.ok(first_);
  // linkStatus is undefined — the FMC-correct field was absent, so the
  // mapper must not report a false "UP" derived from the wrong key, and
  // must not substitute a sentinel string either (that would make an
  // absent field indistinguishable from an upstream literal "UNKNOWN").
  assert.equal(first_.linkStatus, undefined);
});

test('duplexMode is mapped when populated (FMC observes it; SCC never has)', () => {
  const result = mapFmcFamilyResponse(loadFixture('fmc/interface.json'), 'INTERFACE', DEVICE_UID);
  const internet = result.partial.interfaces?.find((i) => i.interface === 'GigabitEthernet0/0');
  assert.equal(internet?.duplexMode, 'FULL');
});

test('FMC timestamp format "YYYY-MM-DD HH:mm:ss.SSS UTC" parses to the correct epoch', () => {
  const result = mapFmcFamilyResponse(loadFixture('fmc/interface.json'), 'INTERFACE', DEVICE_UID);
  assert.equal(result.windowStart?.toISOString(), '2026-07-31T09:57:10.009Z');
  assert.equal(result.windowEnd?.toISOString(), '2026-07-31T10:57:10.009Z');
});

test('an ISO 8601 string, an empty string, and garbage are all rejected by the FMC timestamp parser', () => {
  const base = loadFixture('fmc/interface.json');
  const item = base.items?.[0] as unknown as Record<string, unknown>;
  for (const badTimestamp of ['2026-07-31T09:57:10.009Z', '', 'not-a-timestamp']) {
    const modified: FmcAggregateMetricsResponse = {
      ...base,
      items: [{ ...item, startTime: badTimestamp } as never],
    };
    const result = mapFmcFamilyResponse(modified, 'INTERFACE', DEVICE_UID);
    assert.equal(result.windowStart, undefined, `expected "${badTimestamp}" to be rejected`);
    assert.ok(result.parseErrors.some((e) => e.message.includes('unparseable')));
  }
});

test('fmc/empty-family.json: group omitted, parseErrors empty (capability/policy absence is normal)', () => {
  const result = mapFmcFamilyResponse(
    loadFixture('fmc/empty-family.json'),
    'CHASSIS_STATS',
    DEVICE_UID,
  );
  assert.deepEqual(result.partial, {});
  assert.deepEqual(result.parseErrors, []);
});

test('a null response body is a parse error, not an uncaught crash', () => {
  const result = mapFmcFamilyResponse(null, 'CPU', DEVICE_UID);
  assert.deepEqual(result.partial, {});
  assert.equal(result.parseErrors.length, 1);
});

test('a non-object response body (string, number, array) is a parse error, not silent absence', () => {
  for (const badBody of ['a string', 42, []]) {
    const result = mapFmcFamilyResponse(badBody, 'CPU', DEVICE_UID);
    assert.deepEqual(result.partial, {});
    assert.equal(
      result.parseErrors.length,
      1,
      `expected a parse error for ${JSON.stringify(badBody)}`,
    );
  }
});

test('an FMC per-device error envelope (device-not-connected.json) is a parse error, not silent absence', () => {
  // Regression guard: without the isEmptyFamilyResponse fix, this fixture
  // (which has neither `items` nor `paging`) was indistinguishable from a
  // legitimate capability-absent family, silently swallowing a genuine
  // per-device failure with zero diagnostics.
  const result = mapFmcFamilyResponse(
    loadFixture('fmc/device-not-connected.json'),
    'INTERFACE',
    DEVICE_UID,
  );
  assert.deepEqual(result.partial, {});
  assert.equal(result.parseErrors.length, 1);
});

test('items[0].id mismatching the requested device is a parse error, and the mismatched data is discarded', () => {
  // Regression guard: a filter-string bug (DESIGN.md §3.3.4 calls the
  // filter builder "a likely bug site") that fails to scope the request
  // could return another device's data under this device's UID with zero
  // diagnostics. items[0].id must be checked, not just items[0] presence.
  const body = {
    links: {},
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
    items: [
      {
        startTime: '2026-07-31 09:00:00.000 UTC',
        endTime: '2026-07-31 09:05:00.000 UTC',
        cpuHealthMetrics: { linaUsageAvg: 99 },
        name: 'OTHER-DEVICE',
        id: 'wrong-device-uid',
      },
    ],
  };
  const result = mapFmcFamilyResponse(body, 'CPU', DEVICE_UID);
  assert.equal(result.partial.cpu, undefined);
  assert.ok(
    result.parseErrors.some((e) => e.message.includes('does not match the requested device')),
  );
});

test('items[0].id matching the requested device maps normally', () => {
  const body = {
    links: {},
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
    items: [
      {
        startTime: '2026-07-31 09:00:00.000 UTC',
        endTime: '2026-07-31 09:05:00.000 UTC',
        cpuHealthMetrics: { linaUsageAvg: 5 },
        name: 'ftd1',
        id: DEVICE_UID,
      },
    ],
  };
  const result = mapFmcFamilyResponse(body, 'CPU', DEVICE_UID);
  assert.equal(result.partial.cpu?.lina, 5);
  assert.deepEqual(result.parseErrors, []);
});

test('paging.count > 1 on a single-device query is flagged as an unscoped filter and the result is dropped fail-closed, not published from items[0] (review finding F10)', () => {
  const body = {
    links: {},
    paging: { offset: 0, limit: 25, count: 2, pages: 1 },
    items: [
      {
        startTime: '2026-07-31 09:00:00.000 UTC',
        endTime: '2026-07-31 09:05:00.000 UTC',
        cpuHealthMetrics: { linaUsageAvg: 5 },
        name: 'ftd1',
        id: DEVICE_UID,
      },
    ],
  };
  const result = mapFmcFamilyResponse(body, 'CPU', DEVICE_UID);
  assert.ok(result.parseErrors.some((e) => e.message.includes('unexpectedly matched')));
  assert.deepEqual(
    result.partial,
    {},
    'a device-identity-ambiguous response must not be trusted, even partially — items[0] must not be published',
  );
});

test('mergeFmcFamilies: CPU + MEM success, INTERFACE + CHASSIS empty, produces one snapshot with the newest window', () => {
  const cpu = mapFmcFamilyResponse(loadFixture('fmc/cpu.json'), 'CPU', DEVICE_UID);
  const mem = mapFmcFamilyResponse(loadFixture('fmc/mem.json'), 'MEM', DEVICE_UID);
  const iface = mapFmcFamilyResponse(loadFixture('fmc/empty-family.json'), 'INTERFACE', DEVICE_UID);
  const chassis = mapFmcFamilyResponse(
    loadFixture('fmc/empty-family.json'),
    'CHASSIS_STATS',
    DEVICE_UID,
  );

  const merged = mergeFmcFamilies(DEVICE_UID, 'ftd1', [cpu, mem, iface, chassis]);
  assert.ok(merged.snapshot);
  assert.ok(merged.snapshot.cpu);
  assert.ok(merged.snapshot.memory);
  assert.equal(merged.snapshot.interfaces, undefined);
  assert.equal(merged.snapshot.chassis, undefined);
  // The "newest window" claim, actually asserted: cpu.json ends
  // 08:55:36.550, mem.json ends 08:55:36.804 (later) — the merge must take
  // mem's endTime AND mem's own startTime (08:50:36.804), not cpu's paired
  // with mem's end. Pairing a mismatched start/end would misreport the
  // averaging window entirely.
  assert.equal(merged.snapshot.windowEnd?.toISOString(), '2026-07-31T08:55:36.804Z');
  assert.equal(merged.snapshot.windowStart?.toISOString(), '2026-07-31T08:50:36.804Z');
});

test('mergeFmcFamilies: window selection is not positional — reversing family order yields the identical window', () => {
  const cpu = mapFmcFamilyResponse(loadFixture('fmc/cpu.json'), 'CPU', DEVICE_UID);
  const mem = mapFmcFamilyResponse(loadFixture('fmc/mem.json'), 'MEM', DEVICE_UID);
  const forward = mergeFmcFamilies(DEVICE_UID, 'ftd1', [cpu, mem]);
  const reversed = mergeFmcFamilies(DEVICE_UID, 'ftd1', [mem, cpu]);
  assert.equal(
    forward.snapshot?.windowEnd?.toISOString(),
    reversed.snapshot?.windowEnd?.toISOString(),
  );
  assert.equal(
    forward.snapshot?.windowStart?.toISOString(),
    reversed.snapshot?.windowStart?.toISOString(),
  );
});

test('mergeFmcFamilies: all families failed/absent for a device produces no snapshot at all', () => {
  const iface = mapFmcFamilyResponse(loadFixture('fmc/empty-family.json'), 'INTERFACE', DEVICE_UID);
  const chassis = mapFmcFamilyResponse(
    loadFixture('fmc/empty-family.json'),
    'CHASSIS_STATS',
    DEVICE_UID,
  );
  const merged = mergeFmcFamilies(DEVICE_UID, 'ftd1', [iface, chassis]);
  assert.equal(merged.snapshot, undefined);
});

test('fmc/cpu.json, fmc/mem.json, fmc/disk-stats.json merge to the expected exact values', () => {
  const cpu = mapFmcFamilyResponse(loadFixture('fmc/cpu.json'), 'CPU', DEVICE_UID);
  const mem = mapFmcFamilyResponse(loadFixture('fmc/mem.json'), 'MEM', DEVICE_UID);
  const disk = mapFmcFamilyResponse(loadFixture('fmc/disk-stats.json'), 'DISK_STATS', DEVICE_UID);
  const merged = mergeFmcFamilies(DEVICE_UID, 'ftd1', [cpu, mem, disk]);
  assert.ok(merged.snapshot);
  assert.deepEqual(merged.snapshot.cpu, { lina: 0.3, snort: 0.29, system: 19 });
  assert.deepEqual(merged.snapshot.memory, { lina: 71.07, snort: 13.08, system: 51.16 });
  assert.deepEqual(merged.snapshot.disk, { totalUsagePercent: 39 });
});

test('cross-backend equivalence: identical logical device state maps to identical domain groups on both backends', () => {
  // The strongest available proof of DESIGN.md G2: the same logical state,
  // expressed in each backend's own wire vocabulary (SCC's flat multi-
  // family array with `linkStatus`/`operationalStatus`/ISO 8601 vs FMC's
  // items[] wrapper with `currentLinkStatus`/`currentOperationalStatus`/
  // its own timestamp format), must produce the same DeviceHealthSnapshot
  // groups — including interfaces, which is where the two backends'
  // field-name divergence actually lives.
  const fmcMerged = mergeFmcFamilies(DEVICE_UID, 'ftd1', [
    mapFmcFamilyResponse(loadFixture('fmc/cpu.json'), 'CPU', DEVICE_UID),
    mapFmcFamilyResponse(loadFixture('fmc/mem.json'), 'MEM', DEVICE_UID),
    mapFmcFamilyResponse(loadFixture('fmc/disk-stats.json'), 'DISK_STATS', DEVICE_UID),
    mapFmcFamilyResponse(loadFixture('fmc/interface.json'), 'INTERFACE', DEVICE_UID),
  ]).snapshot;

  const sccResult = mapSccResponse([
    {
      deviceUid: DEVICE_UID,
      deviceName: 'ftd1',
      startTime: '2026-07-31T09:57:10.009Z',
      endTime: '2026-07-31T10:57:10.009Z',
      cpuHealthMetrics: { linaUsageAvg: 0.3, snortUsageAvg: 0.29, systemUsageAvg: 19 },
      memoryHealthMetrics: { linaUsageAvg: 71.07, snortUsageAvg: 13.08, systemUsageAvg: 51.16 },
      diskHealthMetrics: { totalDiskUsageAvg: 39 },
      interfaceHealthMetrics: [
        {
          interface: 'GigabitEthernet0/0',
          interfaceName: 'Internet',
          interfaceType: 'GigabitEthernet',
          duplexMode: 'FULL',
          linkStatus: 'UP',
          operationalStatus: 'UP',
          bufferOverrunsAvg: 0,
          bufferUnderrunsAvg: 0,
          dropPacketsAvg: 102813,
          inputBytesAvg: 21474836,
          inputErrorsAvg: 0,
          inputPacketSizeAvg: 46,
          l2DecodeDropsAvg: 0,
          outputBytesAvg: 21474836,
          outputErrorsAvg: 0,
          outputPacketSizeAvg: 52,
        },
      ],
    },
  ]);
  const scc = sccResult.snapshots[0];

  assert.ok(fmcMerged);
  assert.ok(scc);
  assert.deepEqual(fmcMerged.cpu, scc.cpu);
  assert.deepEqual(fmcMerged.memory, scc.memory);
  assert.deepEqual(fmcMerged.disk, scc.disk);
  // The assertion that actually exercises G2 across the interface
  // field-name divergence: two payloads using entirely different wire key
  // names for link/operational status produce the identical domain object.
  assert.deepEqual(
    fmcMerged.interfaces?.find((i) => i.interface === 'GigabitEthernet0/0'),
    scc.interfaces?.[0],
  );
});
