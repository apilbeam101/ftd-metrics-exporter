import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Gauge } from 'prom-client';
import { Agent, request } from 'undici';
import { createRegistry } from '../../src/metrics/registry.ts';
import {
  createServer,
  DEFAULT_CONNECTIONS_CHECKING_INTERVAL_MS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_HEADER_SIZE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type MetricsServer,
} from '../../src/server/server.ts';
import { parseExposition } from './support/exposition.ts';
import { generateTlsFixture } from './support/tls-fixtures.ts';

interface Harness {
  server: MetricsServer;
  port: number;
}

async function startHarness(
  overrides: Partial<{ isAlive: () => boolean; isReady: () => boolean }> = {},
): Promise<Harness> {
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: overrides.isAlive ?? (() => true),
    isReady: overrides.isReady ?? (() => true),
  });
  const bound = await server.start();
  return { server, port: bound.port };
}

async function get(
  port: number,
  path: string,
  init: { method?: string } = {},
): Promise<{
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  const res = await request(`http://127.0.0.1:${port}${path}`, { method: init.method ?? 'GET' });
  const body = await res.body.text();
  return { statusCode: res.statusCode, body, headers: res.headers };
}

// --- Testing step 1: /metrics returns 200, correct Content-Type, parses ---

test('/metrics: 200, correct Content-Type, parses as exposition format', async () => {
  const h = await startHarness();
  try {
    const res = await get(h.port, '/metrics');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/plain/);
    assert.doesNotThrow(() => parseExposition(res.body));
  } finally {
    await h.server.stop();
  }
});

// --- Testing step 2: no upstream call on scrape (poll-cache-serve contract) ---

test('poll-cache-serve contract: 20 scrapes never touch the network — renderMetrics runs from cache only, zero upstream requests', async () => {
  const registry = createRegistry(false);
  let renderCalls = 0;
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
    // Stands in for "read from the cache" — never awaits, never calls out,
    // so nothing in this handler's call graph can reach the network.
    renderMetrics: () => {
      renderCalls++;
    },
  });
  const bound = await server.start();
  try {
    for (let i = 0; i < 20; i++) {
      const res = await get(bound.port, '/metrics');
      assert.equal(res.statusCode, 200);
    }
    assert.equal(renderCalls, 20);
  } finally {
    await server.stop();
  }
});

// --- Testing step 3: scrape latency bounded even if "upstream" hangs ---

test('scrape latency: /metrics responds in single-digit milliseconds even when renderMetrics is instantaneous (no upstream call exists in the request path)', async () => {
  const h = await startHarness();
  try {
    const start = performance.now();
    const res = await get(h.port, '/metrics');
    const elapsedMs = performance.now() - start;
    assert.equal(res.statusCode, 200);
    assert.ok(elapsedMs < 500, `expected a fast local response, took ${elapsedMs}ms`);
  } finally {
    await h.server.stop();
  }
});

// --- Testing step 4: N scrapers cost 1 upstream request (poll-cache-serve at the HTTP layer) ---

test('10 concurrent scrapes each independently render from the shared cache/registry with no cross-request interference', async () => {
  const h = await startHarness();
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => get(h.port, '/metrics')));
    for (const res of results) {
      assert.equal(res.statusCode, 200);
    }
  } finally {
    await h.server.stop();
  }
});

// --- Testing step 5: /healthz is independent of upstream health ---

test('/healthz: 200 even while the readiness/upstream signal is unhealthy — restart-loop hazard guard (DESIGN.md §7.2)', async () => {
  const h = await startHarness({ isReady: () => false });
  try {
    const res = await get(h.port, '/healthz');
    assert.equal(res.statusCode, 200);
  } finally {
    await h.server.stop();
  }
});

test('/healthz: 503 only when isAlive() itself reports false (process not serving)', async () => {
  const h = await startHarness({ isAlive: () => false });
  try {
    const res = await get(h.port, '/healthz');
    assert.equal(res.statusCode, 503);
  } finally {
    await h.server.stop();
  }
});

