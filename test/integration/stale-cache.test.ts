import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startTestHttpServer } from '../unit/support/http-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * DESIGN.md §12.2 testing step 6 / §2.2's core guarantee, at process level:
 * an upstream failure must serve the last-good cache with
 * `ftd_exporter_up 0`, not go stale-and-silent or empty the cache.
 */

function loadFixtureText(relativePath: string): string {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return readFileSync(`${fixturesDir}/${relativePath}`, 'utf8');
}

test('upstream failure after a successful poll: /metrics keeps serving the last-good snapshot with ftd_exporter_up=0', async () => {
  const body = loadFixtureText('scc/full-live.json');
  let shouldFail = false;
  const server = await startTestHttpServer((_req, res) => {
    if (shouldFail) {
      res.writeHead(500);
      res.end();
      return;
    }
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
    logger: createLogger({ level: 'error', sink: () => {} }),
    minSpacingMs: 0,
    dispatcher: new Agent({ connect: { rejectUnauthorized: true } }),
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1);
    assert.equal(app.results[0]?.outcome, 'success');
    const firstScrape = await app.scrape();
    assert.match(firstScrape.body, /ftd_exporter_up 1/);
    assert.match(firstScrape.body, /device_uid="00000000-0000-4000-8000-000000000001"/);

    shouldFail = true;
    await app.waitForCycles(3);
    assert.equal(app.results[1]?.outcome, 'failure');
    assert.equal(app.results[2]?.outcome, 'failure');

    const staleScrape = await app.scrape();
    assert.match(staleScrape.body, /ftd_exporter_up 0/);
    assert.match(
      staleScrape.body,
      /device_uid="00000000-0000-4000-8000-000000000001"/,
      'the stale device data from the last successful poll must still be served',
    );

    const cacheAgeFamily = staleScrape.body.match(/ftd_exporter_cache_age_seconds ([\d.]+)/);
    assert.ok(cacheAgeFamily, 'cache_age_seconds must be present');
    assert.ok(
      Number(cacheAgeFamily?.[1]) > 0,
      'cache age must be growing while upstream keeps failing',
    );
  } finally {
    await app.stop();
    await server.close();
  }
});
