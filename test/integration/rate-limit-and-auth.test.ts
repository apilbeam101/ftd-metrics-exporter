import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createFmcAdapter } from '../../src/backends/fmc/adapter.ts';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startFmcMockServer } from '../unit/support/fmc-mock-server.ts';
import { startTestHttpServer } from '../unit/support/http-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/** DESIGN.md §12.2 testing steps 4-5, process-level. */

function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

// --- Testing step 4: 429 with Retry-After -> honored delay, rate_limited reason ---

test('429 handling: a 429 with Retry-After is retried per policy — the delay is actually honored — and, once exhausted, surfaces as poll_errors_total{reason="rate_limited"}', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    // A non-zero Retry-After is required to distinguish "the client honored
    // the header" from "the client always waits at least this long anyway"
    // — DESIGN.md §12.2 step 4 asks for the honored delay specifically, not
    // just the eventual rate_limited classification.
    res.writeHead(429, { 'Retry-After': '1' });
    res.end();
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

  // Generous enough that a single poll cycle (which must wait out 2
  // honored 1s Retry-After delays between its 3 attempts) fits comfortably
  // inside it, without racing a second cycle starting.
  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 10 });
  const startedAtMs = Date.now();
  try {
    await app.waitForCycles(1, 15_000);
    const elapsedMs = Date.now() - startedAtMs;
    assert.equal(app.results[0]?.outcome, 'failure');
    assert.equal(app.results[0]?.reason, 'rate_limited');
    assert.equal(hitCount, 3, 'the retry budget (3 attempts) must be exhausted before surfacing');
    // 2 retries, each honoring a 1s Retry-After -- an ordering/lower-bound
    // assertion with a generous margin (DESIGN.md §12.2's own risk note:
    // "assert ordering rather than exact durations"), not an exact-timing
    // assertion that would flake under load.
    assert.ok(
      elapsedMs >= 1_800,
      `expected the cycle to take >= ~2 honored 1s Retry-After delays, took ${elapsedMs}ms`,
    );

    const res = await app.scrape();
    assert.match(res.body, /ftd_exporter_poll_errors_total\{reason="rate_limited"\} 1/);
    assert.match(res.body, /ftd_exporter_up 0/);
  } finally {
    await app.stop();
    await server.close();
  }
});

// --- Testing step 5: a mid-cycle 401 on FMC triggers exactly one re-auth and the cycle still completes ---

test('401 handling: FMC token invalidated mid-cycle triggers exactly one re-auth, and the poll cycle still completes successfully', async () => {
  const h = await startFmcMockServer();
  const id = deviceUuid(1);
  h.setDeviceRecordsPage(0, {
    links: {},
    items: [{ id, name: 'ftd1', isConnected: true }],
    paging: { offset: 0, limit: 1000, count: 1, pages: 1 },
  });
  h.setAggregateMetrics(id, 'CPU', {
    links: {},
    items: [
      {
        startTime: '2026-07-31 08:50:36.550 UTC',
        endTime: '2026-07-31 08:55:36.550 UTC',
        cpuHealthMetrics: { linaUsageAvg: 5, snortUsageAvg: 2, systemUsageAvg: 10 },
        name: 'ftd1',
        id,
        type: 'AggregateMetric',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  });

  const metrics = createTestMetrics(createRealClock());
  let reauths = 0;
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
    logger: createLogger({ level: 'error', sink: () => {} }),
    tlsInsecureSkipVerify: true,
    onTokenReauth: () => {
      reauths++;
    },
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1);
    assert.equal(app.results[0]?.outcome, 'success');

    // Invalidate the currently-held token for exactly the next aggregatemetrics call.
    h.force401Once(id, 'CPU');
    await app.waitForCycles(2);
    assert.equal(app.results[1]?.outcome, 'success', 'the cycle must still complete after re-auth');
    assert.equal(reauths, 1, 'exactly one re-auth for the single 401');

    const res = await app.scrape();
    assert.match(res.body, /ftd_cpu_usage_ratio\{[^}]*component="lina"[^}]*\}/);
  } finally {
    await app.stop();
    await h.close();
  }
});
