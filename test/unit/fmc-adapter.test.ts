import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createFmcAdapter } from '../../src/backends/fmc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import type { ParseError } from '../../src/domain/diagnostics.ts';
import { isHttpError } from '../../src/http/errors.ts';
import { createLogger } from '../../src/log/logger.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { type FmcMockServer, startFmcMockServer } from './support/fmc-mock-server.ts';

function createTestDispatcher(): Agent {
  return new Agent({ connect: { rejectUnauthorized: false } });
}

/** `buildFmcFilter` (filter.ts) validates device UUIDs against RFC 4122 shape and throws on anything else — test device ids must be well-formed UUIDs, not plain "dev-N" strings, or every aggregatemetrics request throws before it ever reaches the mock server. */
function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

function quietLogger() {
  return createLogger({ level: 'debug', sink: () => {} });
}

function familyResponse(
  deviceId: string,
  deviceName: string,
  family: string,
  metrics: Record<string, unknown>,
) {
  const key =
    family === 'CPU'
      ? 'cpuHealthMetrics'
      : family === 'MEM'
        ? 'memoryHealthMetrics'
        : family === 'DISK_STATS'
          ? 'diskHealthMetrics'
          : family === 'CHASSIS_STATS'
            ? 'chassisStatsHealthMetrics'
            : 'interfaceHealthMetricsList';
  return {
    links: {},
    items: [
      {
        startTime: '2026-07-31 08:50:36.550 UTC',
        endTime: '2026-07-31 08:55:36.550 UTC',
        [key]: metrics,
        name: deviceName,
        id: deviceId,
        type: 'AggregateMetric',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  };
}

function emptyFamilyResponse() {
  return { links: {}, paging: { offset: 0, limit: 0, count: 0, pages: 0 } };
}

function deviceRecords(devices: Array<{ id: string; name: string; isConnected?: boolean }>) {
  return {
    links: {},
    items: devices,
    paging: { offset: 0, limit: 1000, count: devices.length, pages: 1 },
  };
}

interface Harness {
  server: FmcMockServer;
  dispatcher: Agent;
  clock: ReturnType<typeof createFakeClock>;
  /**
   * Closes only the mock server — `adapter.close()` already closes the
   * injected dispatcher (`HttpClient.close()` calls `dispatcher.close()`
   * unconditionally, matching `createSccAdapter`'s own behavior in
   * scc/adapter.ts). Closing the dispatcher a second time here throws
   * `ClientDestroyedError`.
   */
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  return {
    server,
    dispatcher,
    clock,
    close: async () => {
      await server.close();
    },
  };
}

test('FmcAdapter: 4 devices x 5 families produces exactly 20 requests', async () => {
  const h = await createHarness();
  const deviceIds = [deviceUuid(1), deviceUuid(2), deviceUuid(3), deviceUuid(4)];
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords(deviceIds.map((id) => ({ id, name: `${id}-name`, isConnected: true }))),
  );
  for (const id of deviceIds) {
    for (const family of ['CPU', 'MEM', 'DISK_STATS', 'INTERFACE', 'CHASSIS_STATS']) {
      h.server.setAggregateMetrics(
        id,
        family,
        family === 'CPU'
          ? familyResponse(id, `${id}-name`, family, {
              linaUsageAvg: 1,
              snortUsageAvg: 1,
              systemUsageAvg: 1,
            })
          : emptyFamilyResponse(),
      );
    }
  }

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU', 'MEM', 'DISK_STATS', 'INTERFACE', 'CHASSIS_STATS'],
    timeRange: '5m',
    maxConcurrentRequests: 2,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();

    const requestsToAggregate = h.server.requests.filter((r) =>
      r.url.includes('/health/aggregatemetrics'),
    );
    assert.equal(requestsToAggregate.length, 20);
    assert.equal(snapshots.length, 4);
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: concurrency never exceeds the configured cap (timing signal)', async () => {
  const h = await createHarness();
  const deviceIds = Array.from({ length: 6 }, (_, i) => deviceUuid(i + 1));
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords(deviceIds.map((id) => ({ id, name: `${id}-name`, isConnected: true }))),
  );
  h.server.setAggregateMetricsDelay(15);

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 3,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    const start = Date.now();
    await adapter.fetchSnapshot();
    const elapsed = Date.now() - start;
    // 6 requests at 15ms each through a cap of 3 must take at least 2
    // "waves" (>= ~30ms); if the cap were not respected, all 6 would fire
    // concurrently and this would complete in ~15ms.
    assert.ok(elapsed >= 28, `expected at least ~30ms for 2 waves, got ${elapsed}ms`);
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: partial success — one device returns "Device not connected." for all families, other devices still snapshot', async () => {
  const h = await createHarness();
  const deviceIds = [deviceUuid(1), deviceUuid(2), deviceUuid(3), deviceUuid(4)];
  const notConnectedDevice = deviceIds[2] as string;
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords(deviceIds.map((id) => ({ id, name: `${id}-name`, isConnected: true }))),
  );
  const notConnectedEnvelope = {
    error: {
      category: 'FRAMEWORK',
      messages: [{ description: 'Device not connected.' }],
      severity: 'ERROR',
    },
  };
  for (const id of deviceIds) {
    for (const family of ['CPU', 'MEM']) {
      if (id === notConnectedDevice) {
        h.server.setAggregateMetrics(id, family, notConnectedEnvelope);
      } else {
        h.server.setAggregateMetrics(
          id,
          family,
          familyResponse(id, `${id}-name`, family, {
            linaUsageAvg: 1,
            snortUsageAvg: 1,
            systemUsageAvg: 1,
          }),
        );
      }
    }
  }

  const parseErrors: ParseError[] = [];
  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU', 'MEM'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
    onParseError: (e) => parseErrors.push(e),
  });

  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots.length, 3, 'devices_total (3) must differ from devices_discovered (4)');
    assert.ok(!snapshots.some((s) => s.deviceUid === notConnectedDevice));
    assert.ok(parseErrors.some((e) => e.deviceUid === notConnectedDevice));
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: per-family partial — CPU succeeds, INTERFACE returns the empty-result shape, no parse error for the empty family', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id, name: 'ftd1', isConnected: true }]));
  h.server.setAggregateMetrics(
    id,
    'CPU',
    familyResponse(id, 'ftd1', 'CPU', { linaUsageAvg: 5, snortUsageAvg: 2, systemUsageAvg: 10 }),
  );
  h.server.setAggregateMetrics(id, 'INTERFACE', emptyFamilyResponse());

  const parseErrors: ParseError[] = [];
  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU', 'INTERFACE'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
    onParseError: (e) => parseErrors.push(e),
  });

  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0];
    assert.ok(snapshot?.cpu !== undefined);
    assert.equal(snapshot?.interfaces, undefined);
    assert.equal(
      parseErrors.length,
      0,
      'empty INTERFACE family is normal absence, not a parse error',
    );
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: FMC_METRIC_FAMILIES subsetting skips the unrequested family entirely', async () => {
  const h = await createHarness();
  const deviceIds = [deviceUuid(1), deviceUuid(2), deviceUuid(3), deviceUuid(4)];
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords(deviceIds.map((id) => ({ id, name: `${id}-name`, isConnected: true }))),
  );

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU', 'MEM'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    const aggregateRequests = h.server.requests.filter((r) =>
      r.url.includes('/health/aggregatemetrics'),
    );
    assert.equal(aggregateRequests.length, 8, '4 devices x 2 families');
    assert.ok(!aggregateRequests.some((r) => r.url.includes('metric%3ACHASSIS_STATS')));
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: CHASSIS_STATS empty on all devices produces no chassis series and no parse errors/warnings', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id, name: 'ftd1', isConnected: true }]));
  h.server.setAggregateMetrics(
    id,
    'CPU',
    familyResponse(id, 'ftd1', 'CPU', { linaUsageAvg: 5, snortUsageAvg: 2, systemUsageAvg: 10 }),
  );
  h.server.setAggregateMetrics(id, 'CHASSIS_STATS', emptyFamilyResponse());

  const parseErrors: ParseError[] = [];
  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU', 'CHASSIS_STATS'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
    onParseError: (e) => parseErrors.push(e),
  });

  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots[0]?.chassis, undefined);
    assert.equal(parseErrors.length, 0);
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: mid-cycle token expiry triggers exactly one re-auth, the failed request is retried and succeeds, all requests eventually succeed', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id, name: 'ftd1', isConnected: true }]));
  h.server.setAggregateMetrics(
    id,
    'CPU',
    familyResponse(id, 'ftd1', 'CPU', { linaUsageAvg: 5, snortUsageAvg: 2, systemUsageAvg: 10 }),
  );

  let reauths = 0;
  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
    onTokenReauth: () => {
      reauths++;
    },
  });

  try {
    await adapter.init();
    h.server.force401Once(id, 'CPU');
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots.length, 1, 'the retried request must eventually succeed');
    assert.equal(reauths, 1);
    assert.equal(
      h.server.generateTokenCallCount,
      2,
      'init() logs in once, the 401 forces exactly one more',
    );
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: bad credentials mid-cycle (every device/family request 401s) produce exactly one additional generatetoken for the whole fetchSnapshot() cycle, not one per failing request (review finding F1)', async () => {
  const h = await createHarness();
  const deviceIds = Array.from({ length: 10 }, (_, i) => deviceUuid(i + 1));
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords(deviceIds.map((id) => ({ id, name: `${id}-name`, isConnected: true }))),
  );
  const families: Array<'CPU' | 'MEM' | 'DISK_STATS' | 'INTERFACE' | 'CHASSIS_STATS'> = [
    'CPU',
    'MEM',
    'DISK_STATS',
    'INTERFACE',
    'CHASSIS_STATS',
  ];
  for (const id of deviceIds) {
    for (const family of families) {
      h.server.setAggregateMetrics(id, family, {}, 401);
    }
  }

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('now-invalid'),
    metricFamilies: families,
    timeRange: '5m',
    maxConcurrentRequests: 10,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    // init()'s own login must succeed (it happens before credentials go
    // bad in this scenario) — discovery and domain resolution both depend
    // on it. Credentials become bad only starting with the reauth that
    // the first 401'd device request triggers.
    await adapter.init();
    const generateTokenCallsBeforeFetch = h.server.generateTokenCallCount;
    // Enough queued 401s to cover a full hot loop (50 requests) if the fix
    // were absent — proves the assertion below is actually exercising the
    // fix, not just an empty-queue default success masking it.
    for (let i = 0; i < 60; i++) {
      h.server.queueGenerateToken({ statusCode: 401 });
    }
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots.length, 0, 'every device/family request failed, no snapshots');
    assert.equal(
      h.server.generateTokenCallCount - generateTokenCallsBeforeFetch,
      1,
      'exactly one additional generatetoken for the whole fetchSnapshot() cycle, not one per failing request',
    );
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: interface data flows end to end from interfaceHealthMetricsList/currentLinkStatus through to the domain snapshot', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id, name: 'ftd1', isConnected: true }]));
  h.server.setAggregateMetrics(id, 'INTERFACE', {
    links: {},
    items: [
      {
        startTime: '2026-07-31 08:50:36.550 UTC',
        endTime: '2026-07-31 08:55:36.550 UTC',
        interfaceHealthMetricsList: [
          {
            interface: 'GigabitEthernet0/0',
            interfaceName: 'outside',
            currentLinkStatus: 'UP',
            currentOperationalStatus: 'UP',
          },
        ],
        name: 'ftd1',
        id,
        type: 'AggregateMetric',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  });

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['INTERFACE'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    const iface = snapshots[0]?.interfaces?.[0];
    assert.equal(iface?.interface, 'GigabitEthernet0/0');
    assert.equal(iface?.interfaceName, 'outside');
    assert.equal(iface?.linkStatus, 'UP');
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: init() rejects when the very first discovery attempt fails, rather than silently succeeding with a permanently empty device list (review finding F8)', async () => {
  const h = await createHarness();
  // No previous device list exists yet — an array body is valid JSON but
  // not a plain object, so `parseDeviceRecordsPage` throws, which is
  // exactly a "discovery failed" outcome (as opposed to a genuinely empty
  // `{items: []}` response, which is valid and should not throw).
  h.server.setDeviceRecordsPage(0, []);

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await assert.rejects(
      adapter.init(),
      'init() must reject rather than resolve with a permanently empty, unusable adapter',
    );
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: device id "0" is never enqueued for a health request even if present in discovery', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords([
      { id: '0', name: 'the-appliance' },
      { id, name: 'ftd1', isConnected: true },
    ]),
  );
  h.server.setAggregateMetrics(
    id,
    'CPU',
    familyResponse(id, 'ftd1', 'CPU', { linaUsageAvg: 1, snortUsageAvg: 1, systemUsageAvg: 1 }),
  );

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    const aggregateRequests = h.server.requests.filter((r) =>
      r.url.includes('/health/aggregatemetrics'),
    );
    assert.equal(aggregateRequests.length, 1, 'only the real device, never device 0');
    assert.ok(!aggregateRequests.some((r) => r.url.includes('device_uuid%3A0%3B')));
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: discovery does not re-run on every fetchSnapshot() call within the discovery interval', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id, name: 'ftd1', isConnected: true }]));
  h.server.setAggregateMetrics(
    id,
    'CPU',
    familyResponse(id, 'ftd1', 'CPU', { linaUsageAvg: 1, snortUsageAvg: 1, systemUsageAvg: 1 }),
  );

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    for (let i = 0; i < 15; i++) {
      await adapter.fetchSnapshot();
      h.clock.advance(60_000);
    }
    const discoveryRequests = h.server.requests.filter((r) =>
      r.url.includes('/devices/devicerecords'),
    );
    // init() itself triggers one discovery; 15 poll cycles at 60s against
    // a 900s discovery interval should not trigger any further discovery.
    assert.equal(discoveryRequests.length, 1);
  } finally {
    await adapter.close();
    await h.close();
  }
});

