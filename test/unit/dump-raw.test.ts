import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { mapFmcFamilyResponse, mergeFmcFamilies } from '../../src/backends/fmc/map.ts';
import { mapSccResponse } from '../../src/backends/scc/map.ts';
import { Secret } from '../../src/config/secret.ts';
import type { AppConfig } from '../../src/config/types.ts';
import { dumpRaw } from '../../src/dump-raw.ts';
import { createLogger } from '../../src/log/logger.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { startFmcMockServer } from './support/fmc-mock-server.ts';
import { startTestHttpServer } from './support/http-server.ts';

const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-dump-raw-token.signature';

function quietLogger() {
  return createLogger({ level: 'debug', sink: () => {} });
}

/**
 * Every SCC test below now exercises a SECOND real request per
 * `fetchSnapshot()` call: `--dump-raw` reuses the real adapter (its own doc
 * comment's whole point), and the adapter's device-inventory refresh
 * (DESIGN.md §4.6.1) fires unconditionally on its first-ever call, captured
 * by the same `onRawResponse` hook these tests already assert against.
 * This wrapper answers that second request with a harmless, valid, empty
 * inventory body so it doesn't pollute a test's own assertions about the
 * health/metrics response it's actually testing — the tests below then
 * expect exactly one EXTRA captured entry, not zero.
 */
function sccHandler(
  healthHandler: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.url?.startsWith('/v1/inventory/devices')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"items":[]}');
      return;
    }
    healthHandler(req, res);
  };
}

function baseConfig(): Omit<AppConfig, 'backend'> {
  return {
    metricsPort: 10049,
    metricsBindAddress: '0.0.0.0',
    pollIntervalSeconds: 60,
    logLevel: 'info',
    logFormat: 'json',
    requestTimeoutSeconds: 30,
    enableDefaultMetrics: false,
  };
}

/** `buildFmcFilter` validates device UUIDs against RFC 4122 shape — mirrors the fmc-adapter.test.ts helper. */
function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

// --- Testing step 11: --dump-raw against a mock -> raw upstream JSON on stdout, no tokens present, sanitized identifiers, exit 0 (exit-code assertion belongs to index.ts/cli, not this module) ---

test('dumpRaw (SCC): writes the raw upstream JSON to the write() sink, with the device UUID sanitized and the bearer token absent', async () => {
  const realDeviceUid = '11111111-2222-4333-8444-555555555555';
  const server = await startTestHttpServer(
    sccHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            deviceUid: realDeviceUid,
            deviceName: 'ftd-lab-01',
            startTime: '2026-07-31T08:50:36.550Z',
            endTime: '2026-07-31T08:55:36.550Z',
            cpuHealthMetrics: { linaUsageAvg: 5, snortUsageAvg: 2, systemUsageAvg: 10 },
          },
        ]),
      );
    }),
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: new Secret(SECRET_TOKEN),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
    },
  };

  let written = '';
  try {
    await dumpRaw({
      config,
      logger: quietLogger(),
      write: (chunk) => (written += chunk),
      clock: createFakeClock(),
    });
  } finally {
    await server.close();
  }

  assert.ok(!written.includes(SECRET_TOKEN), 'bearer token leaked into --dump-raw output');
  assert.ok(!written.includes(realDeviceUid), 'real device UUID was not sanitized');
  const parsed = JSON.parse(written) as Array<{ backend: string; body: unknown }>;
  // 4 entries: the health/metrics response under test, the adapter's own
  // device-inventory refresh (DESIGN.md §4.6.1), the one-time domain-UUID
  // resolution `init()` makes for certificate polling (DESIGN.md §4.6.2 —
  // this test's `sccHandler` fallthrough answers it with the same array the
  // health handler returns, which is not a plain object, so certificate
  // polling itself never activates and issues no request of its own), and
  // the license-status refresh (DESIGN.md §4.6.2) — all real requests
  // through the same real adapter, which is the whole point of --dump-raw.
  assert.equal(parsed.length, 4);
  const health = parsed.find((entry) => Array.isArray(entry.body));
  assert.equal(health?.backend, 'scc');
});

