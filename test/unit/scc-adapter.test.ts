import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { type CreateSccAdapterOptions, createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import type { TimeRange } from '../../src/config/types.ts';
import type { ParseError } from '../../src/domain/diagnostics.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { isHttpError } from '../../src/http/errors.ts';
import { createLogger, type Logger } from '../../src/log/logger.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { startTestHttpServer } from './support/http-server.ts';

const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-scc-token.signature';

function loadFixtureText(relativePath: string): string {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return readFileSync(`${fixturesDir}/${relativePath}`, 'utf8');
}

function testDispatcher(): Agent {
  return new Agent({ connect: { rejectUnauthorized: true } });
}

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  return { logger, lines };
}

interface AdapterHarnessOptions {
  baseUrl: string;
  fmcUid?: string;
  timeRange?: TimeRange;
  minSpacingMs?: number;
  clock?: CreateSccAdapterOptions['clock'];
  onParseError?: (error: ParseError) => void;
  onRateLimitDeferral?: () => void;
  onUpstreamRequest?: (endpoint: string, statusCode: number, durationSeconds: number) => void;
}

function createHarness(options: AdapterHarnessOptions) {
  const { logger, lines } = captureLogger();
  const dispatcher = testDispatcher();
  const adapter = createSccAdapter({
    baseUrl: options.baseUrl,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: options.fmcUid ?? 'fmc-uid-1',
    timeRange: options.timeRange ?? '5m',
    clock: options.clock ?? createFakeClock(),
    logger,
    minSpacingMs: options.minSpacingMs ?? 0,
    dispatcher,
    ...(options.onParseError !== undefined && { onParseError: options.onParseError }),
    ...(options.onRateLimitDeferral !== undefined && {
      onRateLimitDeferral: options.onRateLimitDeferral,
    }),
    ...(options.onUpstreamRequest !== undefined && {
      onUpstreamRequest: options.onUpstreamRequest,
    }),
  });
  return { adapter, lines, logger };
}

// --- Testing step 1: the dead-config test (all 4 SCC_TIME_RANGE values) ---

for (const timeRange of ['5m', '15m', '30m', '1h'] as const) {
  test(`SCC adapter: SCC_TIME_RANGE=${timeRange} actually reaches the request query string`, async () => {
    const server = await startTestHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
    const { adapter } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}`, timeRange });
    try {
      await adapter.init();
      await adapter.fetchSnapshot();
      assert.equal(server.requests.length, 1);
      const url = server.requests[0]?.url ?? '';
      assert.ok(
        url.includes(`timeRange=${timeRange}`),
        `expected the request URL to contain timeRange=${timeRange}, got "${url}"`,
      );
    } finally {
      await adapter.close();
      await server.close();
    }
  });
}

// --- Testing steps 2-4: URL construction (current, legacy, trailing slash) ---

test('SCC adapter: URL construction against a current-style base URL path', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { adapter } = createHarness({
    baseUrl: `http://127.0.0.1:${server.port}/firewall`,
    fmcUid: 'abc-123',
    timeRange: '5m',
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(
      server.requests[0]?.url,
      '/firewall/v1/inventory/managers/abc-123/health/metrics?timeRange=5m',
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter: URL construction against a legacy-style base URL path (/api/rest) is preserved unchanged', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { adapter } = createHarness({
    baseUrl: `http://127.0.0.1:${server.port}/api/rest`,
    fmcUid: 'abc-123',
    timeRange: '5m',
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(
      server.requests[0]?.url,
      '/api/rest/v1/inventory/managers/abc-123/health/metrics?timeRange=5m',
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter: a trailing slash on the base URL produces an identical result, no "//"', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const withSlash = createHarness({
    baseUrl: `http://127.0.0.1:${server.port}/firewall/`,
    fmcUid: 'abc-123',
    timeRange: '5m',
  });
  try {
    await withSlash.adapter.init();
    await withSlash.adapter.fetchSnapshot();
    const url = server.requests[0]?.url ?? '';
    assert.equal(url, '/firewall/v1/inventory/managers/abc-123/health/metrics?timeRange=5m');
    assert.ok(!url.includes('//v1'), `expected no double-slash, got "${url}"`);
  } finally {
    await withSlash.adapter.close();
    await server.close();
  }
});

