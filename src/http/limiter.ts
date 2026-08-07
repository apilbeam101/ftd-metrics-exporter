/**
 * Promise-based concurrency limiter for the FMC backend's
 * `FMC_MAX_CONCURRENT_REQUESTS` cap (DESIGN.md §3.3.4, validated 1-10 in
 * Stage 4). A simple counting semaphore: `run()` queues its callback until
 * a slot is free, so the caller never needs to reason about in-flight
 * count directly. `onDefer` fires exactly once per call that could not
 * start immediately, feeding `ftd_exporter_rate_limit_deferrals_total`.
 */

export interface ConcurrencyLimiterOptions {
  maxConcurrent: number;
  onDefer?: () => void;
}

export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly inFlight: number;
}

export function createConcurrencyLimiter(options: ConcurrencyLimiterOptions): ConcurrencyLimiter {
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new RangeError(`maxConcurrent must be an integer >= 1, got ${options.maxConcurrent}`);
  }

  let inFlight = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    inFlight--;
    const next = queue.shift();
    if (next !== undefined) {
      next();
    }
  }

  function acquire(): Promise<void> {
    if (inFlight < options.maxConcurrent) {
      inFlight++;
      return Promise.resolve();
    }
    options.onDefer?.();
    return new Promise((resolve) => {
      queue.push(() => {
        inFlight++;
        resolve();
      });
    });
  }

  return {
    get inFlight() {
      return inFlight;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
