import type { Dispatcher } from 'undici';
import type { Secret } from '../../config/secret.ts';
import type { TimeRange } from '../../config/types.ts';
import type { DeviceInventoryEntry } from '../../domain/device-inventory.ts';
import type { ParseError } from '../../domain/diagnostics.ts';
import type { DeviceHealthSnapshot } from '../../domain/snapshot.ts';
import { type AgentOptions, createAgent } from '../../http/agent.ts';
import { createHttpClient } from '../../http/client.ts';
import type { Clock } from '../../http/clock.ts';
import { classifyNetworkError, HttpError } from '../../http/errors.ts';
import { createSpacingGuard } from '../../http/spacing.ts';
import type { Logger } from '../../log/logger.ts';
import type { HealthBackend } from '../types.ts';
import { createSccDeviceInventory, type SccDeviceInventory } from './inventory.ts';
import { mapSccInventoryResponse } from './inventory-map.ts';
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
/** DESIGN.md §4.6.1: the device-inventory endpoint, confirmed live 2026-08-11. Not nested under a manager UID — a fleet-wide listing, unlike health/metrics. */
const INVENTORY_ENDPOINT_PATH = '/v1/inventory/devices';

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

function buildInventoryUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}${INVENTORY_ENDPOINT_PATH}`;
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
  /**
   * `SCC_INVENTORY_POLL_INTERVAL_SECONDS`, DESIGN.md §4.6.1. Unlike every
   * other option here, omitting this **disables** device-inventory polling
   * entirely rather than falling back to a built-in default — the default
   * (300s) is owned by `config/validate.ts`, which always resolves a real
   * number for a real SCC backend, so production always has the feature on.
   * The adapter-level "omit to disable" shape exists so a test exercising
   * only the health-metrics path doesn't have to also serve a valid
   * `/v1/inventory/devices` response it doesn't care about.
   */
  inventoryPollIntervalSeconds?: number;
  /** TLS options for the Agent this adapter creates in `init()`. Ignored if `dispatcher` is supplied. */
  agent?: Omit<AgentOptions, 'connections'>;
  /** Test hook: inject a pre-built dispatcher (e.g. pointed at a local test server) instead of having `init()` construct one via `agent`. The adapter still owns closing it. */
  dispatcher?: Dispatcher;
  /** One call per `ParseError` produced by `mapSccResponse`/`mapSccInventoryResponse`, or synthesized for a malformed JSON body — the attachment point for `ftd_exporter_parse_errors_total{group}` (Stage 9's job to wire up, not this adapter's). */
  onParseError?: (error: ParseError) => void;
  /** Fired once per *request* that had to wait for the spacing floor — the attachment point for `ftd_exporter_rate_limit_deferrals_total`. Can fire twice within one `fetchSnapshot()` call (once for health/metrics, once for the device-inventory refresh when due — DESIGN.md §4.6.1), since both share this same spacing guard; that is expected steady-state behavior; not evidence of health/metrics itself brushing the rate limit. */
  onRateLimitDeferral?: () => void;
  /** Fired once per completed HTTP attempt (including retries) that received a response — the attachment point for `ftd_exporter_upstream_requests_total`/`..._duration_seconds`. */
  onUpstreamRequest?: (endpoint: string, statusCode: number, durationSeconds: number) => void;
  onUpstreamRetry?: (error: HttpError, attemptNumber: number, delayMs: number) => void;
  /** Fired when a device-inventory refresh fails (DESIGN.md §4.6.1) — the attachment point for `ftd_exporter_scc_inventory_errors_total`. The previous inventory list is kept; this never fails the overall `fetchSnapshot()` call. */
  onInventoryError?: () => void;
  /** `--dump-raw` (Stage 11) attachment point: fired with every response body actually received (any status code, including a 4xx/5xx error body), before `JSON.parse`/mapping and before status-code classification. Never used by the normal poll path. Also fires for the device-inventory request, since it goes through the same HTTP client. */
  onRawResponse?: (statusCode: number, body: string) => void;
}

/**
 * The concrete SCC adapter's shape — `HealthBackend` plus a synchronous,
 * network-free read of the last successful device-inventory refresh
 * (DESIGN.md §4.6.1). Kept separate from `HealthBackend` itself, which stays
 * verbatim per DESIGN.md §2.3 — FMC has no equivalent capability, and
 * widening the shared interface would leak an SCC-only concern into FMC's
 * adapter surface. `backend-factory.ts`'s `getSccDeviceInventoryReader`
 * narrows a plain `HealthBackend` to this type at the one call site that
 * needs it, keyed off `config.backend.kind === 'scc'`.
 */
export interface SccHealthBackend extends HealthBackend {
  getDeviceInventory(): DeviceInventoryEntry[];
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
export function createSccAdapter(options: CreateSccAdapterOptions): SccHealthBackend {
  let token: string | undefined;
  let dispatcher: Dispatcher | undefined;
  let ownsDispatcher = false;
  let httpClient: ReturnType<typeof createHttpClient> | undefined;
  let spacingGuard: ReturnType<typeof createSpacingGuard> | undefined;
  let deviceInventory: SccDeviceInventory | undefined;
  let initialized = false;
  let closed = false;

  /**
   * The device-inventory HTTP call itself — a plain GET through the same
   * `httpClient`/`spacingGuard`/`token` health/metrics uses, so it is
   * structurally serialized against the same 2 requests/minute floor
   * (DESIGN.md §3.2.4) regardless of how the two cadences happen to
   * overlap.
   *
   * Per-item parse failures (one malformed device entry) are reported via
   * `onParseError` and skipped — "partial success is a success" (DESIGN.md
   * §2.5), mirroring `mapSccResponse`'s own per-device isolation. But a
   * *root-level* failure (an unparseable body, a non-object payload, no
   * `items` array, or every item failing to map) must not resolve to `[]`
   * silently: an empty array is indistinguishable from "the fleet is
   * genuinely empty," and `createSccDeviceInventory` (inventory.ts) would
   * treat it as a successful refresh — advancing `lastSuccessAt` and
   * overwriting the last-known-good cached list with nothing. Throwing
   * here is what lets that module's existing catch-and-keep-previous logic
   * do its job, the same "resolved-zero-with-recorded-errors is a failure,
   * not an empty success" distinction `poller.ts` already makes for the
   * health-snapshot cache.
   */
  async function fetchDeviceInventoryFromWire(): Promise<DeviceInventoryEntry[]> {
    const guard = spacingGuard;
    if (httpClient === undefined || guard === undefined || token === undefined) {
      return [];
    }
    const response = await httpClient.get(buildInventoryUrl(options.baseUrl), {
      endpoint: INVENTORY_ENDPOINT_PATH,
      headers: { authorization: `Bearer ${token}` },
      beforeAttempt: () => guard.wait(),
      ...(options.onRawResponse !== undefined && { onRawResponse: options.onRawResponse }),
    });

    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch (cause) {
      options.onParseError?.({
        group: 'inventory',
        message: `SCC device-inventory response body is not valid JSON: ${(cause as Error).message}`,
      });
      throw new Error('SCC device-inventory response body is not valid JSON');
    }

    const mapResult = mapSccInventoryResponse(payload);
    for (const error of mapResult.parseErrors) {
      options.onParseError?.(error);
    }
    if (mapResult.snapshots.length === 0 && mapResult.parseErrors.length > 0) {
      throw new Error(
        `SCC device-inventory produced zero devices after ${mapResult.parseErrors.length} ` +
          'parse error(s) recorded — treated as a failed refresh, not an empty inventory',
      );
    }
    return mapResult.snapshots;
  }

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

      // Optional at the adapter level — omitting it disables device-inventory
      // polling entirely, which is what every existing test that constructs
      // this adapter directly (without opting in) does, and is convenient
      // for a test that only cares about the health-metrics path. Config
      // (config/validate.ts) always resolves a real number for the SCC
      // backend, so `backend-factory.ts` always passes one in production —
      // the feature is unconditionally on for a real run, per DESIGN.md
      // §4.6.1, with no equivalent "disable" escape hatch exposed to an
      // operator.
      deviceInventory =
        options.inventoryPollIntervalSeconds !== undefined
          ? createSccDeviceInventory({
              clock: options.clock,
              intervalMs: options.inventoryPollIntervalSeconds * 1000,
              fetchDevices: fetchDeviceInventoryFromWire,
              ...(options.onInventoryError !== undefined && {
                onFailure: options.onInventoryError,
              }),
            })
          : undefined;
    },

    async fetchSnapshot(): Promise<DeviceHealthSnapshot[]> {
      if (httpClient === undefined || spacingGuard === undefined || token === undefined) {
        throw new HttpError({
          class: 'fatal_config',
          reason: 'unknown',
          message: 'SCC adapter used before init() (or after close())',
        });
      }
      const inventory = deviceInventory;
      const guard = spacingGuard;
      const client = httpClient;
      const authToken = token;
      const url = buildUrl(options.baseUrl, options.fmcUid, options.timeRange);

      async function fetchHealthSnapshot(): Promise<DeviceHealthSnapshot[]> {
        let response: Awaited<ReturnType<typeof client.get>>;
        try {
          response = await client.get(url, {
            endpoint: ENDPOINT_LABEL,
            headers: { authorization: `Bearer ${authToken}` },
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
      }

      if (inventory === undefined) {
        return fetchHealthSnapshot();
      }

      // The device-inventory refresh-if-due check runs unconditionally on
      // every cycle, in `finally`, regardless of how the health-metrics
      // fetch above resolves — DESIGN.md §4.6.1: an inventory hiccup must
      // never fail an otherwise-successful health poll, AND a health-side
      // failure (auth, network) must not silently starve inventory of ever
      // being checked again.
      try {
        return await fetchHealthSnapshot();
      } finally {
        await inventory.refreshIfDue();
      }
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
      deviceInventory = undefined;
    },

    getDeviceInventory(): DeviceInventoryEntry[] {
      // Sync, no network — safe to call from the render path (DESIGN.md
      // §2.2's poll-cache-serve contract). Returns `[]` before the first
      // successful refresh or after `close()`, same "nothing yet" semantics
      // as `MetricsCache.get()` returning `undefined`.
      return deviceInventory?.getCached() ?? [];
    },
  };
}

export type { AgentOptions };