// --- Testing step 5: Authorization header present exactly once, never logged ---

test('SCC adapter: Authorization: Bearer <token> is present exactly once, and the token appears in no log line', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { adapter, lines } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${SECRET_TOKEN}`);
    const rawOutput = lines.join('');
    assert.ok(!rawOutput.includes(SECRET_TOKEN), 'token leaked into log output');
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 6: full-live fixture end to end ---

test('SCC adapter: fetchSnapshot() against the full-live fixture -> 1 snapshot, 9 interfaces', async () => {
  const body = loadFixtureText('scc/full-live.json');
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const { adapter } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.interfaces?.length, 9);
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 7: exactly one upstream request per fetchSnapshot() call ---

test('SCC adapter: exactly one upstream request is issued per fetchSnapshot() call on success', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { adapter } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(server.requests.length, 1);
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 8: spacing-guard deferral of a second call within the floor ---

test('SCC adapter: a second fetchSnapshot() within the spacing floor is deferred by real elapsed time', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { adapter } = createHarness({
    baseUrl: `http://127.0.0.1:${server.port}`,
    clock: createRealClock(),
    minSpacingMs: 100,
  });
  try {
    await adapter.init();
    const start = Date.now();
    await adapter.fetchSnapshot();
    await adapter.fetchSnapshot();
    const elapsedMs = Date.now() - start;
    assert.ok(
      elapsedMs >= 90,
      `expected the second call to be deferred by ~100ms (spacing floor), only ${elapsedMs}ms elapsed`,
    );
    assert.equal(server.requests.length, 2);
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter: retries within a single fetchSnapshot() call also consume the spacing floor (DESIGN.md §3.2.4 point 4)', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    if (hitCount < 3) {
      res.writeHead(500);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    }
  });
  // minSpacingMs is deliberately large relative to the retry backoff (max
  // 8s cap, base 500ms): the point of this test is that the spacing floor
  // is still binding on retries, not just the first attempt. A tiny
  // minSpacingMs would let the retry loop's own backoff sleep (which also
  // advances the fake clock) satisfy the floor incidentally, masking a
  // regression where beforeAttempt was only wired to the first attempt.
  let deferrals = 0;
  const { adapter } = createHarness({
    baseUrl: `http://127.0.0.1:${server.port}`,
    minSpacingMs: 30_000,
    onRateLimitDeferral: () => {
      deferrals++;
    },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(hitCount, 3, 'expected exactly 3 attempts (2 retries)');
    assert.equal(
      deferrals,
      2,
      'expected the 2nd and 3rd attempts (retries) to also be deferred by the spacing guard',
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 9: 401 -> auth-fatal, no retry storm ---

test('SCC adapter: 401 classifies as auth_fatal, logs loudly, and does not retry', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    res.writeHead(401);
    res.end();
  });
  const { adapter, lines } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    await assert.rejects(adapter.fetchSnapshot(), (err: unknown) => {
      assert.ok(isHttpError(err));
      assert.equal(err.class, 'auth_fatal');
      assert.equal(err.reason, 'auth');
      return true;
    });
    assert.equal(hitCount, 1, 'auth_fatal must not be retried');
    const rawOutput = lines.join('');
    assert.ok(!rawOutput.includes(SECRET_TOKEN));
    const parsed = lines.map((line) => JSON.parse(line.slice(0, -1)));
    assert.ok(
      parsed.some((line) => line.level === 'error'),
      'expected a loud (error-level) log line for the auth failure',
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 10: 429 with Retry-After honored ---

test('SCC adapter: 429 with Retry-After is retried per policy, then exhausted as rate_limited', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    res.writeHead(429, { 'Retry-After': '0' });
    res.end();
  });
  const { adapter } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    await assert.rejects(adapter.fetchSnapshot(), (err: unknown) => {
      assert.ok(isHttpError(err));
      assert.equal(err.class, 'rate_limited');
      assert.equal(err.reason, 'rate_limited');
      return true;
    });
    assert.equal(hitCount, 3, 'expected the max-attempts retry budget to be exhausted on 429');
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 11: 500 -> retried then transient failure ---

test('SCC adapter: 500 is retried per policy, then surfaces as a transient failure', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    res.writeHead(500);
    res.end();
  });
  const { adapter } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    await assert.rejects(adapter.fetchSnapshot(), (err: unknown) => {
      assert.ok(isHttpError(err));
      assert.equal(err.class, 'transient');
      assert.equal(err.reason, 'http_5xx');
      return true;
    });
    assert.equal(hitCount, 3);
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 12: malformed JSON body with 200 -> parse-class error, no crash ---

test('SCC adapter: malformed JSON body with a 200 status is a parse-class error, not a crash', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{not valid json');
  });
  const parseErrors: ParseError[] = [];
  const { adapter } = createHarness({
    baseUrl: `http://127.0.0.1:${server.port}`,
    onParseError: (error) => parseErrors.push(error),
  });
  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.deepEqual(snapshots, []);
    assert.equal(parseErrors.length, 1);
    assert.equal(parseErrors[0]?.group, 'root');
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 13: a 200 with an empty array -> zero snapshots, not an error ---

test('SCC adapter: a 200 with an empty array yields zero snapshots and no parse errors', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const parseErrors: ParseError[] = [];
  const { adapter } = createHarness({
    baseUrl: `http://127.0.0.1:${server.port}`,
    onParseError: (error) => parseErrors.push(error),
  });
  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.deepEqual(snapshots, []);
    assert.equal(parseErrors.length, 0);
  } finally {
    await adapter.close();
    await server.close();
  }
});

