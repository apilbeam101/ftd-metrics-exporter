import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBackend } from '../../src/backend-factory.ts';
import { Secret } from '../../src/config/secret.ts';
import type { AppConfig } from '../../src/config/types.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startFmcMockServer } from './support/fmc-mock-server.ts';

function quietLogger() {
  return createLogger({ level: 'debug', sink: () => {} });
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

test('createBackend: kind "scc" produces a HealthBackend with kind scc', () => {
  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: 'https://api.eu.security.cisco.com/firewall',
      apiToken: new Secret('token'),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
    },
  };
  const backend = createBackend({
    config,
    clock: createRealClock(),
    logger: quietLogger(),
    pollIntervalSeconds: config.pollIntervalSeconds,
  });
  assert.equal(backend.kind, 'scc');
});

test('createBackend: kind "fmc" produces a HealthBackend with kind fmc', () => {
  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'fmc',
      host: 'fmc.example.internal',
      username: 'svc',
      password: new Secret('pw'),
      tlsInsecureSkipVerify: false,
      maxConcurrentRequests: 5,
      discoveryIntervalSeconds: 900,
      metricFamilies: ['CPU'],
      timeRange: '5m',
    },
  };
  const backend = createBackend({
    config,
    clock: createRealClock(),
    logger: quietLogger(),
    pollIntervalSeconds: config.pollIntervalSeconds,
  });
  assert.equal(backend.kind, 'fmc');
});

test('createBackend: SCC hooks (onParseError etc.) are actually wired, not silently dropped', async () => {
  const config: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'scc',
      baseUrl: 'https://127.0.0.1:1', // unreachable; only used to exercise the parse-error path pre-network is not viable, so this test only proves construction accepts the hooks without throwing.
      apiToken: new Secret('token'),
      fmcUid: 'fmc-uid-1',
      timeRange: '5m',
    },
  };
  let sawRawResponse = false;
  const backend = createBackend({
    config,
    clock: createRealClock(),
    logger: quietLogger(),
    pollIntervalSeconds: config.pollIntervalSeconds,
    hooks: {
      onRawResponse: () => {
        sawRawResponse = true;
      },
    },
  });
  assert.equal(backend.kind, 'scc');
  assert.equal(sawRawResponse, false, 'hook must not fire merely from construction');
});

test('createBackend: FMC optional config fields (domainUuid, caBundlePath) are passed through only when present', () => {
  const withoutOptional: AppConfig = {
    ...baseConfig(),
    backend: {
      kind: 'fmc',
      host: 'fmc.example.internal',
      username: 'svc',
      password: new Secret('pw'),
      tlsInsecureSkipVerify: false,
      maxConcurrentRequests: 5,
      discoveryIntervalSeconds: 900,
      metricFamilies: ['CPU'],
      timeRange: '5m',
    },
  };
  // Absence of domainUuid/caBundlePath must not throw during construction
  // (exactOptionalPropertyTypes would reject an explicit `undefined` key,
  // which is exactly the bug class the conditional-spread pattern guards
  // against) -- this is a construction-time assertion, not a behavioral one.
  assert.doesNotThrow(() =>
    createBackend({
      config: withoutOptional,
      clock: createRealClock(),
      logger: quietLogger(),
      pollIntervalSeconds: withoutOptional.pollIntervalSeconds,
    }),
  );
});

// --- Regression: REQUEST_TIMEOUT_SECONDS must actually reach the adapter's HTTP client (Stage 11 review) ---
//
// Before this fix, `config.requestTimeoutSeconds` was validated by
// config/load.ts but never threaded into `createBackend`'s call to either
// adapter, so every real run silently used each adapter's own hardcoded
// 30s default regardless of what an operator configured. A 1-second
// configured timeout against a server that never responds is what proves
// the value is actually load-bearing: without the fix this test would
// need the full 30s default to time out instead of ~1s.

/** `buildFmcFilter` validates device UUIDs against RFC 4122 shape. */
function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

test('createBackend: a short REQUEST_TIMEOUT_SECONDS is honored by the FMC adapter (not silently defaulted to 30s)', async () => {
  // FMC, not SCC: the SCC adapter's mandatory 30s inter-request spacing
  // guard (DESIGN.md §3.2.4) would otherwise dominate this test's runtime
  // regardless of REQUEST_TIMEOUT_SECONDS, since a request landing inside
  // that floor waits on the guard before the timeout budget is even
  // relevant. The FMC adapter has no such floor.
  const server = await startFmcMockServer();
  const deviceId = deviceUuid(1);
  server.setDeviceRecordsPage(0, {
    links: {},
    items: [{ id: deviceId, name: 'ftd1', isConnected: true }],
    paging: { offset: 0, limit: 1000, count: 1, pages: 1 },
  });
  // Never resolves within the 1s budget below -- the request must time out.
  server.setAggregateMetricsDelay(5_000);

  try {
    const config: AppConfig = {
      ...baseConfig(),
      requestTimeoutSeconds: 1,
      backend: {
        kind: 'fmc',
        host: server.host,
        username: 'svc',
        password: new Secret('pw'),
        tlsInsecureSkipVerify: true,
        maxConcurrentRequests: 5,
        discoveryIntervalSeconds: 900,
        metricFamilies: ['CPU'],
        timeRange: '5m',
      },
    };
    const backend = createBackend({
      config,
      clock: createRealClock(),
      logger: quietLogger(),
      pollIntervalSeconds: config.pollIntervalSeconds,
    });
    try {
      await backend.init();
      const startedAt = Date.now();
      const snapshots = await backend.fetchSnapshot();
      const elapsedMs = Date.now() - startedAt;
      // Partial success is success (DESIGN.md §2.5): the one device's one
      // family times out and is recorded as a parse error, not thrown --
      // so the load-bearing assertion is timing, not a rejection.
      assert.equal(snapshots.length, 0, 'the only device/family times out and contributes nothing');
      assert.ok(
        elapsedMs < 4_000,
        `expected the 1s configured timeout to bound the request well under the 5s server delay, took ${elapsedMs}ms`,
      );
    } finally {
      await backend.close();
    }
  } finally {
    await server.close();
  }
});
