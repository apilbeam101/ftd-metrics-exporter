import { readFileSync } from 'node:fs';
import type { Dispatcher } from 'undici';
import type { Secret } from '../../config/secret.ts';
import type { MetricFamily, TimeRange } from '../../config/types.ts';
import type { ParseError } from '../../domain/diagnostics.ts';
import type { DeviceHealthSnapshot } from '../../domain/snapshot.ts';
import { type AgentOptions, createAgent } from '../../http/agent.ts';
import { type BudgetGuard, createBudgetGuard } from '../../http/budget.ts';
import { createHttpClient } from '../../http/client.ts';
import type { Clock } from '../../http/clock.ts';
import { classifyNetworkError, HttpError } from '../../http/errors.ts';
import { type ConcurrencyLimiter, createConcurrencyLimiter } from '../../http/limiter.ts';
import type { Logger } from '../../log/logger.ts';
import type { HealthBackend } from '../types.ts';
import { createFmcDiscovery, type FmcDeviceDiscovery, fetchAllDeviceRecords } from './discovery.ts';
import { resolveDomainUuid } from './domain.ts';
import { buildAggregateMetricsUrl } from './filter.ts';
import { type FmcFamilyMapResult, mapFmcFamilyResponse, mergeFmcFamilies } from './map.ts';
import { projectFmcRequestVolume } from './sizing.ts';
import { createFmcTokenManager, type FmcTokenManager } from './token-manager.ts';

/** DESIGN.md §3.3.4: 300 GETs/minute per source IP, API-wide (not per-endpoint like SCC). */
const DEFAULT_BUDGET_MAX_REQUESTS = 300;
const DEFAULT_BUDGET_WINDOW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Templated label for `ftd_exporter_upstream_*{endpoint}` — never an interpolated identifier (DESIGN.md §11). */
const AGGREGATE_METRICS_ENDPOINT_LABEL =
  '/api/fmc_config/v1/domain/:domainUuid/health/aggregatemetrics';

export interface CreateFmcAdapterOptions {
  host: string;
  username: string;
  password: Secret;
  domainUuid?: string;
  metricFamilies: MetricFamily[];
  timeRange: TimeRange;
  maxConcurrentRequests: number;
  discoveryIntervalSeconds: number;
  /** Used only for the startup sizing projection (DESIGN.md §3.3.4) — not otherwise part of this adapter's own behavior, since the poll *cadence itself* is driven by the caller (Stage 9's poller), not this adapter. */
  pollIntervalSeconds: number;
  clock: Clock;
  logger: Logger;
  requestTimeoutMs?: number;
  /** TLS options for the Agent this adapter creates in `init()` (DESIGN.md §9.6). `ca` is populated from `caBundlePath` below if not supplied directly; `rejectUnauthorized` is derived from `tlsInsecureSkipVerify` below if not supplied directly. Ignored if `dispatcher` is supplied. */
  agent?: Omit<AgentOptions, 'connections' | 'ca' | 'rejectUnauthorized'>;
  /** Read into `agent.ca` at `init()` time (DESIGN.md §9.6) — config validation already guarantees this path, if set, is a readable file. */
  caBundlePath?: string;
  /** DESIGN.md §9.6's explicitly-labeled escape hatch. Defaults to `false` (verification stays on). */
  tlsInsecureSkipVerify?: boolean;
  /** Test hook: inject a pre-built dispatcher instead of having `init()` construct one via `agent`/`caBundlePath`. The adapter still owns closing it. */
  dispatcher?: Dispatcher;
  /** Sanity cap on discovery pages — forwarded to `fetchAllDeviceRecords`. */
  maxDiscoveryPages?: number;
  /** Overrides for the FMC-wide request budget guard (plan Stage 8 testing steps use a fast fake-clock window instead of the real 300/60s). */
  budgetMaxRequests?: number;
  budgetWindowMs?: number;
  onParseError?: (error: ParseError) => void;
  onRateLimitDeferral?: () => void;
  onUpstreamRequest?: (endpoint: string, statusCode: number, durationSeconds: number) => void;
  onUpstreamRetry?: (error: HttpError, attemptNumber: number, delayMs: number) => void;
  onTokenRefresh?: () => void;
  onTokenReauth?: () => void;
  onTokenExpiryUpdate?: (expiryUnixSeconds: number) => void;
  onDiscoverySuccess?: (deviceCount: number) => void;
  onDiscoveryFailure?: () => void;
  /** `--dump-raw` (Stage 11) attachment point: fired with every response actually received for a device/family request (any status code, including a 4xx/5xx error body — e.g. Cisco's own "Device not connected." envelope), before `JSON.parse`/mapping and before status-code classification. Never used by the normal poll path. */
  onRawResponse?: (
    deviceId: string,
    family: MetricFamily,
    statusCode: number,
    body: string,
  ) => void;
  /** Fired for a non-fatal discovery anomaly (F6: a malformed device record skipped; F4: pagination ended without reaching the server's own reported total). Also always logged via `logger.warn`. */
  onDiscoveryWarning?: (message: string) => void;
  /** Fired once, from `init()`, if the projected FMC request volume exceeds DESIGN.md §3.3.4's ~70% warning threshold. Also logged via `logger.warn` unconditionally when it fires. */
  onSizingWarning?: (message: string) => void;
}

