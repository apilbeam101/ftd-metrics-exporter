import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startTestHttpServer } from '../unit/support/http-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * Review finding: `parseErrorTracker` (shared with `src/index.ts`'s real
 * wiring) is what lets `poller.ts` distinguish "health/metrics resolved to
 * zero devices because parsing failed" from "health/metrics resolved to
 * zero devices because the fleet is genuinely empty" (DESIGN.md §2.5). The
 * device-inventory refresh (DESIGN.md §4.6.1) is a fully independent
 * upstream call that can legitimately have its own parse error on a cycle
 * where health/metrics is completely healthy and genuinely empty — that
 * combination must still classify as a successful poll cycle. Feeding an
 * inventory-only parse error into the same tracker used for the
 * health-snapshot check would misclassify it as a failure.
 */

function routedHandler(routes: {
  health: (req: IncomingMessage, res: ServerResponse) => void;
  inventory: (req: IncomingMessage, res: ServerResponse) => void;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.url?.startsWith('/v1/inventory/devices')) {
      routes.inventory(req, res);
    } else {
      routes.health(req, res);
    }
  };
}

function jsonOk(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('an inventory-only parse error does not misclassify a genuinely-empty, otherwise-healthy health poll as a failure', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      // Health/metrics: valid, genuinely empty fleet -- zero parse errors.
      health: (_req, res) => jsonOk(res, []),
      // Device inventory: structurally valid, a real FTD entry (passes the
      // deviceType filter) but missing `uid` -- this both records a parse
      // error AND (per the companion fix) throws inside the adapter, so
      // onInventoryError also fires. Neither should touch the health-cycle
      // classification.
      inventory: (_req, res) =>
        jsonOk(res, { items: [{ name: 'ftd-broken', deviceType: 'CDFMC_MANAGED_FTD' }] }),
    }),
  );

  const metrics = createTestMetrics(createRealClock());
  const parseErrorGroups: string[] = [];
  const backend = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret('a-realistic-looking-scc-token'),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createRealClock(),
    logger: createLogger({ level: 'error', sink: () => {} }),
    minSpacingMs: 0,
    dispatcher: new Agent({ connect: { rejectUnauthorized: true } }),
    inventoryPollIntervalSeconds: 300,
    // Mirrors src/index.ts's real (fixed) wiring exactly: an inventory
    // parse error must not feed parseErrorTracker.
    onParseError: (error) => {
      parseErrorGroups.push(error.group);
      if (error.group !== 'inventory') {
        metrics.parseErrorTracker.record();
      }
      metrics.recorder.onParseError(error);
    },
  });

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 0.05 });
  try {
    await app.waitForCycles(1);
    assert.ok(parseErrorGroups.includes('inventory'), 'the inventory parse error must still fire');
    assert.equal(
      app.results[0]?.outcome,
      'success',
      'a genuinely-empty, error-free health poll must not be classified as a failure merely because the independent inventory refresh hit a parse error',
    );
    assert.equal(app.results[0]?.deviceCount, 0);

    const res = await app.scrape();
    assert.match(res.body, /ftd_exporter_up 1/);
    assert.match(res.body, /ftd_exporter_parse_errors_total\{group="inventory"\} 1/);
  } finally {
    await app.stop();
    await server.close();
  }
});