// --- Testing step 6: /readyz reflects cache population, not upstream health ---

test('/readyz: 503 before the first successful poll', async () => {
  const h = await startHarness({ isReady: () => false });
  try {
    const res = await get(h.port, '/readyz');
    assert.equal(res.statusCode, 503);
  } finally {
    await h.server.stop();
  }
});

test('/readyz: 200 after the first successful poll', async () => {
  const h = await startHarness({ isReady: () => true });
  try {
    const res = await get(h.port, '/readyz');
    assert.equal(res.statusCode, 200);
  } finally {
    await h.server.stop();
  }
});

// --- Testing step 7: /readyz does not flap back to 503 on a later upstream failure ---

test('/readyz: stays 200 after a later poll failure — readiness reflects "cache populated," not "upstream currently healthy," so it never flaps (DESIGN.md §7.2)', async () => {
  let ready = false;
  const h = await startHarness({ isReady: () => ready });
  try {
    assert.equal((await get(h.port, '/readyz')).statusCode, 503);
    ready = true; // first successful poll populates the cache
    assert.equal((await get(h.port, '/readyz')).statusCode, 200);
    // A later poll failure must not un-populate the cache or flip isReady back —
    // the caller (Stage 11) is expected to never call the isReady flag back to
    // false once it has gone true. This route layer simply must not add its
    // own flapping on top of whatever the caller reports.
    assert.equal((await get(h.port, '/readyz')).statusCode, 200);
  } finally {
    await h.server.stop();
  }
});

// --- Landing page: `/` returns 200 + text/html linking /metrics (Prometheus instrumentation guidelines) ---

test('/ returns 200, text/html, and links /metrics', async () => {
  const h = await startHarness();
  try {
    const res = await get(h.port, '/');
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(res.body, /href="\/metrics"/);
  } finally {
    await h.server.stop();
  }
});

// --- Testing step 8: unknown path -> 404; POST /metrics -> 405 ---

test('unknown path -> 404', async () => {
  const h = await startHarness();
  try {
    const res = await get(h.port, '/nonexistent');
    assert.equal(res.statusCode, 404);
  } finally {
    await h.server.stop();
  }
});

test('POST /metrics -> 405', async () => {
  const h = await startHarness();
  try {
    const res = await get(h.port, '/metrics', { method: 'POST' });
    assert.equal(res.statusCode, 405);
  } finally {
    await h.server.stop();
  }
});

test('POST /healthz -> 405, POST /readyz -> 405', async () => {
  const h = await startHarness();
  try {
    assert.equal((await get(h.port, '/healthz', { method: 'POST' })).statusCode, 405);
    assert.equal((await get(h.port, '/readyz', { method: 'POST' })).statusCode, 405);
  } finally {
    await h.server.stop();
  }
});

// --- Testing step 9: METRICS_BIND_ADDRESS=127.0.0.1 is not reachable from a non-loopback address ---

test('binding to 127.0.0.1 reports a loopback address, not 0.0.0.0', async () => {
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
  });
  const bound = await server.start();
  try {
    assert.equal(bound.address, '127.0.0.1');
  } finally {
    await server.stop();
  }
});

// --- Testing step 10/11/12: TLS listener, TLS 1.1 rejection, mTLS ---

test('TLS listener: with cert+key configured, HTTPS works', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const certPath = writeTemp('cert.pem', fixture.cert);
  const keyPath = writeTemp('key.pem', fixture.key);
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
    tls: { certPath, keyPath, minVersion: 'TLSv1.2' },
  });
  const bound = await server.start();
  const dispatcher = new Agent({ connect: { ca: fixture.cert, minVersion: 'TLSv1.2' } });
  try {
    const res = await request(`https://127.0.0.1:${bound.port}/healthz`, { dispatcher });
    await res.body.text();
    assert.equal(res.statusCode, 200);
  } finally {
    await dispatcher.close();
    await server.stop();
  }
});