/**
 * Standalone on-prem FMC adapter (DESIGN.md §3.3): Basic-auth login via
 * `FmcTokenManager`, domain UUID resolution, device discovery, and an
 * N-devices x M-families fan-out under a concurrency limiter and a
 * rolling-window request budget guard. Partial success is success
 * (DESIGN.md §2.5) — a per-device or per-family failure is isolated to
 * that one request and recorded as a `ParseError`; it never fails the
 * whole `fetchSnapshot()` call, and a device that contributed nothing
 * across every family simply does not appear in the returned array
 * (`mergeFmcFamilies`'s own contract).
 */
export function createFmcAdapter(options: CreateFmcAdapterOptions): HealthBackend {
  let dispatcher: Dispatcher | undefined;
  let ownsDispatcher = false;
  let httpClient: ReturnType<typeof createHttpClient> | undefined;
  let tokenManager: FmcTokenManager | undefined;
  let discovery: FmcDeviceDiscovery | undefined;
  let limiter: ConcurrencyLimiter | undefined;
  let budgetGuard: BudgetGuard | undefined;
  let domainUuid: string | undefined;
  let initialized = false;
  let closed = false;

  function requireInitialized(): {
    client: ReturnType<typeof createHttpClient>;
    tokens: FmcTokenManager;
    disc: FmcDeviceDiscovery;
    lim: ConcurrencyLimiter;
    budget: BudgetGuard;
    domain: string;
  } {
    if (
      httpClient === undefined ||
      tokenManager === undefined ||
      discovery === undefined ||
      limiter === undefined ||
      budgetGuard === undefined ||
      domainUuid === undefined
    ) {
      throw new HttpError({
        class: 'fatal_config',
        reason: 'unknown',
        message: 'FMC adapter used before init() (or after close())',
      });
    }
    return {
      client: httpClient,
      tokens: tokenManager,
      disc: discovery,
      lim: limiter,
      budget: budgetGuard,
      domain: domainUuid,
    };
  }

  async function fetchOnce(
    client: ReturnType<typeof createHttpClient>,
    budget: BudgetGuard,
    deviceId: string,
    family: MetricFamily,
    accessToken: string,
    domain: string,
  ): Promise<string> {
    const url = buildAggregateMetricsUrl(options.host, domain, deviceId, family, options.timeRange);
    const response = await client.get(url, {
      endpoint: AGGREGATE_METRICS_ENDPOINT_LABEL,
      headers: { 'X-auth-access-token': accessToken },
      beforeAttempt: () => budget.acquire(),
      ...(options.onRawResponse !== undefined && {
        onRawResponse: (statusCode: number, body: string) =>
          options.onRawResponse?.(deviceId, family, statusCode, body),
      }),
    });
    return response.body;
  }

  /**
   * DESIGN.md §3.3.2: "on an unexpected 401, force re-auth and retry the
   * failed request exactly once." A second consecutive 401 propagates
   * (does not loop) — there is no further retry wrapper around this
   * function's own retry.
   */
  async function fetchWithReauth(
    client: ReturnType<typeof createHttpClient>,
    tokens: FmcTokenManager,
    budget: BudgetGuard,
    deviceId: string,
    family: MetricFamily,
    domain: string,
  ): Promise<string> {
    const token = await tokens.getToken();
    try {
      return await fetchOnce(client, budget, deviceId, family, token, domain);
    } catch (cause) {
      const httpError = classifyNetworkError(cause);
      if (httpError.statusCode !== 401) {
        throw httpError;
      }
      const freshToken = await tokens.forceReauth(token);
      return await fetchOnce(client, budget, deviceId, family, freshToken, domain);
    }
  }

  async function fetchFamilyForDevice(
    client: ReturnType<typeof createHttpClient>,
    tokens: FmcTokenManager,
    budget: BudgetGuard,
    deviceId: string,
    family: MetricFamily,
    domain: string,
  ): Promise<FmcFamilyMapResult> {
    let body: string;
    try {
      body = await fetchWithReauth(client, tokens, budget, deviceId, family, domain);
    } catch (cause) {
      const httpError = classifyNetworkError(cause);
      return {
        partial: {},
        parseErrors: [
          {
            deviceUid: deviceId,
            group: family,
            message: `${family} request failed: ${httpError.message}`,
          },
        ],
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause) {
      return {
        partial: {},
        parseErrors: [
          {
            deviceUid: deviceId,
            group: family,
            message: `${family} response body is not valid JSON: ${(cause as Error).message}`,
          },
        ],
      };
    }

    return mapFmcFamilyResponse(payload, family, deviceId);
  }

  return {
    kind: 'fmc',

    async init(): Promise<void> {
      if (initialized) {
        throw new HttpError({
          class: 'fatal_config',
          reason: 'unknown',
          message:
            'FMC adapter init() was called twice — an adapter instance may only be initialized once',
        });
      }
      initialized = true;

      if (options.dispatcher !== undefined) {
        dispatcher = options.dispatcher;
        ownsDispatcher = false;
      } else {
        const ca =
          options.caBundlePath !== undefined
            ? readFileSync(options.caBundlePath, 'utf8')
            : undefined;
        dispatcher = createAgent({
          minVersion: 'TLSv1.2',
          ...options.agent,
          rejectUnauthorized: !(options.tlsInsecureSkipVerify ?? false),
          ...(ca !== undefined ? { ca } : {}),
          connections: options.maxConcurrentRequests,
        });
        ownsDispatcher = true;
      }

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

      limiter = createConcurrencyLimiter({
        maxConcurrent: options.maxConcurrentRequests,
        ...(options.onRateLimitDeferral !== undefined && { onDefer: options.onRateLimitDeferral }),
      });

      budgetGuard = createBudgetGuard({
        clock: options.clock,
        maxRequests: options.budgetMaxRequests ?? DEFAULT_BUDGET_MAX_REQUESTS,
        windowMs: options.budgetWindowMs ?? DEFAULT_BUDGET_WINDOW_MS,
        ...(options.onRateLimitDeferral !== undefined && { onDefer: options.onRateLimitDeferral }),
      });
      const budget = budgetGuard;

      tokenManager = createFmcTokenManager({
        dispatcher,
        host: options.host,
        username: options.username,
        password: options.password,
        clock: options.clock,
        logger: options.logger,
        ...(options.requestTimeoutMs !== undefined && {
          requestTimeoutMs: options.requestTimeoutMs,
        }),
        ...(options.onTokenRefresh !== undefined && { onTokenRefresh: options.onTokenRefresh }),
        ...(options.onTokenReauth !== undefined && { onTokenReauth: options.onTokenReauth }),
        ...(options.onTokenExpiryUpdate !== undefined && {
          onTokenExpiryUpdate: options.onTokenExpiryUpdate,
        }),
      });

      const accessToken = await tokenManager.getToken();

      domainUuid = await resolveDomainUuid({
        configuredDomainUuid: options.domainUuid,
        domainUuidHeader: tokenManager.getDomainUuidHeader(),
        dispatcher,
        host: options.host,
        accessToken,
        clock: options.clock,
        beforeAttempt: () => budget.acquire(),
        ...(options.requestTimeoutMs !== undefined && {
          requestTimeoutMs: options.requestTimeoutMs,
        }),
      });
      if (domainUuid === undefined) {
        throw new Error(
          'FMC domain UUID could not be resolved: FMC_DOMAIN_UUID is unset, the generatetoken ' +
            'response carried no DOMAIN_UUID header, and GET /api/fmc_platform/v1/info/domain ' +
            'did not return a usable domain',
        );
      }

      const domain = domainUuid;
      // F8: the very first discovery attempt has no previous device list
      // to fall back on — `createFmcDiscovery`'s failure path is correct
      // for a later *refresh* (reuse the stale-but-usable cached list),
      // but on the first attempt that "cache" is an empty array
      // indistinguishable from a genuinely empty fleet. This local flag
      // (composed with the caller's own `onDiscoveryFailure`, not a
      // replacement for it) lets init() tell the two apart.
      let firstDiscoveryFailed = false;
      discovery = createFmcDiscovery({
        clock: options.clock,
        intervalMs: options.discoveryIntervalSeconds * 1000,
        fetchDevices: async () => {
          const token = await tokenManager?.getToken();
          if (dispatcher === undefined || token === undefined) {
            throw new Error('FMC adapter dispatcher/token unavailable for discovery');
          }
          return fetchAllDeviceRecords({
            dispatcher,
            host: options.host,
            domainUuid: domain,
            accessToken: token,
            clock: options.clock,
            beforeAttempt: () => budget.acquire(),
            onWarning: (message) => {
              options.logger.warn(message);
              options.onDiscoveryWarning?.(message);
            },
            ...(options.requestTimeoutMs !== undefined && {
              requestTimeoutMs: options.requestTimeoutMs,
            }),
            ...(options.maxDiscoveryPages !== undefined && {
              maxPages: options.maxDiscoveryPages,
            }),
          });
        },
        ...(options.onDiscoverySuccess !== undefined && {
          onDiscoverySuccess: options.onDiscoverySuccess,
        }),
        onDiscoveryFailure: () => {
          firstDiscoveryFailed = true;
          options.onDiscoveryFailure?.();
        },
      });

      const devices = await discovery.getDevices();

      if (devices.length === 0 && firstDiscoveryFailed) {
        throw new Error(
          'FMC device discovery failed on its first attempt (no previous device list to fall ' +
            'back on) — the exporter would otherwise come up "healthy" serving a permanently ' +
            'empty /metrics. Check FMC connectivity/credentials and restart.',
        );
      }

      const projection = projectFmcRequestVolume(
        devices.length,
        options.metricFamilies.length,
        options.pollIntervalSeconds,
      );
      if (projection.warning !== undefined) {
        options.logger.warn(projection.warning);
        options.onSizingWarning?.(projection.warning);
      }
    },

    async fetchSnapshot(): Promise<DeviceHealthSnapshot[]> {
      const { client, tokens, disc, lim, budget, domain } = requireInitialized();

      const devices = await disc.getDevices();
      const perDeviceResults = new Map<string, FmcFamilyMapResult[]>(
        devices.map((device) => [device.id, []]),
      );

      const tasks: Array<Promise<void>> = [];
      for (const device of devices) {
        for (const family of options.metricFamilies) {
          tasks.push(
            lim
              .run(() => fetchFamilyForDevice(client, tokens, budget, device.id, family, domain))
              .then((result) => {
                perDeviceResults.get(device.id)?.push(result);
              }),
          );
        }
      }
      await Promise.all(tasks);

      const snapshots: DeviceHealthSnapshot[] = [];
      for (const device of devices) {
        const familyResults = perDeviceResults.get(device.id) ?? [];
        const merged = mergeFmcFamilies(device.id, device.name, familyResults);
        for (const error of merged.parseErrors) {
          options.onParseError?.(error);
        }
        if (merged.snapshot !== undefined) {
          snapshots.push(merged.snapshot);
        }
      }
      return snapshots;
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      tokenManager?.close();
      if (httpClient !== undefined) {
        await httpClient.close();
      } else if (ownsDispatcher && dispatcher !== undefined) {
        await dispatcher.close();
      }
      httpClient = undefined;
      tokenManager = undefined;
      discovery = undefined;
      limiter = undefined;
      budgetGuard = undefined;
      domainUuid = undefined;
    },
  };
}

export type { AgentOptions };
