import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HealthBackend } from '../../src/backends/types.ts';
import type { DeviceHealthSnapshot } from '../../src/domain/snapshot.ts';
import { HttpError, POLL_ERROR_REASON_VALUES } from '../../src/http/errors.ts';
import { createLogger, type Logger } from '../../src/log/logger.ts';
import { createRegistry } from '../../src/metrics/registry.ts';
import { createSelfMetrics } from '../../src/metrics/self.ts';
import { createMetricsCache } from '../../src/poller/cache.ts';
import {
  createParseErrorTracker,
  createPoller,
  type PollCycleResult,
} from '../../src/poller/poller.ts';
import { createFakeClock, type FakeClock } from './support/fake-clock.ts';

function snapshot(deviceUid: string): DeviceHealthSnapshot {
  return { deviceUid, deviceName: deviceUid };
}

function quietLogger(): Logger {
  return createLogger({ level: 'debug', sink: () => {} });
}

interface FakeBackend extends HealthBackend {
  calls: number;
}

function createFakeBackend(
  fetchImpl: (call: number) => Promise<DeviceHealthSnapshot[]>,
): FakeBackend {
  const backend: FakeBackend = {
    kind: 'scc',
    calls: 0,
    async init() {},
    async fetchSnapshot() {
      backend.calls++;
      return fetchImpl(backend.calls);
    },
    async close() {},
  };
  return backend;
}

function harness() {
  const registry = createRegistry(false);
  const metrics = createSelfMetrics(registry);
  const cache = createMetricsCache();
  return { registry, metrics, cache };
}

/**
 * Synchronizes on real cycle completion (via `onCycleComplete`) rather than
 * guessing a number of `Promise.resolve()` microtask flushes. The fake
 * clock's `sleep()` resolves immediately, which makes the poll loop's
 * `while` loop spin through many microtask ticks per cycle with no real
 * delay — a blind "flush N times" approach either under-counts (assertion
 * fails before enough ticks have run) or, worse, throws *before* the test
 * gets a chance to call `poller.stop()`, leaving the loop spinning forever
 * in the background with nothing left to stop it (a real hang: the fake
 * clock never actually blocks on a timer, so the loop has no natural exit
 * short of the abort signal). Waiting on an explicit per-cycle Promise
 * sidesteps guessing entirely and is what the `try/finally { poller.stop() }`
 * pattern below is paired with to guarantee the loop is always torn down
 * even when an assertion throws.
 *
 * `waitForCycles` races against a real (not fake-clock) 5s timeout so a
 * genuine regression in the code under test (e.g. a `while` loop condition
 * that never re-arms) fails this specific `await` with a named, useful
 * message rather than hanging the entire test file to the runner's
 * default/no timeout — reproduced directly against a mutated `poller.ts`
 * before this fix (the file reported as one opaque 60s-plus failure with no
 * indication of which of the 12 tests, or why).
 */
function createCycleSync() {
  const results: PollCycleResult[] = [];
  const waiters: Array<() => void> = [];

  function onCycleComplete(result: PollCycleResult): void {
    results.push(result);
    const ready = waiters.splice(0, waiters.length);
    for (const resolve of ready) resolve();
  }

  function waitForCycles(n: number): Promise<PollCycleResult[]> {
    if (results.length >= n) return Promise.resolve(results);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `waitForCycles(${n}) timed out after 5 real seconds — only ${results.length} cycle(s) completed`,
          ),
        );
      }, 5_000);
      const check = (): void => {
        if (results.length >= n) {
          clearTimeout(timer);
          resolve(results);
        } else {
          waiters.push(check);
        }
      };
      waiters.push(check);
    });
  }

  return { results, onCycleComplete, waitForCycles };
}

// --- Testing step 1: 5 cycles at a 60s interval -> 5 fetches, cache updated each time, poll_total = 5 ---

