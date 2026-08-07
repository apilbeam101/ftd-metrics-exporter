import type { Dispatcher } from 'undici';
import type { Secret } from '../../config/secret.ts';
import type { TimeRange } from '../../config/types.ts';
import type { ParseError } from '../../domain/diagnostics.ts';
import type { DeviceHealthSnapshot } from '../../domain/snapshot.ts';
import { type AgentOptions, createAgent } from '../../http/agent.ts';
import { createHttpClient } from '../../http/client.ts';
import type { Clock } from '../../http/clock.ts';
import { classifyNetworkError, HttpError } from '../../http/errors.ts';
import { createSpacingGuard } from '../../http/spacing.ts';
import type { Logger } from '../../log/logger.ts';
import type { HealthBackend } from '../types.ts';
import { mapSccResponse } from './map.ts';

/**
 * `SCC_BASE_URL` is an opaque prefix (DESIGN.md §3.2.1) — the legacy
 * `.../api/rest` host and the current `.../firewall` host differ in both
 * host and path prefix, so the only safe operation is string concatenation
 * of this fixed suffix. No `new URL()` round-trip, no path normalization:
 * either of those would silently "fix" a legacy base URL into something
 * that 404s.
 */
const ENDPOINT_SUFFIX = '/v1/inventory/managers';
/** Templated label for `ftd_exporter_upstream_*{endpoint}` — never an interpolated identifier (DESIGN.md §11). */
const ENDPOINT_LABEL = '/v1/inventory/managers/:fmcUid/health/metrics';

/** DESIGN.md §3.2.4: the documented 2 requests/minute limit, enforced as a 30s floor between requests. */
export const DEFAULT_MIN_SPACING_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildUrl(baseUrl: string, fmcUid: string, timeRange: TimeRange): string {
  const prefix = trimTrailingSlash(baseUrl);
  return `${prefix}${ENDPOINT_SUFFIX}/${encodeURIComponent(fmcUid)}/health/metrics?timeRange=${encodeURIComponent(timeRange)}`;
}

export interface CreateSccAdapterOptions {
  baseUrl: string;
  apiToken: Secret;
  fmcUid: string;
  timeRange: TimeRange;
  clock: Clock;
  logger: Logger;
  /** Injectable so tests can use a millisecond-scale floor instead of the real 30s (plan Stage 7 testing step 8). Defaults to `DEFAULT_MIN_SPACING_MS`. */
  minSpacingMs?: number;
  requestTimeoutMs?: number;
  /** TLS options for the Agent this adapter creates in `init()`. Ignored if `dispatcher` is supplied. */
  agent?: Omit<AgentOptions, 'connections'>;
  /** Test hook: inject a pre-built dispatcher (e.g. pointed at a local test server) instead of having `init()` construct one via `agent`. The adapter still owns closing it. */
  dispatcher?: Dispatcher;
  /** One call per `ParseError` produced by `mapSccResponse`, or synthesized for a malformed JSON body — the attachment point for `ftd_exporter_parse_errors_total{group}` (Stage 9's job to wire up, not this adapter's). */
  onParseError?: (error: ParseError) => void;
  /** Fired once per `fetchSnapshot()` call whose request had to wait for the spacing floor — the attachment point for `ftd_exporter_rate_limit_deferrals_total`. */
  onRateLimitDeferral?: () => void;
  /** Fired once per completed HTTP attempt (including retries) that received a response — the attachment point for `ftd_exporter_upstream_requests_total`/`..._duration_seconds`. */
  onUpstreamRequest?: (endpoint: string, statusCode: number, durationSeconds: number) => void;
  onUpstreamRetry?: (error: HttpError, attemptNumber: number, delayMs: number) => void;
  /** `--dump-raw` (Stage 11) attachment point: fired with every response body actually received (any status code, including a 4xx/5xx error body), before `JSON.parse`/mapping and before status-code classification. Never used by the normal poll path. */
  onRawResponse?: (statusCode: number, body: string) => void;
}

/**
 * SCC/cdFMC adapter (DESIGN.md §3.2). One instance talks to exactly one
 * FMC UID via one batched call, so the spacing guard, the Agent, and the
 * HTTP client are all instance-scoped state created in `init()` and torn
 * down in `close()` — never module-level singletons, which would leak one
 * process's multiple test instances into each other or (in production,
 * where only one backend instance ever exists per DESIGN.md §2.3) would
 * simply be redundant indirection.
 */
