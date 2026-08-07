import type { Registry } from 'prom-client';
import type { HealthBackend } from '../../../src/backends/types.ts';
import { type Clock, createRealClock } from '../../../src/http/clock.ts';
import { createLogger } from '../../../src/log/logger.ts';
import { renderDeviceMetrics } from '../../../src/metrics/collector.ts';
import { createDeviceMetrics, type DeviceMetrics } from '../../../src/metrics/device-metrics.ts';
import { createRegistry } from '../../../src/metrics/registry.ts';
import { createSelfMetrics, type SelfMetrics } from '../../../src/metrics/self.ts';
import {
  cacheAgeSecondsCollector,
  createMetricsCache,
  type MetricsCache,
} from '../../../src/poller/cache.ts';
import {
  createParseErrorTracker,
  createPoller,
  type ParseErrorTracker,
  type PollCycleResult,
  type Poller,
} from '../../../src/poller/poller.ts';
import {
  createSelfMetricsRecorder,
  type SelfMetricsRecorder,
} from '../../../src/poller/self-metrics.ts';
import { createServer, type MetricsServer } from '../../../src/server/server.ts';

/**
 * Full-stack integration harness (IMPLEMENTATION_PLAN.md Stage 12): wires
 * the same pieces `src/index.ts` wires — registry, self-metrics, device
 * metrics, cache, poller, HTTP server — around a caller-supplied
 * `HealthBackend`, in the same order (`server.start()` before
 * `backend.init()` before `poller.start()`, per Stage 11's DESIGN.md §7.2
 * liveness-ordering finding). Tests construct their own mock upstream and
 * backend adapter (real `createSccAdapter`/`createFmcAdapter`, pointed at a
 * local mock server), then hand it to `createTestApp` to get a scrapable
 * `/metrics` endpoint and direct access to the self-metrics registry.
 *
 * `createTestMetrics` is split out from `createTestApp` because a test that
 * wants discovery/parse-error hooks wired (e.g. the partial-failure and
 * pagination scenarios) must construct those hooks *before* the backend
 * adapter exists — `createSelfMetricsRecorder`'s callbacks are passed into
 * the adapter's own constructor options — but the harness itself needs the
 * backend already constructed. Splitting metrics-creation from app-wiring
 * breaks that circular dependency the same way `src/index.ts` does it.
 */

export interface TestMetrics {
  registry: Registry;
  cache: MetricsCache;
  selfMetrics: SelfMetrics;
  deviceMetrics: DeviceMetrics;
  parseErrorTracker: ParseErrorTracker;
  recorder: SelfMetricsRecorder;
}

export function createTestMetrics(clock: Clock): TestMetrics {
  const registry = createRegistry(false);
  const cache = createMetricsCache();
  const selfMetrics = createSelfMetrics(registry, {
    cacheAgeSecondsCollect: cacheAgeSecondsCollector(cache, clock),
  });
  const deviceMetrics = createDeviceMetrics(registry);
  const parseErrorTracker = createParseErrorTracker();
  const recorder = createSelfMetricsRecorder(selfMetrics);
  return { registry, cache, selfMetrics, deviceMetrics, parseErrorTracker, recorder };
}

export interface CreateTestAppOptions {
  backend: HealthBackend;
  metrics: TestMetrics;
  pollIntervalSeconds: number;
  clock?: Clock;
  random?: () => number;
  maxBackoffMs?: number;
  /**
   * Stops the poller as soon as this many cycles have completed, from
   * *inside* the synchronous onCycleComplete callback rather than a test
   * separately noticing via waitForCycles and calling stopPoller() itself.
   * That two-step version has a real, reproduced-on-CI gap: waitForCycles
   * polls on a 10ms real-timer interval, so at a short pollIntervalSeconds
   * (e.g. soak.test.ts's 0.02s) the poller's own loop can start and
   * complete another cycle before the test's polling loop ever wakes up to
   * call stopPoller(). Per src/poller/poller.ts's own loop(): runCycle()
   * calls onCycleComplete synchronously as its last step, then loop()
   * immediately re-checks controller.signal.aborted before scheduling the
   * next abortableSleep -- so a synchronous poller.stop() from inside this
   * callback closes the window completely, with no gap for a next cycle to
   * start in.
   */
  stopAfterCycles?: number;
}

export interface ScrapeResult {
  statusCode: number;
  body: string;
  headers: Headers;
}

export interface TestApp {
  server: MetricsServer;
  poller: Poller;
  backend: HealthBackend;
  port: number;
  logLines: string[];
  results: PollCycleResult[];
  scrape(path?: string): Promise<ScrapeResult>;
  /** Waits until at least `n` poll cycles have completed (real-timer polling — these tests run against real network I/O, not a fake clock). Rejects after `timeoutMs` (default 5s) rather than hanging a broken test forever. */
  waitForCycles(n: number, timeoutMs?: number): Promise<PollCycleResult[]>;
  stopPoller(): void;
  /** server.stop() -> poller.stop() -> backend.close(), mirroring lifecycle.ts's shutdown order. */
  stop(): Promise<void>;
}

export function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor: condition never became true within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

export async function createTestApp(options: CreateTestAppOptions): Promise<TestApp> {
  const clock = options.clock ?? createRealClock();
  const { registry, cache, selfMetrics, deviceMetrics, parseErrorTracker } = options.metrics;
  const logLines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => logLines.push(line),
  });

  const server = createServer({
    bindAddress: '127.0.0.1',
    port: 0,
    registry,
    isAlive: () => true,
    isReady: () => cache.get() !== undefined,
    renderMetrics: () => {
      const entry = cache.get();
      renderDeviceMetrics(
        {
          metrics: deviceMetrics,
          unknownEnumTotal: selfMetrics.unknownEnumTotal,
          series: selfMetrics.series,
        },
        entry?.snapshots ?? [],
      );
    },
  });
  const bound = await server.start();

  // Mirrors src/index.ts's own failed-init() handling: a rejecting init()
  // must not leave the metrics server listening with no handle left for
  // the caller to close, or a test whose backend.init() is expected to
  // reject (e.g. a TLS-trust-failure scenario) leaks a live server/socket
  // across the rest of the suite.
  try {
    await options.backend.init();
  } catch (cause) {
    await server.stop();
    await options.backend.close();
    throw cause;
  }

  const results: PollCycleResult[] = [];
  const poller = createPoller({
    backend: options.backend,
    cache,
    clock,
    logger,
    pollIntervalSeconds: options.pollIntervalSeconds,
    metrics: selfMetrics,
    parseErrorTracker,
    random: options.random ?? (() => 0),
    ...(options.maxBackoffMs !== undefined && { maxBackoffMs: options.maxBackoffMs }),
    onCycleComplete: (result) => {
      results.push(result);
      if (options.stopAfterCycles !== undefined && results.length >= options.stopAfterCycles) {
        poller.stop();
      }
    },
  });
  poller.start();

  return {
    server,
    poller,
    backend: options.backend,
    port: bound.port,
    logLines,
    results,
    async scrape(path = '/metrics'): Promise<ScrapeResult> {
      const res = await fetch(`http://127.0.0.1:${bound.port}${path}`);
      const body = await res.text();
      return { statusCode: res.status, body, headers: res.headers };
    },
    waitForCycles(n: number, timeoutMs = 5_000): Promise<PollCycleResult[]> {
      return waitFor(() => results.length >= n, timeoutMs).then(() => results);
    },
    stopPoller(): void {
      poller.stop();
    },
    async stop(): Promise<void> {
      await server.stop();
      poller.stop();
      await options.backend.close();
    },
  };
}