test('poller: 5 cycles at a 60s interval produce 5 upstream fetches, and poll_total counts 5', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async (call) => [snapshot(`d${call}`)]);
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    await sync.waitForCycles(5);
    assert.equal(backend.calls, 5);
    assert.equal((await metrics.pollTotal.get()).values[0]?.value, 5);
    assert.deepEqual(cache.get()?.snapshots, [snapshot('d5')]);
  } finally {
    poller.stop();
  }
});

// --- Testing step 2: startup jitter within [0, 6s] for a 60s interval, not always identical ---

test('poller: startup jitter delays the first poll by [0, 10%] of the interval, not always identical', async () => {
  const seen = new Set<number>();
  for (const randomValue of [0, 0.25, 0.5, 0.75, 0.999]) {
    const clock: FakeClock = createFakeClock();
    const { metrics, cache } = harness();
    const backend = createFakeBackend(async () => []);
    const sync = createCycleSync();
    const poller = createPoller({
      backend,
      cache,
      clock,
      logger: quietLogger(),
      pollIntervalSeconds: 60,
      metrics,
      random: () => randomValue,
      onCycleComplete: sync.onCycleComplete,
    });
    try {
      poller.start();
      await sync.waitForCycles(1);
      seen.add(clock.now());
      assert.ok(
        clock.now() >= 0 && clock.now() <= 6_000,
        `jitter ${clock.now()}ms out of [0, 6000] range`,
      );
    } finally {
      poller.stop();
    }
  }
  assert.ok(seen.size > 1, 'jitter must vary with the random source, not be a fixed constant');
});

// --- Testing step 3: a 90s cycle at a 60s interval does not overlap ---

test('poller: a cycle slower than the interval does not overlap — the next cycle starts only after the slow one completes', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  let inFlight = 0;
  let maxConcurrent = 0;
  const backend = createFakeBackend(async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await clock.sleep(90_000);
    inFlight--;
    return [];
  });
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    await sync.waitForCycles(3);
    assert.equal(
      maxConcurrent,
      1,
      'at no point should two fetchSnapshot() calls be in flight at once',
    );
  } finally {
    poller.stop();
  }
});

// --- Testing step 4: stale-serve behavior ---

test('poller: cache continues serving cycle 1s snapshot through cycles 2-4 failing; up=0; cache_age grows; last_successful_poll unchanged', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async (call) => {
    if (call === 1) return [snapshot('stable-device')];
    throw new HttpError({ class: 'transient', reason: 'network', message: 'boom' });
  });
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    await sync.waitForCycles(1);
    const lastSuccessAfterCycle1 = (await metrics.lastSuccessfulPollTimestampSeconds.get())
      .values[0]?.value;
    const cacheAfterCycle1 = cache.get();

    await sync.waitForCycles(4);

    assert.equal(backend.calls, 4);
    assert.equal(
      cache.get(),
      cacheAfterCycle1,
      'the cache entry from cycle 1 must be untouched by later failures',
    );
    assert.deepEqual(cache.get()?.snapshots, [snapshot('stable-device')]);
    assert.equal((await metrics.up.get()).values[0]?.value, 0);
    assert.equal(
      (await metrics.lastSuccessfulPollTimestampSeconds.get()).values[0]?.value,
      lastSuccessAfterCycle1,
      'last_successful_poll_timestamp_seconds must still point at cycle 1, not be cleared or reset',
    );
  } finally {
    poller.stop();
  }
});

// --- Testing step 5: recovery resets backoff factor to 1x immediately ---

test('poller: a successful cycle after failures resets up to 1 and the next delay back to the plain interval', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async (call) => {
    if (call <= 2) throw new HttpError({ class: 'transient', reason: 'network', message: 'boom' });
    return [snapshot('recovered')];
  });
  const cycleStarts: number[] = [];
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: (result) => {
      cycleStarts.push(clock.now());
      sync.onCycleComplete(result);
    },
  });

  try {
    poller.start();
    await sync.waitForCycles(4);
    assert.equal(sync.results[2]?.outcome, 'success');
    assert.equal((await metrics.up.get()).values[0]?.value, 1);

    // gap[2]: delay before cycle 4, scheduled after cycle 3's *success* -> must
    // be the plain 60s interval, not an escalated backoff continuing from
    // cycle 2's failure.
    const gap = (cycleStarts[3] as number) - (cycleStarts[2] as number);
    assert.equal(
      gap,
      60_000,
      'the delay after a successful recovery cycle must be the plain interval, not an escalated backoff',
    );
  } finally {
    poller.stop();
  }
});