test('dumpRaw (SCC): the sanitized output round-trips through the Stage 2 mapper into a valid snapshot', async () => {
  const server = await startTestHttpServer(
    sccHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            deviceUid: '11111111-2222-4333-8444-555555555555',
            deviceName: 'ftd-lab-01',
            startTime: '2026-07-31T08:50:36.550Z',
            endTime: '2026-07-31T08:55:36.550Z',
            cpuHealthMetrics: { linaUsageAvg: 5, snortUsageAvg: 2, systemUsageAvg: 10 },
          },
        ]),
      );
    }),
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: new Secret(SECRET_TOKEN),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
    },
  };

  let written = '';
  try {
    await dumpRaw({
      config,
      logger: quietLogger(),
      write: (chunk) => (written += chunk),
      clock: createFakeClock(),
    });
  } finally {
    await server.close();
  }

  const parsed = JSON.parse(written) as Array<{ backend: string; body: unknown }>;
  const health = parsed.find((entry) => Array.isArray(entry.body));
  const mapResult = mapSccResponse(health?.body);
  assert.deepEqual(mapResult.parseErrors, []);
  assert.equal(mapResult.snapshots.length, 1);
  assert.equal(mapResult.snapshots[0]?.cpu?.lina, 5);
});

test('dumpRaw: skipSanitize leaves identifiers untouched (operator-asserted opt-out)', async () => {
  const realDeviceUid = '11111111-2222-4333-8444-555555555555';
  const server = await startTestHttpServer(
    sccHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ deviceUid: realDeviceUid, deviceName: 'ftd-lab-01' }]));
    }),
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: new Secret(SECRET_TOKEN),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
    },
  };

  let written = '';
  try {
    await dumpRaw({
      config,
      logger: quietLogger(),
      write: (chunk) => (written += chunk),
      skipSanitize: true,
      clock: createFakeClock(),
    });
  } finally {
    await server.close();
  }

  assert.ok(written.includes(realDeviceUid), 'skipSanitize must leave the real UUID intact');
});

test('dumpRaw (FMC): captures one entry per device/family with the access token absent from the output', async () => {
  const server = await startFmcMockServer();
  const deviceId = deviceUuid(1);
  server.setDeviceRecordsPage(0, {
    links: {},
    items: [{ id: deviceId, name: 'ftd-fmc-lab-01', isConnected: true }],
    paging: { offset: 0, limit: 1000, count: 1, pages: 1 },
  });
  server.setAggregateMetrics(deviceId, 'CPU', {
    links: {},
    items: [
      {
        startTime: '2026-07-31 08:50:36.550 UTC',
        endTime: '2026-07-31 08:55:36.550 UTC',
        cpuHealthMetrics: { linaUsageAvg: 5, snortUsageAvg: 2, systemUsageAvg: 10 },
        name: 'ftd-fmc-lab-01',
        id: deviceId,
        type: 'AggregateMetric',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  });

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'fmc',
      host: server.host,
      username: 'svc',
      password: new Secret('a-realistic-fmc-password'),
      tlsInsecureSkipVerify: true,
      maxConcurrentRequests: 5,
      discoveryIntervalSeconds: 900,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
      metricFamilies: ['CPU'],
      timeRange: '5m',
    },
  };

  let written = '';
  try {
    await dumpRaw({ config, logger: quietLogger(), write: (chunk) => (written += chunk) });
  } finally {
    await server.close();
  }

  assert.ok(!written.includes('a-realistic-fmc-password'));
  const parsed = JSON.parse(written) as Array<{
    backend: string;
    deviceId?: string;
    family?: string;
    body: unknown;
  }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.backend, 'fmc');
  assert.equal(parsed[0]?.family, 'CPU');
  // The device UUID is itself sanitized by default -- assert the shape
  // (still a UUID-looking placeholder) rather than the exact real value.
  assert.notEqual(parsed[0]?.deviceId, deviceId);
});

