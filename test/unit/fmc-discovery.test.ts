import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createFmcDiscovery, fetchAllDeviceRecords } from '../../src/backends/fmc/discovery.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { startFmcMockServer } from './support/fmc-mock-server.ts';

const DOMAIN_UUID = '00000000-0000-4000-8000-000000000002';

function createTestDispatcher(): Agent {
  return new Agent({ connect: { rejectUnauthorized: false } });
}

function deviceRecordsPage(
  offset: number,
  limit: number,
  totalCount: number,
  items: Array<{ id: string; name: string; isConnected?: boolean }>,
) {
  return {
    links: { self: `https://fmc.example.internal/...?offset=${offset}&limit=${limit}` },
    items,
    paging: { offset, limit, count: totalCount, pages: Math.ceil(totalCount / limit) },
  };
}

test('fetchAllDeviceRecords: a single page of 4 devices returns all 4', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  server.setDeviceRecordsPage(
    0,
    deviceRecordsPage(0, 1000, 4, [
      { id: 'dev-1', name: 'ftd1', isConnected: true },
      { id: 'dev-2', name: 'ftd2', isConnected: true },
      { id: 'dev-3', name: 'ftd3', isConnected: false },
      { id: 'dev-4', name: 'ftd4', isConnected: true },
    ]),
  );
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    assert.equal(devices.length, 4);
    assert.deepEqual(
      devices.map((d) => d.id),
      ['dev-1', 'dev-2', 'dev-3', 'dev-4'],
    );
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: 40 devices across two 25-item pages are all discovered (the >25 truncation case)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();

  const allDevices = Array.from({ length: 40 }, (_, i) => ({
    id: `dev-${i}`,
    name: `ftd-${i}`,
  }));
  // The real implementation requests limit=1000, but the server can return
  // a short page whenever it wants (no paging headers on the real FMC) —
  // simulate a server that pages at 25 regardless of the requested limit,
  // matching DESIGN.md §3.3.3's documented default page size.
  server.setDeviceRecordsPage(0, deviceRecordsPage(0, 25, 40, allDevices.slice(0, 25)));
  server.setDeviceRecordsPage(25, deviceRecordsPage(25, 25, 40, allDevices.slice(25, 40)));

  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    assert.equal(devices.length, 40, 'a single-request implementation would see only 25');
    assert.deepEqual(devices.map((d) => d.id).sort(), allDevices.map((d) => d.id).sort());
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: an exactly-limit-sized final page requires one further (empty) request to terminate, not a hang or double-count', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();

  // Page at offset 0 returns exactly 1000 items, same as PAGE_LIMIT — the
  // implementation must issue a *third* request at offset 1000 and see it
  // come back short (empty) before it can conclude discovery is done.
  const fullPage = Array.from({ length: 1000 }, (_, i) => ({ id: `dev-${i}`, name: `ftd-${i}` }));
  server.setDeviceRecordsPage(0, deviceRecordsPage(0, 1000, 1000, fullPage));
  server.setDeviceRecordsPage(1000, deviceRecordsPage(1000, 1000, 1000, []));

  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    assert.equal(devices.length, 1000);
    const requestsToDeviceRecords = server.requests.filter((r) =>
      r.url.includes('/devices/devicerecords'),
    );
    assert.equal(requestsToDeviceRecords.length, 2, 'must issue the trailing empty-page request');
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: a page-count sanity cap aborts with an error rather than looping forever', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();

  // Every page the misbehaving server returns is a full page (1000 items),
  // so the offset loop never sees a short page and must be bounded by
  // maxPages instead.
  const makeFullPage = (offset: number) =>
    deviceRecordsPage(
      offset,
      1000,
      1_000_000,
      Array.from({ length: 1000 }, (_, i) => ({
        id: `dev-${offset + i}`,
        name: `ftd-${offset + i}`,
      })),
    );
  for (let offset = 0; offset < 5000; offset += 1000) {
    server.setDeviceRecordsPage(offset, makeFullPage(offset));
  }

  try {
    await assert.rejects(
      fetchAllDeviceRecords({
        dispatcher,
        host: server.host,
        domainUuid: DOMAIN_UUID,
        accessToken: 'tok',
        clock: createFakeClock(),
        maxPages: 3,
      }),
      /aborted after 3 pages/,
    );
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: a device with id "0" (the FMC appliance itself) is never enqueued', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  server.setDeviceRecordsPage(
    0,
    deviceRecordsPage(0, 1000, 2, [
      { id: '0', name: 'the-fmc-appliance-itself' },
      { id: 'dev-1', name: 'ftd1' },
    ]),
  );
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.id, 'dev-1');
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: expanded=true is present on every page request', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  server.setDeviceRecordsPage(0, deviceRecordsPage(0, 1000, 0, []));
  try {
    await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    const request = server.requests.find((r) => r.url.includes('/devices/devicerecords'));
    assert.ok(request?.url.includes('expanded=true'));
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('createFmcDiscovery: a discovery failure after a prior success reuses the previous device list and reports failure', async () => {
  const clock = createFakeClock();
  let succeedNext = true;
  let failures = 0;
  const successes: number[] = [];
  const discovery = createFmcDiscovery({
    clock,
    intervalMs: 900_000,
    fetchDevices: async () => {
      if (succeedNext) {
        return [{ id: 'dev-1', name: 'ftd1' }];
      }
      throw new Error('simulated discovery failure');
    },
    onDiscoverySuccess: (count) => successes.push(count),
    onDiscoveryFailure: () => {
      failures++;
    },
  });

  const first = await discovery.getDevices();
  assert.equal(first.length, 1);
  assert.deepEqual(successes, [1]);

  succeedNext = false;
  clock.advance(900_001);
  const second = await discovery.getDevices();
  assert.deepEqual(second, first, 'must reuse the previous device list on failure');
  assert.equal(failures, 1);
});

test('createFmcDiscovery: cadence — 15 poll cycles at a 900s discovery interval and 60s poll interval trigger exactly one discovery', async () => {
  const clock = createFakeClock();
  let discoveryCalls = 0;
  const discovery = createFmcDiscovery({
    clock,
    intervalMs: 900_000,
    fetchDevices: async () => {
      discoveryCalls++;
      return [{ id: 'dev-1', name: 'ftd1' }];
    },
  });

  for (let cycle = 0; cycle < 15; cycle++) {
    await discovery.getDevices();
    clock.advance(60_000);
  }
  assert.equal(discoveryCalls, 1);
});

test('fetchAllDeviceRecords: paging.limit: 0 on an empty first page terminates immediately with 0 devices and exactly 1 request (review finding F3)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  server.setDeviceRecordsPage(0, { links: {}, items: [], paging: { limit: 0, count: 0 } });
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
      maxPages: 5,
    });
    assert.equal(devices.length, 0);
    const requestsToDeviceRecords = server.requests.filter((r) =>
      r.url.includes('/devices/devicerecords'),
    );
    assert.equal(
      requestsToDeviceRecords.length,
      1,
      'must not spin through maxPages re-requesting the same offset',
    );
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: a server that echoes back the requested limit but only honors its own internal page size continues pagination via paging.count, not silently truncating (review finding F4)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const allDevices = Array.from({ length: 40 }, (_, i) => ({ id: `dev-${i}`, name: `ftd-${i}` }));
  // Page 1: server actually returns 25 items but echoes back limit:1000
  // (the requested limit, not the 25 it actually honored) and count:40.
  server.setDeviceRecordsPage(0, {
    links: {},
    items: allDevices.slice(0, 25),
    paging: { offset: 0, limit: 1000, count: 40 },
  });
  server.setDeviceRecordsPage(25, {
    links: {},
    items: allDevices.slice(25, 40),
    paging: { offset: 25, limit: 1000, count: 40 },
  });
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    assert.equal(devices.length, 40, 'a naive limit-echo-trusting implementation would see 25');
    assert.deepEqual(devices.map((d) => d.id).sort(), allDevices.map((d) => d.id).sort());
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: a genuine truncation anomaly (pagination ends short of paging.count) fires a warning rather than failing silently (review finding F4)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  // Server reports count:40 but only ever serves 25 items, then a
  // genuinely empty page — there is nothing more this client can safely
  // do except surface the discrepancy.
  const allDevices = Array.from({ length: 25 }, (_, i) => ({ id: `dev-${i}`, name: `ftd-${i}` }));
  server.setDeviceRecordsPage(0, {
    links: {},
    items: allDevices,
    paging: { offset: 0, limit: 1000, count: 40 },
  });
  server.setDeviceRecordsPage(25, {
    links: {},
    items: [],
    paging: { offset: 25, limit: 1000, count: 40 },
  });
  const warnings: string[] = [];
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(devices.length, 25);
    assert.ok(
      warnings.some((w) => w.includes('40') && w.includes('25')),
      'a warning must fire making the truncation visible rather than silently returning a partial list',
    );
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: one malformed device record (non-string id) is skipped, the valid device on the same page is still returned (review finding F6)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  server.setDeviceRecordsPage(0, {
    links: {},
    items: [
      { id: 0, name: 'weird-numeric-id' },
      { id: 'dev-1', name: 'ftd1' },
    ],
    paging: { offset: 0, limit: 1000, count: 2 },
  });
  const warnings: string[] = [];
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(devices.length, 1, 'the malformed record must not destroy the valid one');
    assert.equal(devices[0]?.id, 'dev-1');
    assert.ok(warnings.length > 0, 'a diagnostic must fire for the skipped malformed record');
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: a device with an empty name falls back to its id rather than reaching the caller as an empty deviceName (review finding F7)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  server.setDeviceRecordsPage(0, {
    links: {},
    items: [{ id: 'dev-1', name: '' }],
    paging: { offset: 0, limit: 1000, count: 1 },
  });
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    assert.equal(devices.length, 1);
    assert.notEqual(devices[0]?.name, '');
    assert.equal(devices[0]?.name, 'dev-1');
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('fetchAllDeviceRecords: a device with id " 0" (whitespace-padded appliance id) is excluded exactly like "0" (review finding F9)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  server.setDeviceRecordsPage(0, {
    links: {},
    items: [
      { id: ' 0', name: 'the-fmc-appliance-itself-padded' },
      { id: 'dev-1', name: 'ftd1' },
    ],
    paging: { offset: 0, limit: 1000, count: 2 },
  });
  try {
    const devices = await fetchAllDeviceRecords({
      dispatcher,
      host: server.host,
      domainUuid: DOMAIN_UUID,
      accessToken: 'tok',
      clock: createFakeClock(),
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.id, 'dev-1');
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('createFmcDiscovery: single-flight — concurrent getDevices() calls during one discovery produce exactly one fetch', async () => {
  const clock = createFakeClock();
  let discoveryCalls = 0;
  let resolveFetch: ((devices: Array<{ id: string; name: string }>) => void) | undefined;
  const discovery = createFmcDiscovery({
    clock,
    intervalMs: 900_000,
    fetchDevices: () => {
      discoveryCalls++;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });

  const calls = Array.from({ length: 5 }, () => discovery.getDevices());
  await new Promise((resolve) => setTimeout(resolve, 5));
  resolveFetch?.([{ id: 'dev-1', name: 'ftd1' }]);
  const results = await Promise.all(calls);
  assert.equal(discoveryCalls, 1);
  assert.ok(results.every((r) => r.length === 1));
});
