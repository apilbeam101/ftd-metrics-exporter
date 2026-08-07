import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startTestHttpServer } from '../unit/support/http-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * DESIGN.md §12.2's explicitly-called-out separate test: poll a snapshot
 * containing device B, then one without it, and assert B's series are gone
 * from /metrics. Called out separately from the unit-level
 * collector.test.ts equivalent because the whole-process path (cache swap +
 * collector + registry, driven by a real poller and a real HTTP scrape) is
 * where this actually breaks, not the pure renderer in isolation.
 */

function deviceBody(includeB: boolean): string {
  const deviceA = {
    deviceUid: 'device-a',
    deviceName: 'ftd-a',
    cpuHealthMetrics: { linaUsageAvg: 1, snortUsageAvg: 1, systemUsageAvg: 1 },
  };
  const deviceB = {
    deviceUid: 'device-b',
    deviceName: 'ftd-b',
    cpuHealthMetrics: { linaUsageAvg: 2, snortUsageAvg: 2, systemUsageAvg: 2 },
  };
  return JSON.stringify(includeB ? [deviceA, deviceB] : [deviceA]);
}

test('series disappearance at process level: device B present in poll 1, absent in poll 2 — its series vanish from /metrics', async () => {
  let includeB = true;
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(deviceBody(includeB));
  });
  const metrics = createTestMetrics(createRealClock());
  const backend = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret('a-realistic-looking-scc-token'),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createRealClock(),
    logger: createLogger({ level: 'error', sink: () => {} }),
    minSpacingMs: 0,
    dispatcher: new Agent({ connect: { rejectUnauthorized: true } }),
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1);
    const withBoth = await app.scrape();
    assert.match(withBoth.body, /device_uid="device-a"/);
    assert.match(withBoth.body, /device_uid="device-b"/);

    includeB = false;
    await app.waitForCycles(2);
    const withOnlyA = await app.scrape();
    assert.match(withOnlyA.body, /device_uid="device-a"/);
    assert.doesNotMatch(
      withOnlyA.body,
      /device_uid="device-b"/,
      'device-b must be fully absent, not lingering with a stale/zero value',
    );
  } finally {
    await app.stop();
    await server.close();
  }
});
