import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createLifecycle, type ShutdownTarget } from '../../src/lifecycle.ts';
import { createLogger, type Logger } from '../../src/log/logger.ts';

function quietLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  return { logger, lines };
}

/** A `NodeJS.Process`-shaped stand-in so `install()` never touches the real process's signal/exception listeners in a test. */
function fakeProcess(): NodeJS.Process & EventEmitter {
  return new EventEmitter() as unknown as NodeJS.Process & EventEmitter;
}

/** A real macrotask tick (not just a chain of resolved microtasks) — needed after emitting a signal/exception event, since the shutdown sequence's own hard-exit timer is a real `setTimeout` and `guardedStep`'s `await`s cross a genuine async boundary. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Recording {
  serverStopped: number;
  pollerStopped: number;
  backendClosed: number;
}

function harness(overrides: Partial<ShutdownTarget> = {}) {
  const recording: Recording = { serverStopped: 0, pollerStopped: 0, backendClosed: 0 };
  const target: ShutdownTarget = {
    server: {
      stop: async () => {
        recording.serverStopped++;
      },
    },
    poller: {
      stop: () => {
        recording.pollerStopped++;
      },
    },
    backend: {
      close: async () => {
        recording.backendClosed++;
      },
    },
    ...overrides,
  };
  return { target, recording };
}

// --- Testing step 3: SIGTERM stops the server, cancels the poll, closes the backend, exits 0 ---

test('shutdown(): stops the server, stops the poller, closes the backend, and exits with the given code', async () => {
  const { target, recording } = harness();
  const { logger } = quietLogger();
  const exitCodes: number[] = [];
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
  });

  await lifecycle.shutdown(0);

  assert.equal(recording.serverStopped, 1);
  assert.equal(recording.pollerStopped, 1);
  assert.equal(recording.backendClosed, 1);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown(): a signal handler registered via install() triggers the same sequence and exits 0', async () => {
  const { target, recording } = harness();
  const { logger } = quietLogger();
  const exitCodes: number[] = [];
  const proc = fakeProcess();
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
    processRef: proc,
  });

  lifecycle.install();
  proc.emit('SIGTERM');
  // The handler's shutdown() call is async (`void shutdown(0)`) — a real
  // macrotask tick (not just a chain of resolved microtasks) is needed
  // because the sequence's own hard-exit timer is a real `setTimeout`.
  await tick();

  assert.equal(recording.serverStopped, 1);
  assert.equal(recording.pollerStopped, 1);
  assert.equal(recording.backendClosed, 1);
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown(): SIGINT triggers the same graceful sequence as SIGTERM', async () => {
  const { target, recording } = harness();
  const { logger } = quietLogger();
  const exitCodes: number[] = [];
  const proc = fakeProcess();
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
    processRef: proc,
  });

  lifecycle.install();
  proc.emit('SIGINT');
  await tick();

  assert.equal(recording.backendClosed, 1);
  assert.deepEqual(exitCodes, [0]);
});

// --- Testing step: idempotency — a second shutdown call joins the first, never runs twice ---

test('shutdown(): calling it twice concurrently only runs the sequence once', async () => {
  const { target, recording } = harness();
  const { logger } = quietLogger();
  const exitCodes: number[] = [];
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
  });

  await Promise.all([lifecycle.shutdown(0), lifecycle.shutdown(0)]);

  assert.equal(recording.serverStopped, 1);
  assert.equal(recording.backendClosed, 1);
  assert.deepEqual(exitCodes, [0]);
});

// --- Testing step 4: a hung step must not prevent the others from running ---

test('shutdown(): a throwing server.stop() does not prevent poller.stop()/backend.close() from running (no Agent leak on a broken shutdown path)', async () => {
  const { target, recording } = harness({
    server: {
      stop: async () => {
        throw new Error('server.stop() exploded');
      },
    },
  });
  const { logger, lines } = quietLogger();
  const exitCodes: number[] = [];
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
  });

  await lifecycle.shutdown(0);

  assert.equal(
    recording.pollerStopped,
    1,
    'poller.stop() must still run after server.stop() throws',
  );
  assert.equal(
    recording.backendClosed,
    1,
    'backend.close() must still run after server.stop() throws',
  );
  assert.deepEqual(exitCodes, [0]);
  assert.ok(lines.some((l) => l.includes('stopping the metrics server')));
});

test('shutdown(): a throwing backend.close() still exits with the requested code', async () => {
  const { target, recording } = harness({
    backend: {
      close: async () => {
        throw new Error('backend.close() exploded');
      },
    },
  });
  const { logger } = quietLogger();
  const exitCodes: number[] = [];
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
  });

  await lifecycle.shutdown(0);

  assert.equal(recording.serverStopped, 1);
  assert.equal(recording.pollerStopped, 1);
  assert.deepEqual(exitCodes, [0]);
});

// --- Testing step 5: hang-guard — a deliberately stuck close still terminates ---

test('shutdown(): a server.stop() that never resolves is bounded by the hard-exit timer, which force-exits with code 1', async () => {
  const { target, recording } = harness({
    server: {
      stop: () => new Promise(() => {}), // never resolves
    },
  });
  const { logger, lines } = quietLogger();
  const exitCodes: number[] = [];
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
    hardExitTimeoutMs: 20,
  });

  // Deliberately not awaited: in production `exit()` is `process.exit()`,
  // which terminates the process synchronously regardless of whether the
  // in-flight `shutdown()` promise ever settles — a `server.stop()` that
  // never resolves means that promise legitimately never resolves either.
  // Awaiting it here (even with the mocked `exit` below) would hang this
  // test forever, since nothing ever un-sticks the pending `guardedStep`.
  void lifecycle.shutdown(0);
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(exitCodes, [1]);
  assert.equal(
    recording.pollerStopped,
    0,
    'poller.stop() never got a chance to run — stuck at server.stop()',
  );
  assert.ok(lines.some((l) => l.includes('did not complete within')));
});

// --- Testing step 10: an unhandled rejection carrying an Authorization header is logged redacted, and the process exits non-zero ---

test('install(): an unhandledRejection carrying an Authorization header is logged redacted and triggers a non-zero-exit shutdown', async () => {
  const { target } = harness();
  const { logger, lines } = quietLogger();
  const exitCodes: number[] = [];
  const proc = fakeProcess();
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
    processRef: proc,
  });
  lifecycle.install();

  const leaky = new Error('request failed') as Error & Record<string, unknown>;
  leaky.request = { method: 'GET', headers: { authorization: 'Bearer super-secret-token' } };
  proc.emit('unhandledRejection', leaky);
  await tick();

  assert.deepEqual(exitCodes, [1]);
  const joined = lines.join('\n');
  assert.ok(
    !joined.includes('super-secret-token'),
    'token leaked through unhandledRejection logging',
  );
  assert.ok(joined.includes('unhandled rejection'));
});

test('install(): an uncaughtException is logged and triggers a non-zero-exit shutdown', async () => {
  const { target } = harness();
  const { logger, lines } = quietLogger();
  const exitCodes: number[] = [];
  const proc = fakeProcess();
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
    processRef: proc,
  });
  lifecycle.install();

  proc.emit('uncaughtException', new Error('boom'));
  await tick();

  assert.deepEqual(exitCodes, [1]);
  assert.ok(lines.some((l) => l.includes('uncaught exception')));
});

test('install(): an unhandledRejection with a non-Error reason does not throw and still triggers shutdown', async () => {
  const { target } = harness();
  const { logger } = quietLogger();
  const exitCodes: number[] = [];
  const proc = fakeProcess();
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
    processRef: proc,
  });
  lifecycle.install();

  proc.emit('unhandledRejection', 'a plain string rejection reason');
  await tick();

  assert.deepEqual(exitCodes, [1]);
});

// --- Regression: a throwing logger must never crash shutdown or skip backend.close() (Stage 11 review finding 1) ---

function throwingLogger(): Logger {
  const boom = () => {
    throw new Error('logger sink exploded (e.g. EPIPE on a closed stdout)');
  };
  return {
    error: boom,
    warn: boom,
    info: boom,
    debug: boom,
    child: () => throwingLogger(),
  };
}

test('shutdown(): a throwing logger does not crash the process and does not prevent backend.close() from running', async () => {
  const { target, recording } = harness();
  const exitCodes: number[] = [];
  const lifecycle = createLifecycle({
    ...target,
    logger: throwingLogger(),
    exit: (code) => exitCodes.push(code),
  });

  await assert.doesNotReject(() => lifecycle.shutdown(0));

  assert.equal(recording.serverStopped, 1);
  assert.equal(recording.pollerStopped, 1);
  assert.equal(
    recording.backendClosed,
    1,
    'backend.close() must still run even if every log call throws',
  );
  assert.deepEqual(exitCodes, [0]);
});

test('shutdown(): a throwing logger combined with a throwing server.stop() still lets poller.stop()/backend.close() run', async () => {
  const { target, recording } = harness({
    server: {
      stop: async () => {
        throw new Error('server.stop() exploded');
      },
    },
  });
  const exitCodes: number[] = [];
  const lifecycle = createLifecycle({
    ...target,
    logger: throwingLogger(),
    exit: (code) => exitCodes.push(code),
  });

  await assert.doesNotReject(() => lifecycle.shutdown(0));

  assert.equal(recording.pollerStopped, 1);
  assert.equal(recording.backendClosed, 1);
  assert.deepEqual(exitCodes, [0]);
});

test('install(): a throwing logger during a signal handler still runs the full shutdown sequence', async () => {
  const { target, recording } = harness();
  const exitCodes: number[] = [];
  const proc = fakeProcess();
  const lifecycle = createLifecycle({
    ...target,
    logger: throwingLogger(),
    exit: (code) => exitCodes.push(code),
    processRef: proc,
  });

  lifecycle.install();
  proc.emit('SIGTERM');
  await tick();

  assert.equal(recording.backendClosed, 1);
  assert.deepEqual(exitCodes, [0]);
});

// --- Regression: install() must be idempotent (Stage 11 review finding 7) ---

test('install(): calling it twice does not register duplicate signal handlers (one emit -> the shutdown sequence runs once, not twice)', async () => {
  const { target, recording } = harness();
  const { logger } = quietLogger();
  const exitCodes: number[] = [];
  const proc = fakeProcess();
  const lifecycle = createLifecycle({
    ...target,
    logger,
    exit: (code) => exitCodes.push(code),
    processRef: proc,
  });

  lifecycle.install();
  lifecycle.install();
  assert.equal(
    proc.listenerCount('SIGTERM'),
    1,
    'a second install() must not add a second SIGTERM listener',
  );
  assert.equal(proc.listenerCount('uncaughtException'), 1);
  assert.equal(proc.listenerCount('unhandledRejection'), 1);

  proc.emit('SIGTERM');
  await tick();

  assert.equal(recording.serverStopped, 1);
  assert.equal(recording.backendClosed, 1);
  assert.deepEqual(exitCodes, [0]);
});
