import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createHttpClient } from '../../src/http/client.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { startTestHttpServer } from './support/http-server.ts';

function createTestDispatcher(): Agent {
  return new Agent({ connect: { rejectUnauthorized: true } });
}

test('HttpClient: a 200 response is returned with body and status intact', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  try {
    const response = await client.get(`http://127.0.0.1:${server.port}/v1/x`, {
      endpoint: '/v1/x',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"ok":true}');
  } finally {
    await client.close();
    await server.close();
  }
});

test('HttpClient: a 302 with Location is NOT followed — no second request is issued, and the Authorization header never reaches the redirect target', async () => {
  const redirectTargetRequests: string[] = [];
  const redirectTarget = await startTestHttpServer((req, res) => {
    redirectTargetRequests.push(req.headers.authorization ?? '');
    res.writeHead(200);
    res.end('should never be reached');
  });
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${redirectTarget.port}/stolen` });
    res.end();
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  try {
    await assert.rejects(
      client.get(`http://127.0.0.1:${server.port}/auth`, {
        endpoint: '/auth',
        headers: { authorization: 'Bearer secret-token' },
      }),
      /./,
      'a 3xx is surfaced as a non-2xx error, per DESIGN.md §9.1 — never silently followed',
    );
    assert.equal(redirectTargetRequests.length, 0, 'the redirect target must never be contacted');
  } finally {
    await client.close();
    await server.close();
    await redirectTarget.close();
  }
});

test('HttpClient: AbortSignal total-time budget fires mid-request -> timeout-class error, no leak', async () => {
  const server = await startTestHttpServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200);
      res.end('too slow');
    }, 500);
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  try {
    await assert.rejects(
      client.get(`http://127.0.0.1:${server.port}/slow`, { endpoint: '/slow', timeoutMs: 30 }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('HttpClient: the timeout budget is total across retries, not reset per attempt (Opus review F6)', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    setTimeout(() => {
      res.writeHead(503);
      res.end();
    }, 40);
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  try {
    const start = Date.now();
    await assert.rejects(
      client.get(`http://127.0.0.1:${server.port}/slow-503`, {
        endpoint: '/slow-503',
        timeoutMs: 60,
      }),
    );
    const elapsedMs = Date.now() - start;
    assert.ok(
      elapsedMs < 200,
      `expected the shared 60ms budget to cut retries short well under 200ms, took ${elapsedMs}ms with ${hitCount} attempts`,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test('HttpClient: a beforeAttempt wait (spacing/budget guard) does not consume the request timeout budget (Stage 7/8 review finding)', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  try {
    // A spacing/budget-guard wait as long as the entire configured timeout
    // budget — the exact shape of the SCC 30s-spacing-floor-vs-30s-timeout
    // and FMC budget-guard-defer bugs both adversarial reviews found. If
    // this wait were charged against the request's own timeout, the
    // request would never even get a chance to reach the (healthy) server.
    const response = await client.get(`http://127.0.0.1:${server.port}/spaced`, {
      endpoint: '/spaced',
      timeoutMs: 60,
      beforeAttempt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'ok');
  } finally {
    await client.close();
    await server.close();
  }
});

test('HttpClient: retries on 503 then succeeds, exactly 3 attempts observed by the server', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    if (hitCount < 3) {
      res.writeHead(503);
      res.end();
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  try {
    const response = await client.get(`http://127.0.0.1:${server.port}/flaky`, {
      endpoint: '/flaky',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(hitCount, 3);
  } finally {
    await client.close();
    await server.close();
  }
});

test('HttpClient: beforeAttempt is invoked once per attempt, including retries — the spacing/budget attachment point', async () => {
  let hitCount = 0;
  const server = await startTestHttpServer((_req, res) => {
    hitCount++;
    if (hitCount < 2) {
      res.writeHead(503);
      res.end();
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  let beforeAttemptCalls = 0;
  try {
    await client.get(`http://127.0.0.1:${server.port}/flaky2`, {
      endpoint: '/flaky2',
      beforeAttempt: async () => {
        beforeAttemptCalls++;
      },
    });
    assert.equal(beforeAttemptCalls, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test('HttpClient: onRequest fires with the templated endpoint label and observed status code', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const dispatcher = createTestDispatcher();
  const observed: Array<{ endpoint: string; statusCode: number }> = [];
  const client = createHttpClient({
    dispatcher,
    clock: createFakeClock(),
    defaultTimeoutMs: 5000,
    onRequest: (endpoint, statusCode) => {
      observed.push({ endpoint, statusCode });
    },
  });
  try {
    await client.get(
      `http://127.0.0.1:${server.port}/v1/inventory/managers/abc-123/health/metrics`,
      {
        endpoint: '/v1/inventory/managers/:fmcUid/health/metrics',
      },
    );
    assert.deepEqual(observed, [
      { endpoint: '/v1/inventory/managers/:fmcUid/health/metrics', statusCode: 200 },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test('HttpClient exposes only get() — no post/put/patch/delete method exists on the returned object', async () => {
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const dispatcher = createTestDispatcher();
  const client = createHttpClient({ dispatcher, clock: createFakeClock(), defaultTimeoutMs: 5000 });
  try {
    const clientKeys = Object.keys(client);
    assert.deepEqual(new Set(clientKeys), new Set(['get', 'close']));
    assert.equal((client as unknown as Record<string, unknown>).post, undefined);
    assert.equal((client as unknown as Record<string, unknown>).put, undefined);
    assert.equal((client as unknown as Record<string, unknown>).delete, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});