// --- Testing step 6: escalating backoff 2x, 4x, 8x capped at 600s ---

test('poller: escalating backoff follows 2x, 4x, 8x on consecutive failures, capped at 600s', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async () => {
    throw new HttpError({ class: 'transient', reason: 'network', message: 'boom' });
  });
  const cycleStarts: number[] = [];
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: (result) => {
      cycleStarts.push(clock.now());
      sync.onCycleComplete(result);
    },
  });

  try {
    poller.start();
    await sync.waitForCycles(5);

    assert.equal(cycleStarts.length, 5);
    const gaps: number[] = [];
    for (let i = 1; i < cycleStarts.length; i++) {
      gaps.push((cycleStarts[i] as number) - (cycleStarts[i - 1] as number));
    }
    // gap[0]: delay before cycle 2, scheduled after cycle 1's failure -> 2x = 120s
    // gap[1]: before cycle 3, after cycle 2's failure -> 4x = 240s
    // gap[2]: before cycle 4, after cycle 3's failure -> 8x = 480s
    // gap[3]: before cycle 5, after cycle 4's failure -> 16x would be 960s, capped at 600s
    assert.equal(gaps[0], 120_000);
    assert.equal(gaps[1], 240_000);
    assert.equal(gaps[2], 480_000);
    assert.equal(gaps[3], 600_000);
  } finally {
    poller.stop();
  }
});

// --- Testing step 8: poll_errors_total{reason} uses only the bounded label set ---

test('poller: poll_errors_total is labeled with the classified reason, from the bounded DESIGN.md §11 set', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async () => {
    throw new HttpError({ class: 'rate_limited', reason: 'rate_limited', message: 'slow down' });
  });
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    await sync.waitForCycles(1);
    const errors = await metrics.pollErrorsTotal.get();
    assert.equal(errors.values.find((v) => v.labels.reason === 'rate_limited')?.value, 1);
  } finally {
    poller.stop();
  }
});

test('poller: a raw non-HttpError thrown by the backend is classified into the bounded reason set, never an ad hoc label', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async () => {
    // classifyNetworkError (errors.ts) maps any plain Error to the bounded
    // reason="network" — this is the poller's fallback path for a backend
    // error that was never routed through classifyStatusCode/classifyNetworkError
    // itself, and it must still land in the DESIGN.md §11 vocabulary, not a
    // label minted from the error's own message/name.
    throw new Error('something totally unexpected');
  });
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    await sync.waitForCycles(1);
    const errors = await metrics.pollErrorsTotal.get();
    assert.equal(errors.values.length, 1);
    assert.ok(
      POLL_ERROR_REASON_VALUES.includes(errors.values[0]?.labels.reason as never),
      `reason "${errors.values[0]?.labels.reason}" must be a member of the bounded DESIGN.md §11 set`,
    );
  } finally {
    poller.stop();
  }
});

// --- Testing step 9: devices_total reflects the snapshot count and drops when devices disappear ---

test('poller: devices_total tracks the current snapshot count and drops when devices disappear', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async (call) =>
    call === 1 ? [snapshot('a'), snapshot('b'), snapshot('c')] : [snapshot('a')],
  );
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    await sync.waitForCycles(1);
    assert.equal((await metrics.devices.get()).values[0]?.value, 3);
    await sync.waitForCycles(2);
    assert.equal((await metrics.devices.get()).values[0]?.value, 1);
  } finally {
    poller.stop();
  }
});

// --- Testing step 12: abort mid-poll leaves the cache unchanged, no unhandled rejection ---

