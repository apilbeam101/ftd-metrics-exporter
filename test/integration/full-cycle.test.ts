import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { createFmcAdapter } from '../../src/backends/fmc/adapter.ts';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { parseExposition } from '../unit/support/exposition.ts';
import { startFmcMockServer } from '../unit/support/fmc-mock-server.ts';
import { startTestHttpServer } from '../unit/support/http-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * IMPLEMENTATION_PLAN.md Stage 12, DESIGN.md §12.2 testing steps 1-3:
 * the full assembled poll-cache-serve stack (registry, self-metrics, device
 * metrics, cache, poller, HTTP server) driven by a real backend adapter
 * against a local mock upstream — not the adapter or the server in
 * isolation, which the Stage 7/8/9/10 unit suites already cover
 * exhaustively.
 */

function loadFixtureText(relativePath: string): string {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return readFileSync(`${fixturesDir}/${relativePath}`, 'utf8');
}

function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

function fmcFamilyResponse(deviceId: string, deviceName: string, metrics: Record<string, unknown>) {
  return {
    links: {},
    items: [
      {
        startTime: '2026-07-31 08:50:36.550 UTC',
        endTime: '2026-07-31 08:55:36.550 UTC',
        cpuHealthMetrics: metrics,
        name: deviceName,
        id: deviceId,
        type: 'AggregateMetric',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  };
}

function fmcDeviceRecords(devices: Array<{ id: string; name: string }>) {
  return {
    links: {},
    items: devices.map((d) => ({ ...d, isConnected: true })),
    paging: { offset: 0, limit: 1000, count: devices.length, pages: 1 },
  };
}

// --- Testing step 1: full poll-cache-serve cycle, SCC ---

test('SCC: a full poll-cache-serve cycle populates the cache and /metrics reflects the fixture data', async () => {
  const body = loadFixtureText('scc/full-live.json');
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const metrics = createTestMetrics(createRealClock());
  const backend = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret('a-realistic-looking-scc-token'),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createRealClock(),
    logger: (await import('../../src/log/logger.ts')).createLogger({
      level: 'error',
      sink: () => {},
    }),
    minSpacingMs: 0,
    dispatcher: new Agent({ connect: { rejectUnauthorized: true } }),
    onParseError: (e) => {
      metrics.parseErrorTracker.record();
      metrics.recorder.onParseError(e);
    },
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1);
    const res = await app.scrape();
    assert.equal(res.statusCode, 200);
    const families = parseExposition(res.body);
    assert.ok(families.length > 0);

    const cpuFamily = families.find((f) => f.name === 'ftd_cpu_usage_ratio');
    const linaSample = cpuFamily?.samples.find(
      (s) =>
        s.labels.device_uid === '00000000-0000-4000-8000-000000000001' &&
        s.labels.component === 'lina',
    );
    assert.equal(linaSample?.value, 0.041811);

    const upSample = families.find((f) => f.name === 'ftd_exporter_up')?.samples.find(() => true);
    assert.equal(upSample?.value, 1);

    assert.equal(server.requests.length, 1, 'exactly one upstream request for one poll cycle');
  } finally {
    await app.stop();
    await server.close();
  }
});

// --- Testing step 2: full cycle, FMC (token acquisition -> discovery -> fan-out -> merged snapshot -> scrape) ---

test('FMC: token acquisition, discovery, N-device fan-out, and a merged snapshot all reach /metrics', async () => {
  const h = await startFmcMockServer();
  const deviceIds = [deviceUuid(1), deviceUuid(2), deviceUuid(3)];
  h.setDeviceRecordsPage(0, fmcDeviceRecords(deviceIds.map((id) => ({ id, name: `${id}-name` }))));
  for (const id of deviceIds) {
    h.setAggregateMetrics(
      id,
      'CPU',
      fmcFamilyResponse(id, `${id}-name`, {
        linaUsageAvg: 5,
        snortUsageAvg: 2,
        systemUsageAvg: 10,
      }),
    );
  }

  const metrics = createTestMetrics(createRealClock());
  const backend = createFmcAdapter({
    host: h.host,
    username: 'svc',
    password: new Secret('a-realistic-looking-password'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: createRealClock(),
    logger: (await import('../../src/log/logger.ts')).createLogger({
      level: 'error',
      sink: () => {},
    }),
    tlsInsecureSkipVerify: true,
    onParseError: (e) => {
      metrics.parseErrorTracker.record();
      metrics.recorder.onParseError(e);
    },
    onDiscoverySuccess: metrics.recorder.onDiscoverySuccess,
    onDiscoveryFailure: metrics.recorder.onDiscoveryFailure,
    onTokenRefresh: metrics.recorder.onTokenRefresh,
    onTokenReauth: metrics.recorder.onTokenReauth,
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1);
    assert.ok(
      h.generateTokenCallCount >= 1,
      'expected at least one generatetoken call during init()',
    );

    const res = await app.scrape();
    assert.equal(res.statusCode, 200);
    // Throws on any malformed HELP/TYPE ordering, label escaping, or
    // numeric formatting — parseability is proven simply by not throwing.
    const families = parseExposition(res.body);

    const cpuFamily = families.find((f) => f.name === 'ftd_cpu_usage_ratio');
    assert.equal(cpuFamily?.samples.length, deviceIds.length * 3, '3 devices x 3 components');

    const devicesSample = families.find((f) => f.name === 'ftd_exporter_devices')?.samples[0];
    assert.equal(devicesSample?.value, 3);
  } finally {
    await app.stop();
    await h.close();
  }
});
