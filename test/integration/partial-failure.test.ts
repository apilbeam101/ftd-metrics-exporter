import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFmcAdapter } from '../../src/backends/fmc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startFmcMockServer } from '../unit/support/fmc-mock-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * DESIGN.md §12.2 testing step 8, at process level: 48 of 50 devices succeed
 * -> 48 devices' series present, `ftd_exporter_devices` = 48,
 * `ftd_exporter_devices_discovered` = 50. Distinguishing these two gauges is
 * the whole point of the scenario (DESIGN.md §14 troubleshooting item 7).
 */

function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
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

test('partial device failure: 48 of 50 devices succeed — 48 device series, devices=48, devices_discovered=50', async () => {
  const h = await startFmcMockServer();
  const allIds = Array.from({ length: 50 }, (_, i) => deviceUuid(i + 1));
  const failingIds = new Set([allIds[10] as string, allIds[30] as string]);

  h.setDeviceRecordsPage(0, {
    links: {},
    items: allIds.map((id) => ({ id, name: `ftd-${id}`, isConnected: true })),
    paging: { offset: 0, limit: 1000, count: 50, pages: 1 },
  });
  for (const id of allIds) {
    if (failingIds.has(id)) {
      h.setAggregateMetrics(id, 'CPU', {
        error: { category: 'FRAMEWORK', messages: [{ description: 'Device not connected.' }] },
      });
    } else {
      h.setAggregateMetrics(id, 'CPU', cpuResponse(id, `ftd-${id}`));
    }
  }

  const metrics = createTestMetrics(createRealClock());
  const parseErrors: unknown[] = [];
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
    onParseError: (e) => {
      parseErrors.push(e);
      metrics.recorder.onParseError(e);
    },
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1, 15_000);
    assert.equal(
      app.results[0]?.outcome,
      'success',
      'partial success is still success (DESIGN.md §2.5)',
    );
    assert.equal(app.results[0]?.deviceCount, 48);

    const res = await app.scrape();
    const cpuSamples = res.body
      .split('\n')
      .filter(
        (line) => line.startsWith('ftd_cpu_usage_ratio{') && line.includes('component="lina"'),
      );
    assert.equal(cpuSamples.length, 48);

    assert.match(res.body, /ftd_exporter_devices 48/);
    assert.match(res.body, /ftd_exporter_devices_discovered 50/);

    for (const failingId of failingIds) {
      assert.ok(
        !res.body.includes(`device_uid="${failingId}"`),
        `failing device ${failingId} must not appear as an empty-shell series`,
      );
    }
    assert.ok(parseErrors.length >= 2, 'each failing device/family should record a parse error');
  } finally {
    await app.stop();
    await h.close();
  }
});