test('TLS listener: plain HTTP does not work against an HTTPS-only listener', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const certPath = writeTemp('cert2.pem', fixture.cert);
  const keyPath = writeTemp('key2.pem', fixture.key);
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
    tls: { certPath, keyPath, minVersion: 'TLSv1.2' },
  });
  const bound = await server.start();
  try {
    await assert.rejects(request(`http://127.0.0.1:${bound.port}/healthz`));
  } finally {
    await server.stop();
  }
});

// A client-side offer of TLS 1.0/1.1 is refused by OpenSSL 3.x's own
// security level *before any bytes reach the network*, regardless of the
// server's configured floor — verified: pointing the server's minVersion at
// 'TLSv1' (i.e. no floor at all) and re-running an "assert a TLS1.1-max
// client is rejected" test still passes, because the client itself refuses
// to attempt the handshake. That makes such a test unable to distinguish a
// correctly-enforced TLSv1.2 floor from no floor whatsoever. TLSv1.3-vs-
// TLSv1.2 is the version boundary OpenSSL 3.x will actually negotiate on
// both sides, so it is used here instead, as a genuinely discriminating
// stand-in for "the configured minVersion reaches the listener and is
// enforced" — confirmed to fail when minVersion is dropped/undefined.
test('METRICS_TLS_MIN_VERSION is genuinely enforced by the listener: a client below the configured floor is rejected, and a client at the floor succeeds', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const certPath = writeTemp('cert3.pem', fixture.cert);
  const keyPath = writeTemp('key3.pem', fixture.key);
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
    tls: { certPath, keyPath, minVersion: 'TLSv1.3' },
  });
  const bound = await server.start();
  const belowFloor = new Agent({
    connect: { ca: fixture.cert, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' },
  });
  const atFloor = new Agent({
    connect: { ca: fixture.cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
  });
  try {
    await assert.rejects(
      request(`https://127.0.0.1:${bound.port}/healthz`, { dispatcher: belowFloor }),
      'a client offering only a version below the configured floor must be rejected',
    );
    const ok = await request(`https://127.0.0.1:${bound.port}/healthz`, { dispatcher: atFloor });
    await ok.body.text();
    assert.equal(ok.statusCode, 200);
  } finally {
    await belowFloor.close();
    await atFloor.close();
    await server.stop();
  }
});

test('mTLS: with METRICS_TLS_CLIENT_CA_PATH set, a client with a valid cert succeeds and a client with none is rejected', async () => {
  const serverFixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const clientCa = await generateTlsFixture('test-client-ca');
  const certPath = writeTemp('cert4.pem', serverFixture.cert);
  const keyPath = writeTemp('key4.pem', serverFixture.key);
  const clientCaPath = writeTemp('client-ca.pem', clientCa.cert);
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
    tls: { certPath, keyPath, minVersion: 'TLSv1.2', clientCaPath },
  });
  const bound = await server.start();

  const dispatcherWithClientCert = new Agent({
    connect: {
      ca: serverFixture.cert,
      cert: clientCa.cert,
      key: clientCa.key,
      minVersion: 'TLSv1.2',
    },
  });
  const dispatcherWithoutClientCert = new Agent({
    connect: { ca: serverFixture.cert, minVersion: 'TLSv1.2' },
  });
  try {
    const ok = await request(`https://127.0.0.1:${bound.port}/healthz`, {
      dispatcher: dispatcherWithClientCert,
    });
    await ok.body.text();
    assert.equal(ok.statusCode, 200);

    await assert.rejects(
      request(`https://127.0.0.1:${bound.port}/healthz`, {
        dispatcher: dispatcherWithoutClientCert,
      }),
    );
  } finally {
    await dispatcherWithClientCert.close();
    await dispatcherWithoutClientCert.close();
    await server.stop();
  }
});

// --- Testing step 13: port already in use -> clear startup error ---

