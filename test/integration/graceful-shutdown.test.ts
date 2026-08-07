import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gauge } from 'prom-client';
import { Agent, request as undiciRequest } from 'undici';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLifecycle } from '../../src/lifecycle.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startTestHttpServer } from '../unit/support/http-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * DESIGN.md §12.2 testing step 12, at process level: scrape in a loop, then
 * trigger graceful shutdown, and assert a clean exit with no dropped
 * in-flight response. Drives the real `createLifecycle` (server.stop() ->
 * poller.stop() -> backend.close()) against a fake `NodeJS.Process`
 * `EventEmitter`, the same technique `lifecycle.test.ts` and
 * `dist-smoke.test.ts` already use — real `SIGTERM` delivery to a Node.js
 * child is not observable via `child_process.kill()` on Windows (confirmed
 * empirically, see dist-smoke.test.ts's own note), so this is the
 * platform-independent way to exercise the identical shutdown code path
 * end to end against a real server/poller/backend rather than fakes.
 *
 * A request only qualifies as genuinely "in-flight" at the instant
 * `server.stop()`/`http.Server.close()` runs if its socket has already
 * been accepted and its response has not yet been written — with no
 * artificial delay, a burst of `fetch()` calls dispatched synchronously
 * right before `emit('SIGTERM')` mostly haven't even completed their TCP
 * handshake yet (confirmed by first writing this test without a delay: zero
 * of 8 scrapes succeeded, because `server.close()` ran before any of them
 * connected). A slow `async collect()` gauge on the registry — the same
 * technique `server.test.ts`'s "Finding 4" concurrent-render test uses —
 * deterministically holds each `/metrics` response open long enough that
 * `SIGTERM`, fired a few ms later, unambiguously lands mid-request.
 *
 * Requests are issued via `undici.request` with an explicit `Connection:
 * close` header, not the harness's `fetch()`-based `scrape()` helper —
 * `fetch`'s implicit keep-alive socket stays open after the response
 * completes, and `http.Server.close()` (`server.stop()`) does not resolve
 * until every connection, including an idle kept-alive one, actually
 * closes. Confirmed directly: with keep-alive sockets, `server.stop()`
 * hung for the full `DEFAULT_KEEP_ALIVE_TIMEOUT_MS` (10s) before
 * `exit(0)` was ever called, well past this test's own assertions.
 * `Connection: close` makes the server close the socket immediately after
 * writing the response, which is also what a real Prometheus/Alloy
 * scraper's short-lived per-scrape connection does in practice.
 */

function loadFixtureText(relativePath: string): string {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return readFileSync(`${fixturesDir}/${relativePath}`, 'utf8');
}

function createFakeProcess(): NodeJS.Process {
  return new EventEmitter() as unknown as NodeJS.Process;
}

test('graceful shutdown under load: in-flight scrapes complete, the server stops accepting new connections, and exit(0) is called', async () => {
  const body = loadFixtureText('scc/full-live.json');
  const server = await startTestHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const metrics = createTestMetrics(createRealClock());
  new Gauge({
    name: 'zzz_shutdown_delay',
    help: 'test-only: holds every /metrics response open long enough to land mid-shutdown deterministically',
    registers: [metrics.registry],
    async collect() {
      await new Promise((resolve) => setTimeout(resolve, 100));
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

  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 30 });
  try {
    await app.waitForCycles(1);

    const logger = createLogger({ level: 'debug', sink: () => {} });
    const exitCalls: number[] = [];
    const fakeProcess = createFakeProcess();
    const lifecycle = createLifecycle({
      server: app.server,
      poller: app.poller,
      backend: app.backend,
      logger,
      exit: (code) => exitCalls.push(code),
      processRef: fakeProcess,
    });
    lifecycle.install();

    // Each of these takes >= 100ms (the slow collect() hook above) — by the
    // time SIGTERM fires 20ms later, every one is genuinely in-flight
    // (socket accepted, request received, response not yet written).
    // Connection: close so the socket doesn't linger keep-alive past its
    // own response and block server.stop() from resolving.
    const scrapePromises = Array.from({ length: 5 }, () =>
      undiciRequest(`http://127.0.0.1:${app.port}/metrics`, {
        headers: { connection: 'close' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    fakeProcess.emit('SIGTERM');

    const results = await Promise.all(scrapePromises);
    for (const res of results) {
      await res.body.text();
      assert.equal(
        res.statusCode,
        200,
        'a request already in-flight when shutdown began must still complete successfully, not be dropped',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(exitCalls, [0], 'graceful shutdown must call exit(0) exactly once');

    // The server must now be refusing new connections.
    await assert.rejects(
      undiciRequest(`http://127.0.0.1:${app.port}/metrics`, {
        headers: { connection: 'close' },
      }),
    );
  } finally {
    // app.stop() is idempotent (poller.stop()/server.stop()/backend.close()
    // all tolerate an already-stopped state) and must run even if an
    // assertion above throws — otherwise a failed assertion here leaks the
    // still-listening metrics server and the still-running poller, which
    // was confirmed to hang the entire test runner past its timeout.
    await app.stop();
    await server.close();
  }
});
