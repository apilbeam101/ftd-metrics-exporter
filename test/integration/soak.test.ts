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
 * DESIGN.md §12.2 testing step 13: a short-in-CI soak — 100 poll cycles —
 * asserting series count stays stable and heap usage does not grow
 * unbounded (`nodejs_heap_size_used_bytes` from `collectDefaultMetrics`,
 * per the plan's explicit suggestion). This is not a proof of no leak over
 * a real production lifetime — only that 100 cycles of reset-then-
 * repopulate against one fixed-size fleet don't visibly accumulate memory,
 * which is the class of regression an unbounded label cardinality bug (a
 * duplicate label set never deduplicated, an ever-growing map) would
 * produce almost immediately. Note this fixture's device set never
 * changes cycle to cycle, so a missing `gauge.reset()` specifically is
 * NOT something this soak would catch (a stale-but-identical series would
 * simply be overwritten every cycle) — that regression class is what
 * `series-disappearance.test.ts` exists to cover instead.
 *
 * Two things an adversarial review of the first draft found:
 *
 * (1) `globalThis.gc` is only defined under `--expose-gc`, which
 *     `package.json`'s `test:integration` script didn't originally pass —
 *     so the forced-GC branch of the heap-growth bound never ran, and the
 *     fallback (no-GC) bound was ~10x looser than the actually-measured
 *     growth, giving a leak regression under 10x headroom before tripping.
 *     `--expose-gc` is now passed to the whole integration test process
 *     (a harmless flag for every other file in this glob), so the tighter
 *     bound below is real.
 * (2) Sampling `ftd_exporter_series` only *after* the 100-cycle soak
 *     finished proved render determinism, not stability across the soak —
 *     five back-to-back scrapes with no poll in between will always agree.
 *     Sampling at fixed points during the soak (early/mid/late) actually
 *     observes the value across the run the soak claims to cover.
 */

function loadFixtureText(relativePath: string): string {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return readFileSync(`${fixturesDir}/${relativePath}`, 'utf8');
}

function heapUsedBytes(): number {
  return process.memoryUsage().heapUsed;
}

async function seriesCountAt(app: { scrape(): Promise<{ body: string }> }): Promise<number> {
  const res = await app.scrape();
  const match = res.body.match(/ftd_exporter_series (\d+)/);
  assert.ok(match, 'ftd_exporter_series must be present');
  return Number(match?.[1]);
}

const CYCLES = 100;
const SAMPLE_AT_CYCLES = [5, 25, 50, 75, CYCLES];

test(`soak (${CYCLES} cycles): series count stays stable throughout and heap usage does not grow unbounded`, {
  timeout: 60_000,
}, async () => {
  const body = loadFixtureText('scc/full-live.json');
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });

  const clock = createRealClock();
  const metrics = createTestMetrics(clock);
  const backend = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret('a-realistic-looking-scc-token'),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock,
    logger: createLogger({ level: 'error', sink: () => {} }),
    minSpacingMs: 0,
    dispatcher: new Agent({ connect: { rejectUnauthorized: true } }),
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.02 });
  try {
    // Warm up before taking the baseline — the first few cycles allocate
    // steady-state structures (label hash maps, connection pool buffers)
    // that would otherwise read as "growth" between the baseline and the
    // end of the soak.
    await app.waitForCycles(5, 10_000);
    assert.ok(globalThis.gc !== undefined, 'expected --expose-gc on the test process');
    globalThis.gc();
    const baselineHeapBytes = heapUsedBytes();

    const seriesCounts: number[] = [];
    for (const target of SAMPLE_AT_CYCLES) {
      await app.waitForCycles(target, 45_000);
      seriesCounts.push(await seriesCountAt(app));
    }
    assert.ok(
      app.results.every((r) => r.outcome === 'success'),
      'every soak cycle against a stable healthy fixture must succeed',
    );
    assert.equal(
      server.requests.length,
      app.results.length,
      'exactly one upstream request per cycle',
    );
    assert.equal(
      new Set(seriesCounts).size,
      1,
      `series count must be stable across the soak (sampled at cycles ${SAMPLE_AT_CYCLES.join(',')}), got: ${seriesCounts.join(',')}`,
    );

    globalThis.gc();
    const finalHeapBytes = heapUsedBytes();
    const growthBytes = finalHeapBytes - baselineHeapBytes;
    // A tripwire for gross reset/leak regressions, not a precise budget —
    // measured actual growth on this fixture is a few MB; 20MB leaves a
    // healthy margin for machine variance while still catching a leak an
    // order of magnitude smaller than the un-forced-GC bound this
    // replaced.
    const maxGrowthBytes = 20 * 1024 * 1024;
    assert.ok(
      growthBytes < maxGrowthBytes,
      `heap grew by ${Math.round(growthBytes / 1024)}KB over ${CYCLES - 5} cycles, exceeding the ${Math.round(maxGrowthBytes / 1024)}KB tripwire`,
    );
  } finally {
    await app.stop();
    await server.close();
  }
});