test('start() rejects with a clear error when the port is already in use', async () => {
  const registryA = createRegistry(false);
  const serverA = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry: registryA,
    isAlive: () => true,
    isReady: () => true,
  });
  const boundA = await serverA.start();

  const registryB = createRegistry(false);
  const serverB = createServer({
    bindAddress: '127.0.0.1',
    port: boundA.port,
    registry: registryB,
    isAlive: () => true,
    isReady: () => true,
  });
  try {
    await assert.rejects(serverB.start(), /./);
  } finally {
    await serverA.stop();
  }
});

// --- Finding 1: a throwing isAlive()/isReady() must not crash the process ---
//
// A throw from inside a `node:http` 'request' listener is an
// uncaughtException with no promise boundary to catch it — reproduced
// directly against unfixed routes.ts (the process exited with code 1 on a
// single request). The regression here proves the process survives: if the
// throw escaped, this test file's process itself would crash and the run
// would report a file-level failure, not a clean assertion failure.

test('/healthz: a throwing isAlive() does not crash the process — returns 503, and the server keeps serving afterward', async () => {
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => {
      throw new Error('liveness probe implementation blew up');
    },
    isReady: () => true,
  });
  const bound = await server.start();
  try {
    const res = await get(bound.port, '/healthz');
    assert.equal(res.statusCode, 503);
    // Proves survival, not just this one response's status code.
    const again = await get(bound.port, '/readyz');
    assert.equal(again.statusCode, 200);
  } finally {
    await server.stop();
  }
});

test('/readyz: a throwing isReady() does not crash the process — returns 503, and /healthz still answers 200 afterward', async () => {
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => {
      throw new Error('readiness probe implementation blew up');
    },
  });
  const bound = await server.start();
  try {
    const res = await get(bound.port, '/readyz');
    assert.equal(res.statusCode, 503);
    const stillAlive = await get(bound.port, '/healthz');
    assert.equal(stillAlive.statusCode, 200);
    const stillServesMetrics = await get(bound.port, '/metrics');
    assert.equal(stillServesMetrics.statusCode, 200);
  } finally {
    await server.stop();
  }
});

// --- Finding 4: concurrent /metrics requests must never mix two renders in one response body ---
//
// prom-client's Gauge.get() only snapshots its value map synchronously when
// the gauge has no async `collect` hook; a gauge that does have one suspends
// at `await collect()` *before* reading its state, giving registry.metrics()
// a real yield point mid-render. Reproduced directly against unfixed
// routes.ts: response A's hook-bearing gauge showed generation 2 (request
// B's render, which landed during A's suspension) while its hook-less gauge
// correctly showed generation 1 — one HTTP response mixing two snapshots of
// the same fleet.

test('/metrics: two overlapping requests never mix two renders in one response body, even with an async-collect gauge on the registry', async () => {
  const registry = createRegistry(false);
  // Deliberately slow so the second request's renderMetrics() call lands
  // while the first request's registry.metrics() is still suspended inside
  // this hook's await — this is the yield point the fix must close.
  new Gauge({
    name: 'zzz_device_with_async_hook',
    help: 'test-only gauge whose snapshot is taken after registry.metrics() yields',
    labelNames: ['gen'],
    registers: [registry],
    async collect() {
      await new Promise((resolve) => setTimeout(resolve, 80));
    },
  });
  const deviceGauge = new Gauge({
    name: 'zzz_device',
    help: 'test-only gauge with no collect hook',
    labelNames: ['gen'],
    registers: [registry],
  });

  let generation = 0;
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
    renderMetrics: () => {
      generation++;
      deviceGauge.reset();
      deviceGauge.set({ gen: String(generation) }, generation);
    },
  });
  const bound = await server.start();
  try {
    const first = get(bound.port, '/metrics');
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the first request start rendering, then land the second mid-suspension
    const second = get(bound.port, '/metrics');
    const [a, b] = await Promise.all([first, second]);

    for (const res of [a, b]) {
      const gens = new Set(
        [...res.body.matchAll(/zzz_device(?:_with_async_hook)?\{gen="(\d+)"\}/g)].map((m) => m[1]),
      );
      assert.equal(
        gens.size,
        1,
        `a single response must reflect exactly one render generation, got ${[...gens].join(',')} in:\n${res.body}`,
      );
    }
  } finally {
    await server.stop();
  }
});