export function createSccAdapter(options: CreateSccAdapterOptions): HealthBackend {
  let token: string | undefined;
  let dispatcher: Dispatcher | undefined;
  let ownsDispatcher = false;
  let httpClient: ReturnType<typeof createHttpClient> | undefined;
  let spacingGuard: ReturnType<typeof createSpacingGuard> | undefined;
  let initialized = false;
  let closed = false;

  return {
    kind: 'scc',

    async init(): Promise<void> {
      if (initialized) {
        throw new HttpError({
          class: 'fatal_config',
          reason: 'unknown',
          message:
            'SCC adapter init() was called twice — an adapter instance may only be initialized once',
        });
      }
      initialized = true;

      const raw = options.apiToken.reveal();
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new HttpError({
          class: 'fatal_config',
          reason: 'unknown',
          message: 'SCC_API_TOKEN is empty (or whitespace-only) — cannot authenticate',
        });
      }
      if (trimmed !== raw) {
        // Never interpolate the token itself into a log line — only note that trimming happened.
        options.logger.warn(
          'SCC_API_TOKEN had leading/trailing whitespace (e.g. a pasted trailing newline); trimmed automatically',
        );
      }
      token = trimmed;

      if (options.dispatcher !== undefined) {
        dispatcher = options.dispatcher;
        ownsDispatcher = false;
      } else {
        dispatcher = createAgent({ minVersion: 'TLSv1.2', ...options.agent });
        ownsDispatcher = true;
      }

      spacingGuard = createSpacingGuard({
        clock: options.clock,
        minSpacingMs: options.minSpacingMs ?? DEFAULT_MIN_SPACING_MS,
        ...(options.onRateLimitDeferral !== undefined && {
          onDefer: options.onRateLimitDeferral,
        }),
      });

      httpClient = createHttpClient({
        dispatcher,
        clock: options.clock,
        defaultTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        ...(options.onUpstreamRequest !== undefined && { onRequest: options.onUpstreamRequest }),
        ...(options.onUpstreamRetry !== undefined && {
          onRetry: (_endpoint: string, error: HttpError, attemptNumber: number, delayMs: number) =>
            options.onUpstreamRetry?.(error, attemptNumber, delayMs),
        }),
      });
    },

    async fetchSnapshot(): Promise<DeviceHealthSnapshot[]> {
      if (httpClient === undefined || spacingGuard === undefined || token === undefined) {
        throw new HttpError({
          class: 'fatal_config',
          reason: 'unknown',
          message: 'SCC adapter used before init() (or after close())',
        });
      }
      const guard = spacingGuard;
      const url = buildUrl(options.baseUrl, options.fmcUid, options.timeRange);

      let response: Awaited<ReturnType<typeof httpClient.get>>;
      try {
        response = await httpClient.get(url, {
          endpoint: ENDPOINT_LABEL,
          headers: { authorization: `Bearer ${token}` },
          beforeAttempt: () => guard.wait(),
          ...(options.onRawResponse !== undefined && { onRawResponse: options.onRawResponse }),
        });
      } catch (cause) {
        const httpError = classifyNetworkError(cause);
        if (httpError.class === 'auth_fatal') {
          options.logger.error(
            'SCC health metrics request failed with an authentication error — check SCC_API_TOKEN validity, expiry, and permissions. The exporter will keep running but this poll produced no data.',
            { statusCode: httpError.statusCode, reason: httpError.reason },
          );
        }
        throw httpError;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch (cause) {
        // Consistent with mapSccResponse's own "root" error handling: a
        // broken payload is reported as a diagnostic, not thrown — an
        // unparseable body is a data-quality signal for this poll, not a
        // reason to fail the whole fetchSnapshot() call (plan Stage 7
        // testing step 12: "parse-class error; no crash").
        const error: ParseError = {
          group: 'root',
          message: `SCC health/metrics response body is not valid JSON: ${(cause as Error).message}`,
        };
        options.onParseError?.(error);
        return [];
      }

      const mapResult = mapSccResponse(payload);
      for (const error of mapResult.parseErrors) {
        options.onParseError?.(error);
      }
      return mapResult.snapshots;
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      if (httpClient !== undefined) {
        await httpClient.close();
      } else if (ownsDispatcher && dispatcher !== undefined) {
        await dispatcher.close();
      }
      httpClient = undefined;
      spacingGuard = undefined;
      token = undefined;
      dispatcher = undefined;
    },
  };
}

export type { AgentOptions };