test('dumpRaw (FMC): the sanitized output round-trips through the Stage 2 FMC mapper into a valid snapshot', async () => {
  const server = await startFmcMockServer();
  const deviceId = deviceUuid(2);
  server.setDeviceRecordsPage(0, {
    links: {},
    items: [{ id: deviceId, name: 'ftd-fmc-lab-02', isConnected: true }],
    paging: { offset: 0, limit: 1000, count: 1, pages: 1 },
  });
  server.setAggregateMetrics(deviceId, 'CPU', {
    links: {},
    items: [
      {
        startTime: '2026-07-31 08:50:36.550 UTC',
        endTime: '2026-07-31 08:55:36.550 UTC',
        cpuHealthMetrics: { linaUsageAvg: 7, snortUsageAvg: 3, systemUsageAvg: 11 },
        name: 'ftd-fmc-lab-02',
        id: deviceId,
        type: 'AggregateMetric',
      },
    ],
    paging: { offset: 0, limit: 25, count: 1, pages: 1 },
  });

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'fmc',
      host: server.host,
      username: 'svc',
      password: new Secret('a-realistic-fmc-password'),
      tlsInsecureSkipVerify: true,
      maxConcurrentRequests: 5,
      discoveryIntervalSeconds: 900,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
      metricFamilies: ['CPU'],
      timeRange: '5m',
    },
  };

  let written = '';
  try {
    await dumpRaw({ config, logger: quietLogger(), write: (chunk) => (written += chunk) });
  } finally {
    await server.close();
  }

  const parsed = JSON.parse(written) as Array<{
    backend: string;
    body: { items?: Array<{ id: string }> };
  }>;
  // The mapper cross-checks items[0].id against the requested device UUID
  // (DESIGN.md's device-identity-mixup guard) — read the sanitized
  // placeholder id back out of the sanitized body itself, rather than
  // asserting against the pre-sanitization real UUID, since sanitization
  // replaced it with a different (but internally consistent) placeholder.
  const sanitizedDeviceId = parsed[0]?.body.items?.[0]?.id ?? '';
  const familyResult = mapFmcFamilyResponse(parsed[0]?.body, 'CPU', sanitizedDeviceId);
  assert.deepEqual(familyResult.parseErrors, []);
  const merged = mergeFmcFamilies(sanitizedDeviceId, 'ftd-fmc-lab-02', [familyResult]);
  assert.deepEqual(merged.parseErrors, []);
  assert.equal(merged.snapshot?.cpu?.lina, 7);
});

// --- Regression: onRawResponse must fire on a non-2xx response too (Stage 11 review finding 5) ---
//
// Before this fix, both adapters only called their raw-capture hook after
// a successful (2xx, already-parsed) response — a 404/500 error body,
// often the single most useful capture for a contributor debugging a
// misconfiguration, was silently lost. The hook now lives in
// src/http/client.ts itself, firing for every status code the client
// actually receives a response for, before status-code classification.

test('dumpRaw (SCC): a 404 error response body is captured before the client classifies and throws it', async () => {
  // 404 (not 500/429): those classes are retryable, and SCC's mandatory
  // inter-request spacing guard would otherwise dominate this test's
  // runtime across retries the same way it does in the REQUEST_TIMEOUT_
  // SECONDS regression test in backend-factory.test.ts. A 404 is
  // classified `schema_parse`/non-retryable, so exactly one attempt is
  // made and the capture happens on that single attempt.
  const server = await startTestHttpServer(
    sccHandler((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no such fmcUid' }));
    }),
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: new Secret(SECRET_TOKEN),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
    },
  };

  let written = '';
  try {
    // fetchSnapshot() still throws after the client classifies the 404 --
    // dumpRaw's own contract is "capture what was seen," not "guarantee
    // success" -- but the capture must have already happened before that
    // throw, which is exactly what `onRawResponse` firing inside
    // performAttempt() (before resolveError()) guarantees. The device-
    // inventory refresh in `finally` still succeeds against the harmless
    // `sccHandler`-provided response even though the health leg failed —
    // an inventory hiccup must never mask a health-side failure, and vice
    // versa (DESIGN.md §4.6.1).
    await assert.rejects(() =>
      dumpRaw({
        config,
        logger: quietLogger(),
        write: (chunk) => (written += chunk),
        clock: createFakeClock(),
      }),
    );
  } finally {
    await server.close();
  }

  const parsed = JSON.parse(written) as Array<{ statusCode: number; body: unknown }>;
  // 4 captures: the 404 health leg under test, the inventory refresh (200,
  // `sccHandler` intercepts that path), the domain-UUID resolution `init()`
  // makes for certificate polling (404, same handler fallthrough as health
  // — the resulting body is not a usable domain list, so certificate
  // polling never activates and issues no request of its own), and the
  // license-status refresh (404, same fallthrough) — DESIGN.md §4.6.2.
  assert.equal(parsed.length, 4, 'expected the 404 health capture plus inventory/domain/license');
  const notFound = parsed.filter((entry) => entry.statusCode === 404);
  assert.ok(notFound.length > 0, 'the 404 error response must still be captured, not dropped');
  assert.deepEqual(notFound[0]?.body, { error: 'no such fmcUid' });
});