// --- Lifecycle guards (mirrors createSccAdapter's F2/F3 review findings) ---

test('FmcAdapter: fetchSnapshot() before init() rejects with a classified fatal_config HttpError, not a bare Error', async () => {
  const adapter = createFmcAdapter({
    host: 'example.invalid',
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: createFakeClock(),
    logger: quietLogger(),
  });
  await assert.rejects(adapter.fetchSnapshot(), (err: unknown) => {
    assert.ok(isHttpError(err));
    assert.equal(err.class, 'fatal_config');
    return true;
  });
});

test('FmcAdapter: a second init() call rejects with a classified fatal_config HttpError instead of silently orphaning the first token manager/dispatcher', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id, name: 'ftd1', isConnected: true }]));
  h.server.setAggregateMetrics(
    id,
    'CPU',
    familyResponse(id, 'ftd1', 'CPU', { linaUsageAvg: 1, snortUsageAvg: 1, systemUsageAvg: 1 }),
  );

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    await assert.rejects(adapter.init(), (err: unknown) => {
      assert.ok(isHttpError(err));
      assert.equal(err.class, 'fatal_config');
      return true;
    });
    // The first (only) token manager/dispatcher must still be in use — a
    // single fetchSnapshot() still succeeds through it.
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots.length, 1);
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter: close() is idempotent — a second close() does not throw', async () => {
  const h = await createHarness();
  const id = deviceUuid(1);
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id, name: 'ftd1', isConnected: true }]));
  h.server.setAggregateMetrics(
    id,
    'CPU',
    familyResponse(id, 'ftd1', 'CPU', { linaUsageAvg: 1, snortUsageAvg: 1, systemUsageAvg: 1 }),
  );

  const adapter = createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
  });

  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    await adapter.close();
    await assert.doesNotReject(adapter.close());
  } finally {
    await h.close();
  }
});
