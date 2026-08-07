import { type CreateFmcAdapterOptions, createFmcAdapter } from './backends/fmc/adapter.ts';
import { type CreateSccAdapterOptions, createSccAdapter } from './backends/scc/adapter.ts';
import type { HealthBackend } from './backends/types.ts';
import type { AppConfig } from './config/types.ts';
import type { ParseError } from './domain/diagnostics.ts';
import type { Clock } from './http/clock.ts';
import type { HttpError } from './http/errors.ts';
import type { Logger } from './log/logger.ts';

/**
 * Constructs the one `HealthBackend` for `config.backend.kind` (DESIGN.md
 * §2.3: "exactly one per process"). Shared between `src/index.ts` (the
 * normal poll-cache-serve path, every hook wired to a real
 * `SelfMetricsRecorder`) and `src/dump-raw.ts` (a one-shot capture that
 * wires only the raw-response hook and otherwise runs with hooks omitted)
 * so the two never independently maintain their own copy of "how config
 * maps to adapter options" — DESIGN.md §2.3's per-backend asymmetry is
 * already complex enough living in one place.
 */
export interface BackendHooks {
  onParseError?: (error: ParseError) => void;
  onRateLimitDeferral?: () => void;
  onUpstreamRequest?: (endpoint: string, statusCode: number, durationSeconds: number) => void;
  onUpstreamRetry?: (error: HttpError, attemptNumber: number, delayMs: number) => void;
  onTokenRefresh?: () => void;
  onTokenReauth?: () => void;
  onTokenExpiryUpdate?: (expiryUnixSeconds: number) => void;
  onDiscoverySuccess?: (deviceCount: number) => void;
  onDiscoveryFailure?: () => void;
  onDiscoveryWarning?: (message: string) => void;
  onSizingWarning?: (message: string) => void;
  /** SCC-only raw-response attachment point (`--dump-raw`). */
  onRawResponse?: CreateSccAdapterOptions['onRawResponse'];
  /** FMC-only raw-response attachment point (`--dump-raw`) — a distinct signature (per device/family), so kept as its own field rather than overloading `onRawResponse`. */
  onFmcRawResponse?: CreateFmcAdapterOptions['onRawResponse'];
}

export interface CreateBackendOptions {
  config: AppConfig;
  clock: Clock;
  logger: Logger;
  pollIntervalSeconds: number;
  hooks?: BackendHooks;
}

export function createBackend(options: CreateBackendOptions): HealthBackend {
  const hooks = options.hooks ?? {};
  const { config } = options;
  // Stage 11 review: `REQUEST_TIMEOUT_SECONDS` is validated by config/load.ts
  // but was never threaded through to either adapter, silently discarding an
  // operator's configured value in favor of each adapter's own hardcoded
  // 30s default — DESIGN.md §2.5's "every upstream request gets an explicit
  // total-time budget (default 30s, configurable)" requires the configured
  // value to actually reach the client that enforces it.
  const requestTimeoutMs = config.requestTimeoutSeconds * 1000;

  if (config.backend.kind === 'scc') {
    const backend = config.backend;
    return createSccAdapter({
      baseUrl: backend.baseUrl,
      apiToken: backend.apiToken,
      fmcUid: backend.fmcUid,
      timeRange: backend.timeRange,
      clock: options.clock,
      logger: options.logger,
      requestTimeoutMs,
      ...(hooks.onParseError !== undefined && { onParseError: hooks.onParseError }),
      ...(hooks.onRateLimitDeferral !== undefined && {
        onRateLimitDeferral: hooks.onRateLimitDeferral,
      }),
      ...(hooks.onUpstreamRequest !== undefined && { onUpstreamRequest: hooks.onUpstreamRequest }),
      ...(hooks.onUpstreamRetry !== undefined && { onUpstreamRetry: hooks.onUpstreamRetry }),
      ...(hooks.onRawResponse !== undefined && { onRawResponse: hooks.onRawResponse }),
    });
  }

  const backend = config.backend;
  return createFmcAdapter({
    host: backend.host,
    username: backend.username,
    password: backend.password,
    metricFamilies: backend.metricFamilies,
    timeRange: backend.timeRange,
    maxConcurrentRequests: backend.maxConcurrentRequests,
    discoveryIntervalSeconds: backend.discoveryIntervalSeconds,
    pollIntervalSeconds: options.pollIntervalSeconds,
    clock: options.clock,
    logger: options.logger,
    tlsInsecureSkipVerify: backend.tlsInsecureSkipVerify,
    requestTimeoutMs,
    ...(backend.domainUuid !== undefined && { domainUuid: backend.domainUuid }),
    ...(backend.caBundlePath !== undefined && { caBundlePath: backend.caBundlePath }),
    ...(hooks.onParseError !== undefined && { onParseError: hooks.onParseError }),
    ...(hooks.onRateLimitDeferral !== undefined && {
      onRateLimitDeferral: hooks.onRateLimitDeferral,
    }),
    ...(hooks.onUpstreamRequest !== undefined && { onUpstreamRequest: hooks.onUpstreamRequest }),
    ...(hooks.onUpstreamRetry !== undefined && { onUpstreamRetry: hooks.onUpstreamRetry }),
    ...(hooks.onTokenRefresh !== undefined && { onTokenRefresh: hooks.onTokenRefresh }),
    ...(hooks.onTokenReauth !== undefined && { onTokenReauth: hooks.onTokenReauth }),
    ...(hooks.onTokenExpiryUpdate !== undefined && {
      onTokenExpiryUpdate: hooks.onTokenExpiryUpdate,
    }),
    ...(hooks.onDiscoverySuccess !== undefined && { onDiscoverySuccess: hooks.onDiscoverySuccess }),
    ...(hooks.onDiscoveryFailure !== undefined && { onDiscoveryFailure: hooks.onDiscoveryFailure }),
    ...(hooks.onDiscoveryWarning !== undefined && { onDiscoveryWarning: hooks.onDiscoveryWarning }),
    ...(hooks.onSizingWarning !== undefined && { onSizingWarning: hooks.onSizingWarning }),
    ...(hooks.onFmcRawResponse !== undefined && { onRawResponse: hooks.onFmcRawResponse }),
  });
}