test('dumpRaw (FMC): a per-family 401/error response body is captured even though that family contributes no data to the snapshot', async () => {
  const server = await startFmcMockServer();
  const deviceId = deviceUuid(3);
  server.setDeviceRecordsPage(0, {
    links: {},
    items: [{ id: deviceId, name: 'ftd-fmc-lab-03', isConnected: true }],
    paging: { offset: 0, limit: 1000, count: 1, pages: 1 },
  });
  // "Device not connected." -- a realistic per-device/family error
  // envelope (see test/fixtures/fmc/device-not-connected.json) that a
  // contributor would specifically want to capture and share.
  server.setAggregateMetrics(
    deviceId,
    'CPU',
    { error: { category: 'FRAMEWORK', messages: [{ description: 'Device not connected.' }] } },
    400,
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'fmc',
      host: server.host,
      username: 'svc',
      password: new Secret('a-realistic-fmc-password'),
      tlsInsecureSkipVerify: true,
      maxConcurrentRequests: 5,
      discoveryIntervalSeconds: 900,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
      metricFamilies: ['CPU'],
      timeRange: '5m',
    },
  };

  let written = '';
  await dumpRaw({ config, logger: quietLogger(), write: (chunk) => (written += chunk) });
  await server.close();

  const parsed = JSON.parse(written) as Array<{ statusCode: number; body: unknown }>;
  assert.equal(parsed.length, 1, 'the 400 error response must still be captured, not dropped');
  assert.equal(parsed[0]?.statusCode, 400);
  assert.deepEqual(parsed[0]?.body, {
    error: { category: 'FRAMEWORK', messages: [{ description: 'Device not connected.' }] },
  });
});

// --- Regression: credential-shaped values embedded in an upstream field must be redacted, not just UUIDs/IPv4 (Stage 11 review finding 4) ---

test('dumpRaw: a links.self URL embedding userinfo credentials and a bearer-token query parameter is redacted', async () => {
  const server = await startTestHttpServer(
    sccHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            deviceUid: '11111111-2222-4333-8444-555555555555',
            deviceName: 'ftd-lab-01',
            links: {
              self: 'https://svcacct:Passw0rd123@fmc.corp.internal/api/v1/devices?access_token=eyJhbGciOiJIUzI1NiJ9.LEAKED.sig',
            },
            metadata: { snmpCommunity: 'public-readonly-secret' },
          },
        ]),
      );
    }),
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: new Secret(SECRET_TOKEN),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
    },
  };

  let written = '';
  try {
    await dumpRaw({
      config,
      logger: quietLogger(),
      write: (chunk) => (written += chunk),
      clock: createFakeClock(),
    });
  } finally {
    await server.close();
  }

  assert.ok(!written.includes('Passw0rd123'), 'userinfo password leaked via links.self');
  assert.ok(
    !written.includes('eyJhbGciOiJIUzI1NiJ9.LEAKED.sig'),
    'bearer-token query value leaked via links.self',
  );
  assert.ok(!written.includes('public-readonly-secret'), 'snmpCommunity value leaked');
  // The non-secret parts of the URL (host, path, query key) remain --
  // over-redacting the whole field would defeat the mode's own purpose.
  assert.ok(written.includes('fmc.corp.internal'));
  assert.ok(written.includes('/api/v1/devices'));
});

// --- Regression: a non-JSON body must still receive pattern-based credential redaction, not pass through verbatim (Stage 11 review finding 6) ---

test('dumpRaw: a non-JSON (e.g. HTML SSO interstitial) response body is pattern-redacted, not passed through verbatim', async () => {
  const server = await startTestHttpServer(
    sccHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Please wait... session=SECRET-SESSION-COOKIE-VALUE-1234</body></html>');
    }),
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: new Secret(SECRET_TOKEN),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
    },
  };

  let written = '';
  try {
    await dumpRaw({
      config,
      logger: quietLogger(),
      write: (chunk) => (written += chunk),
      clock: createFakeClock(),
    });
  } finally {
    await server.close();
  }

  assert.ok(
    !written.includes('SECRET-SESSION-COOKIE-VALUE-1234'),
    'a credential-shaped value in a non-JSON body leaked verbatim',
  );
});

test('dumpRaw: skipSanitize leaves a non-JSON body untouched too (opt-out applies uniformly)', async () => {
  const server = await startTestHttpServer(
    sccHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>session=SECRET-VALUE</html>');
    }),
  );

  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiToken: new Secret(SECRET_TOKEN),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
      licensePollIntervalSeconds: 3600,
      certificatePollIntervalSeconds: 3600,
    },
  };

  let written = '';
  try {
    await dumpRaw({
      config,
      logger: quietLogger(),
      write: (chunk) => (written += chunk),
      skipSanitize: true,
      clock: createFakeClock(),
    });
  } finally {
    await server.close();
  }

  assert.ok(written.includes('SECRET-VALUE'));
});