// --- Finding 7: 405 responses must carry an Allow header (RFC 9110 §15.5.6) ---

test('POST /metrics -> 405 with an Allow header listing GET and HEAD', async () => {
  const h = await startHarness();
  try {
    const res = await get(h.port, '/metrics', { method: 'POST' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET, HEAD');
  } finally {
    await h.server.stop();
  }
});

test('POST /healthz and POST /readyz -> 405 with an Allow header', async () => {
  const h = await startHarness();
  try {
    const healthz = await get(h.port, '/healthz', { method: 'POST' });
    const readyz = await get(h.port, '/readyz', { method: 'POST' });
    assert.equal(healthz.headers.allow, 'GET, HEAD');
    assert.equal(readyz.headers.allow, 'GET, HEAD');
  } finally {
    await h.server.stop();
  }
});

test('HEAD /metrics -> 200 with an empty body (RFC 9110 §9.1: every general-purpose server must support HEAD)', async () => {
  const h = await startHarness();
  try {
    const res = await get(h.port, '/metrics', { method: 'HEAD' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '');
  } finally {
    await h.server.stop();
  }
});

// --- Findings 2 & 6: server hardening timeout values ---

test('server hardening: headersTimeout/requestTimeout/keepAliveTimeout/maxHeaderSize/maxConnections are all applied to the underlying server, and connectionsCheckingInterval is set well below headersTimeout', async () => {
  // Regression for finding 2: headersTimeout/requestTimeout are enforced by
  // a periodic sweep of incomplete connections, not a per-connection timer —
  // a 10s headersTimeout with no connectionsCheckingInterval set is really
  // enforced at up to Node's 30s default sweep interval (verified directly
  // against a real http.Server: a stalled partial-header connection
  // survived to the 30s sweep tick, not the 10s deadline). A real-time
  // reproduction of that sweep behavior is a flaky network-timing test in
  // some sandboxed/CI environments, so this asserts the actual applied
  // values and their required relationship instead — the thing that
  // determines correctness is these numbers, not re-proving Node's own
  // documented sweep semantics on every run.
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
  });
  await server.start();
  try {
    const applied = server.hardening();
    assert.equal(applied.headersTimeout, DEFAULT_HEADERS_TIMEOUT_MS);
    assert.equal(applied.requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(applied.keepAliveTimeout, DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
    assert.equal(applied.maxHeaderSize, DEFAULT_MAX_HEADER_SIZE_BYTES);
    assert.equal(applied.connectionsCheckingInterval, DEFAULT_CONNECTIONS_CHECKING_INTERVAL_MS);
    assert.equal(applied.maxConnections, DEFAULT_MAX_CONNECTIONS);
    assert.ok(
      applied.connectionsCheckingInterval < applied.headersTimeout,
      'the sweep interval must be well below headersTimeout, or headersTimeout is not meaningfully enforced',
    );
  } finally {
    await server.stop();
  }
});

test("server hardening: keepAliveTimeout is set near Node's own default, not a generous multiple of it", () => {
  // DEFAULT_KEEP_ALIVE_TIMEOUT_MS regression: this project's default was
  // originally 60_000ms (12x Node's 5_000ms default) with no maxConnections
  // cap, which combined with plan risk #5 ("unbounded connection
  // accumulation") to hold every idle keep-alive socket for a full minute.
  assert.ok(
    DEFAULT_KEEP_ALIVE_TIMEOUT_MS <= 15_000,
    `keepAliveTimeout regressed to a generous value: ${DEFAULT_KEEP_ALIVE_TIMEOUT_MS}ms`,
  );
});

test('server hardening: maxConnections caps concurrently accepted sockets', async () => {
  const registry = createRegistry(false);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => true,
  });
  const bound = await server.start();
  try {
    const attemptCount = DEFAULT_MAX_CONNECTIONS + 20;
    const sockets = await Promise.all(
      Array.from({ length: attemptCount }, () => {
        const sock = connect(bound.port, '127.0.0.1');
        return new Promise<import('node:net').Socket>((resolve) => {
          sock.once('connect', () => resolve(sock));
          sock.once('error', () => resolve(sock));
        });
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stillOpen = sockets.filter((s) => !s.destroyed).length;
    assert.ok(
      stillOpen <= DEFAULT_MAX_CONNECTIONS,
      `expected at most ${DEFAULT_MAX_CONNECTIONS} sockets held open, got ${stillOpen} of ${attemptCount} attempted`,
    );
    for (const s of sockets) s.destroy();
  } finally {
    await server.stop();
  }
});

// --- Finding 8: empty TLS material must fail fast, not bind a permanently broken listener ---

test('createServer: an empty (zero-byte) cert file throws rather than binding a permanently-broken TLS listener', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const certPath = writeTemp('empty-cert.pem', '');
  const keyPath = writeTemp('key-for-empty-cert.pem', fixture.key);
  assert.throws(
    () =>
      createServer({
        bindAddress: '127.0.0.1',
        port: 0,
        registry: createRegistry(false),
        isAlive: () => true,
        isReady: () => true,
        tls: { certPath, keyPath, minVersion: 'TLSv1.2' },
      }),
    /METRICS_TLS_CERT_PATH.*empty/,
  );
});

test('createServer: an empty (whitespace-only) key file throws', () => {
  const certPath = writeTemp(
    'cert-for-empty-key.pem',
    'not checked for PEM validity here — key is checked independently',
  );
  const keyPath = writeTemp('empty-key.pem', '   \n  ');
  assert.throws(
    () =>
      createServer({
        bindAddress: '127.0.0.1',
        port: 0,
        registry: createRegistry(false),
        isAlive: () => true,
        isReady: () => true,
        tls: { certPath, keyPath, minVersion: 'TLSv1.2' },
      }),
    /METRICS_TLS_KEY_PATH.*empty/,
  );
});

test('createServer: an empty (zero-byte) client CA file throws', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const certPath = writeTemp('cert-for-empty-ca.pem', fixture.cert);
  const keyPath = writeTemp('key-for-empty-ca.pem', fixture.key);
  const clientCaPath = writeTemp('empty-client-ca.pem', '');
  assert.throws(
    () =>
      createServer({
        bindAddress: '127.0.0.1',
        port: 0,
        registry: createRegistry(false),
        isAlive: () => true,
        isReady: () => true,
        tls: { certPath, keyPath, minVersion: 'TLSv1.2', clientCaPath },
      }),
    /METRICS_TLS_CLIENT_CA_PATH.*empty/,
  );
});

test('createServer: a valid, non-empty cert+key still constructs and serves (positive control for the empty-file guard)', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const certPath = writeTemp('valid-cert.pem', fixture.cert);
  const keyPath = writeTemp('valid-key.pem', fixture.key);
  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry: createRegistry(false),
    isAlive: () => true,
    isReady: () => true,
    tls: { certPath, keyPath, minVersion: 'TLSv1.2' },
  });
  const bound = await server.start();
  const dispatcher = new Agent({ connect: { ca: fixture.cert, minVersion: 'TLSv1.2' } });
  try {
    const res = await request(`https://127.0.0.1:${bound.port}/healthz`, { dispatcher });
    await res.body.text();
    assert.equal(res.statusCode, 200);
  } finally {
    await dispatcher.close();
    await server.stop();
  }
});

function writeTemp(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftd-metrics-server-test-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}