test('poller: aborting mid-poll leaves the cache unchanged and does not update metrics for the discarded cycle', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const controller = new AbortController();
  let resolveFetch: ((snapshots: DeviceHealthSnapshot[]) => void) | undefined;
  let fetchStartedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    fetchStartedResolve = resolve;
  });

  const backend: HealthBackend = {
    kind: 'scc',
    async init() {},
    fetchSnapshot() {
      fetchStartedResolve?.();
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
    async close() {},
  };

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    signal: controller.signal,
  });

  try {
    poller.start();
    await started;
    assert.equal(cache.get(), undefined, 'no cycle has completed yet');

    controller.abort();
    resolveFetch?.([snapshot('too-late')]);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      cache.get(),
      undefined,
      'a cycle whose result arrives after abort must never reach the cache',
    );
    assert.equal((await metrics.pollTotal.get()).values[0]?.value, 0);
  } finally {
    poller.stop();
  }
});

test('poller: stop() before start() prevents any cycle from ever running', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async () => [snapshot('never')]);

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
  });

  poller.stop();
  poller.start();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(backend.calls, 0);
  assert.equal(cache.get(), undefined);
});

test('poller: calling start() twice does not schedule two concurrent loops', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async (call) => [snapshot(`d${call}`)]);
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    poller.start();
    await sync.waitForCycles(3);
    assert.equal(
      backend.calls,
      3,
      'a second start() call must be a no-op, not a second concurrent loop',
    );
  } finally {
    poller.stop();
  }
});

// --- Opus review F1: a resolved zero-device fetchSnapshot() caused by a
// total parse failure must not be treated as a healthy empty snapshot ---

test('poller: a zero-device result accompanied by a recorded parse error is a failure, not a healthy empty snapshot', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const tracker = createParseErrorTracker();
  const backend = createFakeBackend(async () => {
    // Mirrors what both real adapters actually do on a total upstream
    // failure (SCC on an unparseable/non-array body, FMC when every
    // device/family request in the cycle fails): resolve to [], never
    // throw, having already reported the failure via onParseError.
    tracker.record();
    return [];
  });
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    parseErrorTracker: tracker,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    const [result] = await sync.waitForCycles(1);
    assert.equal(
      result?.outcome,
      'failure',
      'a total parse failure must not be reported as success',
    );
    assert.equal(
      cache.get(),
      undefined,
      'nothing should ever be committed to the cache for this cycle',
    );
    assert.equal((await metrics.up.get()).values[0]?.value, 0);
    assert.equal((await metrics.pollErrorsTotal.get()).values[0]?.value, 1);
  } finally {
    poller.stop();
  }
});

test('poller: a genuinely empty fleet (zero devices, zero parse errors) is still a success', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const tracker = createParseErrorTracker();
  const backend = createFakeBackend(async () => []);
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    parseErrorTracker: tracker,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    const [result] = await sync.waitForCycles(1);
    assert.equal(result?.outcome, 'success');
    assert.deepEqual(cache.get()?.snapshots, []);
    assert.equal((await metrics.up.get()).values[0]?.value, 1);
  } finally {
    poller.stop();
  }
});

test('poller: without a parseErrorTracker wired, a zero-device result is still treated as success (documents the caller obligation, not a defect in this module)', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async () => []);
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    const [result] = await sync.waitForCycles(1);
    assert.equal(result?.outcome, 'success');
  } finally {
    poller.stop();
  }
});

// --- Opus review F2: a throw from any post-fetch side effect must not
// become an unhandled rejection or permanently stop the loop ---

/**
 * `waitForFetchCalls` synchronizes on the backend's own `fetchSnapshot()`
 * calls (which run before `onCycleComplete` and are unaffected by it
 * throwing), the same way `createCycleSync` synchronizes on
 * `onCycleComplete` — both resolve via a plain microtask chain from inside
 * `runCycle()`'s own call stack, never via a macrotask (`setTimeout`). This
 * matters concretely: under the fake clock, `abortableSleep()` resolves
 * `clock.sleep()` synchronously, so `loop()`'s `while` loop advances purely
 * through microtasks and never yields to the macrotask queue where a
 * `setTimeout(resolve, 0)`-based polling wait would sit — a `while (cond)
 * await new Promise(r => setTimeout(r, 0))` polling loop in the test itself
 * starves forever under this fake clock (confirmed independently: a
 * standalone microtask-only `while` loop against `Promise.resolve()` never
 * lets a `setTimeout(fn, 0)` callback run in Node, even past its due time).
 */
