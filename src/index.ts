#!/usr/bin/env node
import { createBackend } from './backend-factory.ts';
import { HELP_TEXT, parseCli } from './cli.ts';
import { loadConfig } from './config/load.ts';
import { formatConfigSummary } from './config/redact-summary.ts';
import { dumpRaw } from './dump-raw.ts';
import { createRealClock } from './http/clock.ts';
import { createLifecycle } from './lifecycle.ts';
import { createLogger } from './log/logger.ts';
import { renderDeviceMetrics } from './metrics/collector.ts';
import { createDeviceMetrics } from './metrics/device-metrics.ts';
import { createRegistry } from './metrics/registry.ts';
import { createSelfMetrics } from './metrics/self.ts';
import { assertSupportedNodeVersion } from './node-version-check.ts';
import { cacheAgeSecondsCollector, createMetricsCache } from './poller/cache.ts';
import { createParseErrorTracker, createPoller } from './poller/poller.ts';
import {
  createSelfMetricsRecorder,
  setBuildInfo,
  setTlsVerificationDisabled,
} from './poller/self-metrics.ts';
import { createServer } from './server/server.ts';
import { COMMIT, NODE_VERSION, VERSION } from './version.ts';

/**
 * Startup sequence (DESIGN.md §2.4/§5.2/§9.6, plan Stage 11 scope), in the
 * documented order:
 *
 * 1. Node version check.
 * 2. Load + validate + freeze config; exit non-zero on any failure.
 * 3. Construct the logger; emit the redacted effective-config summary.
 * 4. `FMC_TLS_INSECURE_SKIP_VERIFY` loud warning + `tls_verification_disabled` metric.
 * 5. `build_info`; optional `collectDefaultMetrics()`.
 * 6. Construct the one backend (construction only — no I/O; both adapters
 *    allocate nothing until `init()` is called).
 * 7. Start the HTTP server — *before* `backend.init()`, not just before the
 *    poller. DESIGN.md §7.2 requires `/healthz` to never depend on upstream
 *    health, and an independent review of an earlier draft of this stage
 *    found that awaiting `backend.init()` first left `/healthz`
 *    unanswerable for the entire duration of a slow or hanging FMC login +
 *    discovery — measured at several seconds against a blackholed host,
 *    and unbounded in the worst case. Starting the server first (it needs
 *    only the registry/cache closures already constructed above, nothing
 *    from the backend) means `/healthz` answers as soon as the process is
 *    listening, and `/readyz` correctly reports 503 for as long as
 *    `init()`/the first poll takes.
 * 8. Construct the poller (construction only — no scheduling until
 *    `start()`) and call `lifecycle.install()`, both *before*
 *    `backend.init()`, not after. A real CI run found the gap this
 *    ordering closes: with signal handlers installed only once `init()`
 *    had already succeeded, a `SIGTERM`/`SIGINT` arriving during the
 *    (potentially slow/hanging, per point 7 above) `init()` call had no
 *    handler registered at all, so Node's default signal handling
 *    terminated the process directly instead of running the documented
 *    graceful-shutdown sequence.
 * 9. `backend.init()`. On failure, `lifecycle.shutdown(1)` runs the same
 *    guarded stop-server/stop-poller/close-backend sequence a signal would
 *    have triggered (poller.stop() is a no-op here, since `start()` is
 *    never reached on this path) rather than a separate ad hoc sequence,
 *    so a failed startup does not leave an orphaned listener.
 * 10. Start the poller (with its own internal startup jitter).
 */

function exitWithError(message: string): never {
  process.stderr.write(`${JSON.stringify({ level: 'error', message })}\n`);
  process.exit(1);
}

function errorMeta(cause: unknown): { error: string } {
  return { error: cause instanceof Error ? cause.message : String(cause) };
}

