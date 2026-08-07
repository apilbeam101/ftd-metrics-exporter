import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gauge } from 'prom-client';
import { Agent } from 'undici';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startTestHttpServer } from '../unit/support/http-server.ts';
import { createTestApp, createTestMetrics, waitFor } from './support/harness.ts';

/**
 * DESIGN.md §12.2 testing step 11, at process level: concurrent scrapes
 * during a slow in-flight poll must all see consistent (byte-identical to
 * each other) cached output, and a scrape never triggers its own upstream
 * call (DESIGN.md §2.2's poll-cache-serve contract).
 *
 * Two things a first draft of this test got wrong, both caught by an
 * adversarial review:
 *
 * (1) Scraping *before* the first cycle ever completes means every scrape
 *     renders an empty cache — 10 identical empty bodies "pass" the
 *     byte-identical assertion for a reason that has nothing to do with
 *     the poll-cache-serve contract (verified: disabling `routes.ts`'s
 *     single-flight render guard entirely still left that version green).
 *     This version waits for cycle 1 to populate the cache with real
 *     device data, then scrapes concurrently while cycle 2's fetch is
 *     genuinely in flight (detected via the mock server's own request
 *     count, not a guessed delay), so the shared body is asserted to
 *     contain a real device series, not just "the same empty thing".
 * (2) `routes.ts`'s single-flight render guard only has a real yield
 *     point to interleave at when some gauge on the registry has an async
 *     `collect()` hook — with none, disabling the guard has no observable
 *     effect either way. The `zzz_render_delay` gauge below (the same
 *     technique `server.test.ts`'s "Finding 4" test and
 *     `graceful-shutdown.test.ts` use) gives concurrent `/metrics`
 *     requests a genuine window to interleave in if that guard were
 *     removed.
 */

function loadFixtureText(relativePath: string): string {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return readFileSync(`${fixturesDir}/${relativePath}`, 'utf8');
}

test('concurrent scrapes during a slow in-flight poll: consistent, non-empty output, and a scrape never triggers its own upstream request', async () => {
  const body = loadFixtureText('scc/full-live.json');
  let requestCount = 0;
  let delayMs = 0;
  const server = await startTestHttpServer((_req, res) => {
    requestCount++;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    }, delayMs);
  });
  const metrics = createTestMetrics(createRealClock());
  new Gauge({
    name: 'zzz_render_delay',
    help: 'test-only: gives concurrent /metrics requests a real yield point to interleave at if the single-flight render guard were removed',
    registers: [metrics.registry],
    async collect() {
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
  });
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

  // A short interval so cycle 2 starts promptly after cycle 1 completes.
  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1);
    assert.equal(requestCount, 1);

    // Make cycle 2's fetch slow, then wait for the mock server to actually
    // receive that second request (not a guessed delay) before scraping —
    // at that point cycle 2's response is deliberately parked for 150ms,
    // so the cache still holds cycle 1's real data and every concurrent
    // scrape below is guaranteed to land during that genuine in-flight
    // window, not before or after it.
    delayMs = 150;
    const cycle2 = app.waitForCycles(2);
    await waitFor(() => requestCount === 2);

    const scrapesDuringPoll = await Promise.all(Array.from({ length: 10 }, () => app.scrape()));
    for (const res of scrapesDuringPoll) {
      assert.equal(res.statusCode, 200);
      assert.match(
        res.body,
        /device_uid="00000000-0000-4000-8000-000000000001"/,
        'a concurrent scrape during an in-flight poll must render real cached device data, not an empty snapshot',
      );
    }
    const bodies = new Set(scrapesDuringPoll.map((r) => r.body));
    assert.equal(
      bodies.size,
      1,
      'all concurrent scrapes during the same in-flight poll must see identical, non-empty output',
    );

    await cycle2;
    assert.equal(
      requestCount,
      2,
      'concurrent scrapes must never themselves trigger an upstream request — only the 2 real poll cycles should',
    );
  } finally {
    await app.stop();
    await server.close();
  }
});
