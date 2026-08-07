import type { Logger } from './log/logger.ts';

/**
 * Graceful shutdown (DESIGN.md §6.2, plan Stage 11 scope): `SIGTERM`/
 * `SIGINT` stop the HTTP server from accepting new connections, cancel the
 * in-flight poll, close the backend (destroying its `undici` Agent), and
 * exit 0 — in that order, matching the plan's explicit sequencing.
 *
 * `poller.stop()` already does exactly what the plan calls "cancel the
 * in-flight poll via `AbortSignal`" — `createPoller` (poller.ts) builds its
 * own internal `AbortController` and `stop()` aborts it; this module does
 * not need a second one.
 *
 * A hard-exit timer is the backstop the plan calls for ("a hard-exit timer
 * (e.g. 10s) guarantees termination if something hangs"). It also
 * incidentally resolves a gap poller.ts's own doc comment flags explicitly:
 * `abortableSleep`'s underlying real `setTimeout` is never cancelled, so a
 * poll cycle mid-backoff (up to the 10-minute cap) leaves a real, ref'd
 * timer pending after `stop()` returns. That timer cannot block an explicit
 * `process.exit()` — `exit()` terminates immediately regardless of any
 * pending timer — so calling `exit()` at the end of a *successful* graceful
 * sequence, rather than letting the event loop drain naturally, is what
 * actually closes that gap for this process; the hard-exit timer below
 * additionally guarantees termination even if the graceful sequence itself
 * hangs (e.g. a `backend.close()` that never resolves).
 *
 * Every call into `logger` in this module is itself wrapped in `safely()`
 * (mirroring poller.ts's identical-purpose helper) — an independent review
 * of this stage found that a throwing logger (e.g. `EPIPE` on a closed
 * stdout, the exact scenario poller.ts's own doc comment already names)
 * inside a signal or `uncaughtException`/`unhandledRejection` listener
 * propagates out of that listener as an uncaught exception with no promise
 * boundary, which crashes the process immediately and skips every step
 * after the throwing log call — `server.stop()`/`poller.stop()` maybe run,
 * but `backend.close()` (which destroys the `undici` Agent) can easily be
 * the step that never does. The handler installed specifically to make
 * shutdown graceful must not itself be a way to skip it.
 */

export interface ShutdownTarget {
  server: { stop(): Promise<void> };
  poller: { stop(): void };
  backend: { close(): Promise<void> };
}

export interface LifecycleOptions extends ShutdownTarget {
  logger: Logger;
  /** Defaults to `process.exit`. Test hook. */
  exit?: (code: number) => void;
  /** Milliseconds before the hard-exit backstop fires regardless of shutdown progress. Default 10s (plan Stage 11 scope). */
  hardExitTimeoutMs?: number;
  /** Defaults to `['SIGTERM', 'SIGINT']`. Test hook. */
  signals?: readonly NodeJS.Signals[];
  /** Defaults to `process`. Test hook so a unit test never registers real process-level signal/exception handlers. */
  processRef?: NodeJS.Process;
}

export interface Lifecycle {
  /** Registers signal and uncaught-exception/-rejection handlers. Idempotent: a second call is a no-op, so this module's own listeners are never registered twice on the shared `process` object. */
  install(): void;
  /** Runs the shutdown sequence and calls `exit(exitCode)`. Idempotent: a second call while shutdown is already in progress returns the same in-flight promise rather than running the sequence twice. */
  shutdown(exitCode: number): Promise<void>;
}

const DEFAULT_HARD_EXIT_TIMEOUT_MS = 10_000;
const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const hardExitTimeoutMs = options.hardExitTimeoutMs ?? DEFAULT_HARD_EXIT_TIMEOUT_MS;
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const proc = options.processRef ?? process;

  let shutdownPromise: Promise<void> | undefined;
  let installed = false;

  /** Never lets a throw (from the wrapped `fn`, or from logging about a prior failure) escape — see this module's doc comment. */
  function safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // There is deliberately no further fallback here: this function's
      // entire purpose is to guarantee it cannot itself become the reason
      // shutdown stalls, and a logging call is the only kind of side
      // effect it is ever used for in this module.
    }
  }

  /**
   * Each step is individually guarded so a failure in one (e.g. a hung or
   * throwing `server.stop()`) cannot skip the steps after it — in
   * particular, `backend.close()` (which destroys the `undici` Agent) must
   * still run even if an earlier step failed, or a broken shutdown path
   * leaks the Agent's live sockets. Mirrors poller.ts's `safely()` pattern
   * for the identical reason: "every side effect ... is individually
   * wrapped so one broken consumer ... cannot become an unhandled
   * rejection" — here, so one broken step cannot suppress the others.
   */
  async function guardedStep(description: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (cause) {
      safely(() =>
        options.logger.error(`shutdown: ${description} failed`, {
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
  }

  function runShutdownSequence(exitCode: number): Promise<void> {
    return (async () => {
      let hardExitFired = false;
      const hardExitTimer = setTimeout(() => {
        hardExitFired = true;
        safely(() =>
          options.logger.error(
            `shutdown did not complete within ${hardExitTimeoutMs}ms — forcing exit`,
          ),
        );
        exit(1);
      }, hardExitTimeoutMs);

      await guardedStep('stopping the metrics server', () => options.server.stop());
      await guardedStep('stopping the poller', () => {
        options.poller.stop();
        return Promise.resolve();
      });
      await guardedStep('closing the backend', () => options.backend.close());

      clearTimeout(hardExitTimer);
      if (!hardExitFired) {
        exit(exitCode);
      }
    })();
  }

  function shutdown(exitCode: number): Promise<void> {
    shutdownPromise ??= runShutdownSequence(exitCode);
    return shutdownPromise;
  }

  return {
    install(): void {
      if (installed) {
        return;
      }
      installed = true;
      for (const signal of signals) {
        proc.on(signal, () => {
          safely(() => options.logger.info(`received ${signal} — starting graceful shutdown`));
          void shutdown(0);
        });
      }
      // DESIGN.md §9.4: an unhandled rejection/exception can carry a raw
      // request (headers included) as an attached property — routed through
      // the logger, which redacts at the boundary, rather than printed by
      // Node's own default handler (which would bypass redaction entirely).
      proc.on('uncaughtException', (error) => {
        safely(() => options.logger.error('uncaught exception', error));
        void shutdown(1);
      });
      proc.on('unhandledRejection', (reason) => {
        safely(() =>
          options.logger.error(
            'unhandled rejection',
            reason instanceof Error ? reason : { reason },
          ),
        );
        void shutdown(1);
      });
    },
    shutdown,
  };
}
