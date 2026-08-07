import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFmcAdapter } from '../../src/backends/fmc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startFmcMockServer } from '../unit/support/fmc-mock-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * DESIGN.md §12.2 testing step 7, at process level: FMC pagination across
 * multiple pages, including the >25-device case a naive single-request
 * implementation truncates. `fmc-discovery.test.ts` already proves
 * `fetchAllDeviceRecords` itself paginates correctly in isolation; this
 * proves the *whole stack* (adapter -> discovery -> poller -> collector ->
 * /metrics) reflects all 40 devices, not just page one.
 */

function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

function devicePage(offset: number, limit: number, totalCount: number, ids: string[]) {
  return {
    links: {},
    items: ids.map((id, i) => ({ id, name: `ftd-${offset + i}`, isConnected: true })),
    paging: { offset, limit, count: totalCount, pages: Math.ceil(totalCount / limit) },
  };
}

function cpuResponse(id: string, name: string) {
  return {
    links: {},
    items: [
      {
        startTime: '2026-07-31 08:50:36.550 UTC',
        endTime: '2026-07-31 08:55:36.550 UTC',
        cpuHealthMetrics: { linaUsageAvg: 1, snortUsageAvg: 1, systemUsageAvg: 1 },
        name,
        id,
        type: 'AggregateMetric',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  };
}

test('FMC pagination: 40 devices across two 25-item pages all reach /metrics — a single-page implementation would show only 25', async () => {
  const h = await startFmcMockServer();
  const allIds = Array.from({ length: 40 }, (_, i) => deviceUuid(i + 1));

  h.setDeviceRecordsPage(0, devicePage(0, 25, 40, allIds.slice(0, 25)));
  h.setDeviceRecordsPage(25, devicePage(25, 25, 40, allIds.slice(25, 40)));
  for (const id of allIds) {
    h.setAggregateMetrics(id, 'CPU', cpuResponse(id, `ftd-${id}`));
  }

  const metrics = createTestMetrics(createRealClock());
  const backend = createFmcAdapter({
    host: h.host,
    username: 'svc',
    password: new Secret('a-realistic-looking-password'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 10,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: createRealClock(),
    logger: createLogger({ level: 'error', sink: () => {} }),
    tlsInsecureSkipVerify: true,
    onDiscoverySuccess: metrics.recorder.onDiscoverySuccess,
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1, 15_000);
    assert.equal(app.results[0]?.outcome, 'success');

    const res = await app.scrape();
    const cpuSamples = res.body
      .split('\n')
      .filter(
        (line) => line.startsWith('ftd_cpu_usage_ratio{') && line.includes('component="lina"'),
      );
    assert.equal(cpuSamples.length, 40, 'all 40 devices across both pages must render series');

    assert.match(res.body, /ftd_exporter_devices_discovered 40/);
    assert.match(res.body, /ftd_exporter_devices 40/);

    const discoveryRequests = h.requests.filter((r) => r.url.includes('/devices/devicerecords'));
    assert.equal(discoveryRequests.length, 2, 'exactly two devicerecords pages');
  } finally {
    await app.stop();
    await h.close();
  }
});
