import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { startTestHttpServer } from './support/http-server.ts';

/**
 * DESIGN.md §4.6.1: the device-inventory poll wired into the SCC adapter,
 * confirmed live (2026-08-11) — this is the fix for the "unreachable
 * device is silently absent from health/metrics" gap (the FPR1010 finding).
 * The adapter-level tests in scc-adapter.test.ts deliberately omit
 * `inventoryPollIntervalSeconds` (disabling this feature) so they don't
 * have to also serve a valid inventory response; this file is the
 * dedicated coverage for the feature itself.
 */

const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-scc-token.signature';

function quietLogger() {
  return createLogger({ level: 'debug', sink: () => {} });
}

/** Routes by path so a test can script the health and inventory responses independently. */
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

test('SCC adapter (inventory): getDeviceInventory() returns [] before the first fetchSnapshot() call', async () => {
  const adapter = createSccAdapter({
    baseUrl: 'https://example.invalid',
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    inventoryPollIntervalSeconds: 300,
  });
  assert.deepEqual(adapter.getDeviceInventory(), []);
});

test('SCC adapter (inventory): omitting inventoryPollIntervalSeconds disables the feature — no second request is made', async () => {
  const server = await startTestHttpServer((_req, res) => jsonOk(res, []));
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    // inventoryPollIntervalSeconds deliberately omitted.
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(server.requests.length, 1, 'expected only the health/metrics request');
    assert.deepEqual(adapter.getDeviceInventory(), []);
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (inventory): fetchSnapshot() also fetches inventory, filters to FTD devices, and exposes it via getDeviceInventory()', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      health: (_req, res) => jsonOk(res, []),
      inventory: (_req, res) =>
        jsonOk(res, {
          items: [
            {
              name: 'ftd-01',
              uid: 'u1',
              deviceType: 'CDFMC_MANAGED_FTD',
              connectivityState: 'ONLINE',
            },
            { name: 'meraki-01', uid: 'u2', deviceType: 'MERAKI_MX' },
          ],
        }),
    }),
  );
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    inventoryPollIntervalSeconds: 300,
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(server.requests.length, 2, 'expected health + inventory requests');
    const inventoryRequest = server.requests.find((r) => r.url.startsWith('/v1/inventory/devices'));
    assert.ok(inventoryRequest, 'expected a request to /v1/inventory/devices');
    assert.equal(inventoryRequest.headers.authorization, `Bearer ${SECRET_TOKEN}`);

    const inventory = adapter.getDeviceInventory();
    assert.equal(inventory.length, 1, 'the Meraki entry must be filtered out');
    assert.equal(inventory[0]?.deviceName, 'ftd-01');
    assert.equal(inventory[0]?.connectivityState, 'ONLINE');
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (inventory): a device present ONLY in inventory (absent from health/metrics) is still exposed — the actual Finding 3 fix', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      // Health/metrics returns zero devices, exactly like a real
      // UNREACHABLE device that has dropped out of that endpoint entirely.
      health: (_req, res) => jsonOk(res, []),
      inventory: (_req, res) =>
        jsonOk(res, {
          items: [
            {
              name: 'ftd-unreachable',
              uid: 'u1',
              deviceType: 'CDFMC_MANAGED_FTD',
              connectivityState: 'UNREACHABLE',
            },
          ],
        }),
    }),
  );
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    inventoryPollIntervalSeconds: 300,
  });
  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots.length, 0, 'health/metrics genuinely has nothing for this device');
    const inventory = adapter.getDeviceInventory();
    assert.equal(inventory.length, 1, 'inventory still lists it, unlike health/metrics');
    assert.equal(inventory[0]?.connectivityState, 'UNREACHABLE');
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (inventory): the health and inventory requests share ONE spacing guard — combined, never faster than the floor', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      health: (_req, res) => jsonOk(res, []),
      inventory: (_req, res) => jsonOk(res, { items: [] }),
    }),
  );
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createRealClock(),
    logger: quietLogger(),
    minSpacingMs: 100,
    dispatcher,
    inventoryPollIntervalSeconds: 300,
  });
  try {
    await adapter.init();
    const start = Date.now();
    await adapter.fetchSnapshot();
    const elapsedMs = Date.now() - start;
    assert.equal(server.requests.length, 2);
    // Two requests through one 100ms-floor guard within a single
    // fetchSnapshot() call must take at least ~100ms combined — proves
    // they're serialized through the same guard, not two independent ones
    // that would together exceed SCC's real 2 req/min limit in production.
    assert.ok(
      elapsedMs >= 90,
      `expected the shared spacing floor to serialize the two requests by ~100ms, only ${elapsedMs}ms elapsed`,
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (inventory): a failing inventory refresh does not fail fetchSnapshot(), and fires onInventoryError', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      health: (_req, res) => jsonOk(res, []),
      inventory: (_req, res) => {
        res.writeHead(500);
        res.end();
      },
    }),
  );
  let inventoryErrors = 0;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    inventoryPollIntervalSeconds: 300,
    onInventoryError: () => {
      inventoryErrors++;
    },
  });
  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.deepEqual(snapshots, [], 'health leg succeeded independently of the inventory failure');
    assert.equal(inventoryErrors, 1);
    assert.deepEqual(adapter.getDeviceInventory(), []);
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (inventory): a resolved-but-degenerate inventory response (parse errors, zero devices) keeps the previous good list and fires onInventoryError — it is NOT a successful refresh to empty', async () => {
  // Review finding: createSccDeviceInventory's refresh-if-due cache treats
  // ANY resolved (non-throwing) fetchDevices() call as success, including
  // a resolved [] caused by a parse failure rather than a genuinely empty
  // fleet. Without the fix, this wipes the last-known-good inventory,
  // silently, with no onInventoryError signal — exactly the
  // "resolved-empty-due-to-failure" ambiguity poller.ts already guards
  // against for the health-snapshot cache (DESIGN.md §2.5).
  let inventoryBody: unknown = {
    items: [
      { name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD', connectivityState: 'ONLINE' },
    ],
  };
  const server = await startTestHttpServer(
    routedHandler({
      health: (_req, res) => jsonOk(res, []),
      inventory: (_req, res) => jsonOk(res, inventoryBody),
    }),
  );
  let inventoryErrors = 0;
  const parseErrors: string[] = [];
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const clock = createFakeClock();
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock,
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    inventoryPollIntervalSeconds: 300,
    onInventoryError: () => {
      inventoryErrors++;
    },
    onParseError: (error) => {
      parseErrors.push(error.group);
    },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getDeviceInventory().length, 1, 'first refresh must succeed normally');
    assert.equal(inventoryErrors, 0);

    // Now the endpoint degenerates: a structurally valid response whose
    // one item is missing its required `uid` -- zero devices mapped, one
    // parse error recorded, but the fetch itself never throws a network
    // or HTTP-status error. Advance the clock past the 300s cadence so
    // this second call is actually due to refresh, not served from cache.
    inventoryBody = { items: [{ name: 'ftd-broken', deviceType: 'CDFMC_MANAGED_FTD' }] };
    clock.advance(300_000);
    await adapter.fetchSnapshot();

    assert.equal(
      adapter.getDeviceInventory().length,
      1,
      'the previous good inventory must survive a degenerate (parse-error, zero-device) refresh',
    );
    assert.equal(
      inventoryErrors,
      1,
      'a resolved-but-degenerate refresh must still count as a failure for onInventoryError',
    );
    assert.ok(parseErrors.includes('inventory'), 'the parse error must still be reported');
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (inventory): a health-leg failure does not prevent the inventory refresh from running', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      health: (_req, res) => {
        res.writeHead(404);
        res.end();
      },
      inventory: (_req, res) =>
        jsonOk(res, {
          items: [{ name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' }],
        }),
    }),
  );
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    inventoryPollIntervalSeconds: 300,
  });
  try {
    await adapter.init();
    await assert.rejects(adapter.fetchSnapshot());
    assert.equal(
      adapter.getDeviceInventory().length,
      1,
      'inventory still refreshed despite the health-leg 404',
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (inventory): getDeviceInventory() returns [] after close()', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      health: (_req, res) => jsonOk(res, []),
      inventory: (_req, res) =>
        jsonOk(res, {
          items: [{ name: 'ftd-01', uid: 'u1', deviceType: 'CDFMC_MANAGED_FTD' }],
        }),
    }),
  );
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    inventoryPollIntervalSeconds: 300,
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getDeviceInventory().length, 1);
  } finally {
    await adapter.close();
    await server.close();
  }
  assert.deepEqual(adapter.getDeviceInventory(), []);
});