function waitForFetchCalls(backend: FakeBackend, n: number): Promise<void> {
  if (backend.calls >= n) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `waitForFetchCalls(${n}) timed out after 5 real seconds — only ${backend.calls} call(s) made`,
        ),
      );
    }, 5_000);
    const check = (): void => {
      if (backend.calls >= n) {
        clearTimeout(timer);
        resolve();
      } else {
        queueMicrotask(check);
      }
    };
    queueMicrotask(check);
  });
}

/** Same microtask-polling shape as `waitForFetchCalls`, generalized to an arbitrary predicate. */
function waitForCondition(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('waitForCondition timed out after 5 real seconds'));
    }, 5_000);
    const check = (): void => {
      if (predicate()) {
        clearTimeout(timer);
        resolve();
      } else {
        queueMicrotask(check);
      }
    };
    queueMicrotask(check);
  });
}

test('poller: a throwing onCycleComplete consumer does not stop the loop or leave up frozen healthy', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async (call) => [snapshot(`d${call}`)]);
  let calls = 0;
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: () => {
      calls++;
      throw new Error('onCycleComplete consumer is broken');
    },
  });

  try {
    poller.start();
    // No cycle-sync helper here (it itself depends on onCycleComplete
    // succeeding) — synchronize on the backend's own call count instead,
    // then allow the in-flight cycle's own onCycleComplete call (which
    // runs strictly after that cycle's fetchSnapshot()) one more
    // microtask-driven wait to actually fire.
    await waitForFetchCalls(backend, 3);
    await waitForCondition(() => calls >= 3);
    assert.equal(
      backend.calls,
      3,
      'the loop must keep scheduling cycles despite the throwing consumer',
    );
    assert.equal(calls, 3);
    assert.equal(unhandledRejections.length, 0, 'no unhandled rejection must escape start()');
  } finally {
    poller.stop();
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('poller: a throwing default-shaped logger sink does not stop the loop', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async (call) => [snapshot(`d${call}`)]);
  const brokenLogger = createLogger({
    level: 'debug',
    sink: () => {
      throw new Error('EPIPE-like sink failure');
    },
  });
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: brokenLogger,
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
  });

  try {
    poller.start();
    await waitForFetchCalls(backend, 3);
    assert.equal(
      backend.calls,
      3,
      'the loop must keep scheduling cycles despite the broken logger sink',
    );
    assert.equal(unhandledRejections.length, 0);
  } finally {
    poller.stop();
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

// --- Opus review F4: an out-of-vocabulary reason must be re-bounded to "unknown" ---

test('poller: an HttpError carrying an out-of-vocabulary reason is re-bounded to "unknown" on poll_errors_total', async () => {
  const clock = createFakeClock();
  const { metrics, cache } = harness();
  const backend = createFakeBackend(async () => {
    throw new HttpError({
      class: 'transient',
      // Cast past the type system to simulate a value that type-checks
      // today but reaches this boundary through an `unknown`-typed catch or
      // a future taxonomy change (POLL_ERROR_REASON_VALUES's own doc
      // comment) — this must not mint a new label value on the exporter's
      // own poll_errors_total.
      reason: 'device-00000000-0000-4000-8000-000000000abc-failed' as never,
      message: 'boom',
    });
  });
  const sync = createCycleSync();

  const poller = createPoller({
    backend,
    cache,
    clock,
    logger: quietLogger(),
    pollIntervalSeconds: 60,
    metrics,
    random: () => 0,
    onCycleComplete: sync.onCycleComplete,
  });

  try {
    poller.start();
    await sync.waitForCycles(1);
    const errors = await metrics.pollErrorsTotal.get();
    assert.equal(errors.values.length, 1);
    assert.equal(errors.values[0]?.labels.reason, 'unknown');
  } finally {
    poller.stop();
  }
});