// --- Testing step 14: close() destroys the Agent ---

/** Polls until `predicate()` is true or `timeoutMs` elapses — socket teardown after `dispatcher.close()`/`agent.close()` is asynchronous (a TCP FIN round trip), so a single synchronous check right after `await close()` can race a still-closing socket. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true within timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('SCC adapter: close() destroys the Agent; a subsequent fetchSnapshot() fails rather than hanging', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { adapter } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    await adapter.close();
    await assert.rejects(adapter.fetchSnapshot());
  } finally {
    await server.close();
  }
});

test('SCC adapter: close() cleanly releases an adapter-owned Agent — proven by the server-side socket actually closing, not just a subsequent call failing (review F3)', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { logger } = captureLogger();
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'abc-123',
    timeRange: '5m',
    clock: createFakeClock(),
    logger,
    minSpacingMs: 0,
    agent: { minVersion: 'TLSv1.2' },
  });
  try {
    await adapter.init();
    const snapshots = await adapter.fetchSnapshot();
    assert.deepEqual(snapshots, []);
    await waitFor(() => server.liveSocketCount() > 0);
    assert.ok(
      server.liveSocketCount() > 0,
      'expected the keep-alive socket to still be open before close()',
    );

    await adapter.close();

    await waitFor(() => server.liveSocketCount() === 0);
    assert.equal(
      server.liveSocketCount(),
      0,
      "expected close() to have actually torn down the adapter-owned Agent's live socket, not just made a later fetchSnapshot() reject for an unrelated reason",
    );
  } finally {
    await server.close();
  }
});

test('SCC adapter: close() is idempotent on the adapter-owned-Agent path — a second close() does not throw', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { logger } = captureLogger();
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'abc-123',
    timeRange: '5m',
    clock: createFakeClock(),
    logger,
    minSpacingMs: 0,
    agent: { minVersion: 'TLSv1.2' },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    await adapter.close();
    await assert.doesNotReject(adapter.close());
  } finally {
    await server.close();
  }
});

test('SCC adapter: close() is idempotent on the injected-dispatcher path — a second close() does not throw', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { adapter } = createHarness({ baseUrl: `http://127.0.0.1:${server.port}` });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    await adapter.close();
    await assert.doesNotReject(adapter.close());
  } finally {
    await server.close();
  }
});

// --- Token whitespace footgun ---

test('SCC adapter: init() rejects a whitespace-only token', async () => {
  const { logger } = captureLogger();
  const adapter = createSccAdapter({
    baseUrl: 'https://example.invalid',
    apiToken: new Secret('   '),
    fmcUid: 'abc-123',
    timeRange: '5m',
    clock: createFakeClock(),
    logger,
  });
  await assert.rejects(adapter.init());
});

// --- Review F5: init()/fatal-config errors are a classified HttpError, not a bare Error ---

test('SCC adapter: init() rejects a whitespace-only token with a classified fatal_config HttpError', async () => {
  const { logger } = captureLogger();
  const adapter = createSccAdapter({
    baseUrl: 'https://example.invalid',
    apiToken: new Secret('   '),
    fmcUid: 'abc-123',
    timeRange: '5m',
    clock: createFakeClock(),
    logger,
  });
  await assert.rejects(adapter.init(), (err: unknown) => {
    assert.ok(isHttpError(err));
    assert.equal(err.class, 'fatal_config');
    return true;
  });
});

test('SCC adapter: fetchSnapshot() before init() rejects with a classified fatal_config HttpError, not a bare Error', async () => {
  const { logger } = captureLogger();
  const adapter = createSccAdapter({
    baseUrl: 'https://example.invalid',
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'abc-123',
    timeRange: '5m',
    clock: createFakeClock(),
    logger,
  });
  await assert.rejects(adapter.fetchSnapshot(), (err: unknown) => {
    assert.ok(isHttpError(err));
    assert.equal(err.class, 'fatal_config');
    return true;
  });
});

// --- Review F2: a second init() must not orphan the first adapter-owned Agent ---

test('SCC adapter: a second init() call rejects with a classified fatal_config HttpError instead of silently orphaning the first Agent', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { logger } = captureLogger();
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'abc-123',
    timeRange: '5m',
    clock: createFakeClock(),
    logger,
    minSpacingMs: 0,
    agent: { minVersion: 'TLSv1.2' },
  });
  try {
    await adapter.init();
    await assert.rejects(adapter.init(), (err: unknown) => {
      assert.ok(isHttpError(err));
      assert.equal(err.class, 'fatal_config');
      return true;
    });
    // The first (only) Agent must still be the one in use — a single
    // fetchSnapshot() still succeeds through it, and close() releases
    // exactly that Agent's socket (proven the same way as the F3 test).
    await adapter.fetchSnapshot();
    await waitFor(() => server.liveSocketCount() > 0);
    await adapter.close();
    await waitFor(() => server.liveSocketCount() === 0);
    assert.equal(server.liveSocketCount(), 0);
  } finally {
    await server.close();
  }
});

test('SCC adapter: init() trims a token with leading/trailing whitespace and warns, without leaking the token', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  const { logger, lines } = captureLogger();
  const dispatcher = testDispatcher();
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(`  ${SECRET_TOKEN}\n`),
    fmcUid: 'abc-123',
    timeRange: '5m',
    clock: createFakeClock(),
    logger,
    minSpacingMs: 0,
    dispatcher,
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(server.requests[0]?.headers.authorization, `Bearer ${SECRET_TOKEN}`);
    const rawOutput = lines.join('');
    assert.ok(!rawOutput.includes(SECRET_TOKEN));
    const parsed = lines.map((line) => JSON.parse(line.slice(0, -1)));
    assert.ok(parsed.some((line) => line.level === 'warn'));
  } finally {
    await adapter.close();
    await server.close();
  }
});