async function main(): Promise<void> {
  assertSupportedNodeVersion(NODE_VERSION);

  const cli = parseCli(process.argv.slice(2));
  if (cli.mode === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (cli.mode === 'help') {
    process.stdout.write(HELP_TEXT);
    return;
  }

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig();
  } catch (cause) {
    exitWithError(cause instanceof Error ? cause.message : String(cause));
  }
  const { config, warnings } = loaded;

  // `--dump-raw`'s entire output contract is "sanitized JSON on stdout,
  // nothing else" (DESIGN.md §3.3.5) — every other log line in this mode
  // must go to stderr instead, or it interleaves with (and, depending on
  // buffering order, can land inside) the JSON a contributor is about to
  // paste into a GitHub issue or fixture file. The normal run keeps
  // logging to stdout (DESIGN.md §2.6), since there is no competing
  // machine-readable stream to protect there.
  const logger =
    cli.mode === 'dump-raw'
      ? createLogger({
          level: config.logLevel,
          format: config.logFormat,
          sink: (line) => process.stderr.write(line),
        })
      : createLogger({ level: config.logLevel, format: config.logFormat });
  logger.info(formatConfigSummary(config));
  for (const warning of warnings) {
    if (warning.severity === 'error') {
      logger.error(warning.message);
    } else {
      logger.warn(warning.message);
    }
  }

  const tlsVerificationDisabled =
    config.backend.kind === 'fmc' && config.backend.tlsInsecureSkipVerify;

  const clock = createRealClock();
  const cache = createMetricsCache();
  const registry = createRegistry(config.enableDefaultMetrics);
  const selfMetrics = createSelfMetrics(registry, {
    cacheAgeSecondsCollect: cacheAgeSecondsCollector(cache, clock),
  });
  setBuildInfo(selfMetrics, {
    version: VERSION,
    commit: COMMIT,
    node_version: NODE_VERSION,
    backend: config.backend.kind,
  });
  setTlsVerificationDisabled(selfMetrics, tlsVerificationDisabled);

  if (cli.mode === 'dump-raw') {
    await dumpRaw({ config, logger });
    return;
  }

  const deviceMetrics = createDeviceMetrics(registry);
  const parseErrorTracker = createParseErrorTracker();
  const selfMetricsRecorder = createSelfMetricsRecorder(selfMetrics);

  const backend = createBackend({
    config,
    clock,
    logger,
    pollIntervalSeconds: config.pollIntervalSeconds,
    hooks: {
      onParseError: (error) => {
        parseErrorTracker.record();
        selfMetricsRecorder.onParseError(error);
      },
      onRateLimitDeferral: selfMetricsRecorder.onRateLimitDeferral,
      onUpstreamRequest: selfMetricsRecorder.onUpstreamRequest,
      onTokenRefresh: selfMetricsRecorder.onTokenRefresh,
      onTokenReauth: selfMetricsRecorder.onTokenReauth,
      onTokenExpiryUpdate: selfMetricsRecorder.onTokenExpiryUpdate,
      onDiscoverySuccess: selfMetricsRecorder.onDiscoverySuccess,
      onDiscoveryFailure: selfMetricsRecorder.onDiscoveryFailure,
    },
  });

  const server = createServer({
    bindAddress: config.metricsBindAddress,
    port: config.metricsPort,
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
    ...(config.metricsTls !== undefined && { tls: config.metricsTls }),
  });

  try {
    const bound = await server.start();
    logger.info('metrics server listening', { address: bound.address, port: bound.port });
  } catch (cause) {
    logger.error('metrics server failed to start — exiting', errorMeta(cause));
    process.exit(1);
    return;
  }

  // createPoller() only constructs — no scheduling happens until start()
  // below — so it, and lifecycle.install(), can and must happen before
  // backend.init(), not after. A real CI run found the gap this closes:
  // with install() called only after a successful init(), a SIGTERM/SIGINT
  // arriving during server startup or backend.init() (which DESIGN.md §7.2
  // already documents as potentially slow/hanging — the whole reason the
  // server starts before init() in the first place) had no signal handler
  // registered at all, so Node's default handling terminated the process
  // via the signal itself rather than exiting 0 through the graceful
  // sequence — observed directly as `code=null signal=SIGINT` against a
  // real subprocess whose SIGINT landed in exactly this window.
  const poller = createPoller({
    backend,
    cache,
    clock,
    logger,
    pollIntervalSeconds: config.pollIntervalSeconds,
    metrics: selfMetrics,
    parseErrorTracker,
  });

  const lifecycle = createLifecycle({ server, poller, backend, logger });
  lifecycle.install();

  try {
    await backend.init();
  } catch (cause) {
    logger.error('backend init() failed — exiting', errorMeta(cause));
    // A partially-initialized FMC adapter can already own a live Agent
    // (init() creates the dispatcher/httpClient before the later steps —
    // token acquisition, domain resolution, discovery — that can fail);
    // close() is safe to call regardless of how far init() got, since it
    // only tears down whatever was actually assigned. poller.stop() is
    // included via lifecycle.shutdown() but is a no-op here since
    // poller.start() is never reached on this path.
    await lifecycle.shutdown(1);
    return;
  }

  poller.start();
}

main().catch((cause) => {
  exitWithError(cause instanceof Error ? cause.message : String(cause));
});
