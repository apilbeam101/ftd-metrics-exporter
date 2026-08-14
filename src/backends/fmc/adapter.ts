import { readFileSync } from 'node:fs';
import type { Dispatcher } from 'undici';
import type { Secret } from '../../config/secret.ts';
import type { MetricFamily, TimeRange } from '../../config/types.ts';
import type { DeviceCertificateEntry } from '../../domain/certificate-status.ts';
import type { ParseError } from '../../domain/diagnostics.ts';
import type { LicenseStatus } from '../../domain/license-status.ts';
import type { DeviceHealthSnapshot } from '../../domain/snapshot.ts';
import { type AgentOptions, createAgent } from '../../http/agent.ts';
import { type BudgetGuard, createBudgetGuard } from '../../http/budget.ts';
import { createHttpClient } from '../../http/client.ts';
import type { Clock } from '../../http/clock.ts';
import { classifyNetworkError, HttpError } from '../../http/errors.ts';
import { type ConcurrencyLimiter, createConcurrencyLimiter } from '../../http/limiter.ts';
import type { Logger } from '../../log/logger.ts';
import { mapDeviceCertificatesResponse } from '../shared/certificate-map.ts';
import { mapLicenseResponse } from '../shared/license-map.ts';
import { createRefreshCache, type RefreshCache } from '../shared/refresh-cache.ts';
import type { DeviceCertificatesBackend, HealthBackend, LicenseStatusBackend } from '../types.ts';
import { createFmcDiscovery, type FmcDeviceDiscovery, fetchAllDeviceRecords } from './discovery.ts';
import { resolveDomainUuid } from './domain.ts';
import { buildAggregateMetricsUrl } from './filter.ts';
import { type FmcFamilyMapResult, mapFmcFamilyResponse, mergeFmcFamilies } from './map.ts';
import { projectFmcRequestVolume } from './sizing.ts';
import { createFmcTokenManager, type FmcTokenManager } from './token-manager.ts';

/** DESIGN.md §4.6.2: confirmed live (2026-08-14) at this exact path — the same `fmc_platform` API SCC proxies via `cdfmc`, no domain segment. */
const LICENSE_ENDPOINT_LABEL = '/api/fmc_platform/v1/license/smartlicenses';
/** DESIGN.md §4.6.2: confirmed live (2026-08-14) — domain-scoped, unlike the license endpoint. */
const CERTIFICATES_ENDPOINT_LABEL = '/api/fmc_config/v1/domain/:domainUuid/devices/certificates';

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
  /** `FMC_LICENSE_POLL_INTERVAL_SECONDS`, DESIGN.md §4.6.2. Same "omit disables, config always sets a real default in production" shape as `discoveryIntervalSeconds`. */
  licensePollIntervalSeconds?: number;
  /** `FMC_CERTIFICATE_POLL_INTERVAL_SECONDS`, DESIGN.md §4.6.2. Same shape as `licensePollIntervalSeconds`. Unlike SCC, no domain-UUID resolution step is needed here — `domainUuid` is already resolved in `init()` for the health-metrics path. */
  certificatePollIntervalSeconds?: number;
  /** Fired when a license-status refresh fails (DESIGN.md §4.6.2) — the attachment point for `ftd_exporter_license_errors_total`. */
  onLicenseError?: () => void;
  /** Fired when a device-certificates refresh fails (DESIGN.md §4.6.2) — the attachment point for `ftd_exporter_certificate_errors_total`. */
  onCertificateError?: () => void;
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
export function createFmcAdapter(
  options: CreateFmcAdapterOptions,
): HealthBackend & LicenseStatusBackend & DeviceCertificatesBackend {
  let dispatcher: Dispatcher | undefined;
  let ownsDispatcher = false;
  let httpClient: ReturnType<typeof createHttpClient> | undefined;
  let tokenManager: FmcTokenManager | undefined;
  let discovery: FmcDeviceDiscovery | undefined;
  let limiter: ConcurrencyLimiter | undefined;
  let budgetGuard: BudgetGuard | undefined;
  let domainUuid: string | undefined;
  let licenseCache: RefreshCache<LicenseStatus | undefined> | undefined;
  let certificatesCache: RefreshCache<DeviceCertificateEntry[]> | undefined;
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

  /**
   * Generic version of the same "retry exactly once on 401" policy as
   * `fetchWithReauth` above, for the license/certificates calls added by
   * DESIGN.md §4.6.2 — kept as a separate small function rather than
   * generalizing `fetchWithReauth` itself, so this addition cannot alter the
   * behavior of the already-reviewed per-device/per-family fan-out path.
   */
  async function fetchWithReauthGeneric(
    tokens: FmcTokenManager,
    fetchOnce: (accessToken: string) => Promise<string>,
  ): Promise<string> {
    const token = await tokens.getToken();
    try {
      return await fetchOnce(token);
    } catch (cause) {
      const httpError = classifyNetworkError(cause);
      if (httpError.statusCode !== 401) {
        throw httpError;
      }
      const freshToken = await tokens.forceReauth(token);
      return await fetchOnce(freshToken);
    }
  }

  /**
   * The license-status HTTP call (DESIGN.md §4.6.2), sharing the same
   * `httpClient`/`budgetGuard`/token manager as every other FMC request.
   * Not domain-scoped, unlike certificates below. Same "resolved-zero-with-
   * recorded-errors is a failure, not an empty success" distinction as
   * `scc/adapter.ts`'s equivalent — a malformed body, or a structurally
   * valid one that produced parse errors and no status, throws rather than
   * resolving to `undefined`, or `createRefreshCache` would bank it as a
   * successful refresh, silently wiping the last-known-good status and
   * never incrementing `ftd_exporter_license_errors_total` (Opus review
   * finding, 2026-08-14). A genuinely empty response with zero parse errors
   * still resolves to `undefined` without throwing.
   */
  async function fetchLicenseFromWire(): Promise<LicenseStatus | undefined> {
    if (httpClient === undefined || budgetGuard === undefined || tokenManager === undefined) {
      return undefined;
    }
    const client = httpClient;
    const budget = budgetGuard;
    const tokens = tokenManager;

    const body = await fetchWithReauthGeneric(tokens, (accessToken) =>
      client
        .get(`https://${options.host}${LICENSE_ENDPOINT_LABEL}`, {
          endpoint: LICENSE_ENDPOINT_LABEL,
          headers: { 'X-auth-access-token': accessToken },
          beforeAttempt: () => budget.acquire(),
        })
        .then((response) => response.body),
    );

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause) {
      options.onParseError?.({
        group: 'license',
        message: `FMC license response body is not valid JSON: ${(cause as Error).message}`,
      });
      throw new Error('FMC license response body is not valid JSON');
    }

    const mapResult = mapLicenseResponse(payload);
    for (const error of mapResult.parseErrors) {
      options.onParseError?.(error);
    }
    if (mapResult.status === undefined && mapResult.parseErrors.length > 0) {
      throw new Error(
        `FMC license status produced no record after ${mapResult.parseErrors.length} parse ` +
          'error(s) recorded — treated as a failed refresh, not an absent license record',
      );
    }
    return mapResult.status;
  }

  /**
   * The device-certificates HTTP call (DESIGN.md §4.6.2). Unlike SCC, `id`
   * on this backend is already the same device UUID used everywhere else
   * (confirmed live, 2026-08-14) — the lookup only needs to add the device
   * *name*, sourced from discovery's own cached device list.
   */
  async function fetchCertificatesFromWire(): Promise<DeviceCertificateEntry[]> {
    if (
      httpClient === undefined ||
      budgetGuard === undefined ||
      tokenManager === undefined ||
      discovery === undefined ||
      domainUuid === undefined
    ) {
      return [];
    }
    const client = httpClient;
    const budget = budgetGuard;
    const tokens = tokenManager;
    const domain = domainUuid;
    const url = `https://${options.host}/api/fmc_config/v1/domain/${encodeURIComponent(domain)}/devices/certificates`;

    const body = await fetchWithReauthGeneric(tokens, (accessToken) =>
      client
        .get(url, {
          endpoint: CERTIFICATES_ENDPOINT_LABEL,
          headers: { 'X-auth-access-token': accessToken },
          beforeAttempt: () => budget.acquire(),
        })
        .then((response) => response.body),
    );

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause) {
      options.onParseError?.({
        group: 'certificate',
        message: `FMC device-certificates response body is not valid JSON: ${(cause as Error).message}`,
      });
      throw new Error('FMC device-certificates response body is not valid JSON');
    }

    const devices = await discovery.getDevices();
    const deviceById = new Map(devices.map((device) => [device.id, device]));

    const mapResult = mapDeviceCertificatesResponse(payload, (rawId) => {
      const device = deviceById.get(rawId);
      return device === undefined ? undefined : { deviceUid: device.id, deviceName: device.name };
    });
    for (const error of mapResult.parseErrors) {
      options.onParseError?.(error);
    }
    // Same "resolved-zero-with-recorded-errors is a failure" distinction as
    // fetchLicenseFromWire above and scc/adapter.ts's equivalent — including
    // the all-join-miss case (every record's `id` had no match in
    // discovery's current device list), which must retry next cycle rather
    // than being banked as a successful empty refresh (Opus review finding,
    // 2026-08-14).
    if (mapResult.snapshots.length === 0 && mapResult.parseErrors.length > 0) {
      throw new Error(
        `FMC device-certificates produced zero entries after ${mapResult.parseErrors.length} ` +
          'parse error(s) recorded — treated as a failed refresh, not an empty certificate list',
      );
    }
    return mapResult.snapshots;
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

      // Optional at the adapter level, same "omit disables, config always
      // sets a real default in production" shape as `discoveryIntervalSeconds`
      // — see `CreateFmcAdapterOptions`'s doc comments on these two fields.
      licenseCache =
        options.licensePollIntervalSeconds !== undefined
          ? createRefreshCache<LicenseStatus | undefined>({
              clock: options.clock,
              intervalMs: options.licensePollIntervalSeconds * 1000,
              fetch: fetchLicenseFromWire,
              initialValue: undefined,
              ...(options.onLicenseError !== undefined && { onFailure: options.onLicenseError }),
            })
          : undefined;

      certificatesCache =
        options.certificatePollIntervalSeconds !== undefined
          ? createRefreshCache<DeviceCertificateEntry[]>({
              clock: options.clock,
              intervalMs: options.certificatePollIntervalSeconds * 1000,
              fetch: fetchCertificatesFromWire,
              initialValue: [],
              ...(options.onCertificateError !== undefined && {
                onFailure: options.onCertificateError,
              }),
            })
          : undefined;
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

      function buildSnapshots(): DeviceHealthSnapshot[] {
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
      }

      // Genuinely in `finally`, not merely sequenced after — a throwing
      // `onParseError` consumer inside `buildSnapshots()` must not starve
      // license/certificates of ever being checked again, the same
      // discipline as SCC's equivalent (DESIGN.md §4.6.2). An earlier
      // version of this method sequenced these calls after a plain return
      // with a comment claiming `finally` semantics it didn't actually have
      // (Opus review finding, 2026-08-14).
      try {
        return buildSnapshots();
      } finally {
        await licenseCache?.refreshIfDue();
        await certificatesCache?.refreshIfDue();
      }
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
      licenseCache = undefined;
      certificatesCache = undefined;
    },

    getLicenseStatus(): LicenseStatus | undefined {
      return licenseCache?.getCached();
    },

    getDeviceCertificates(): DeviceCertificateEntry[] {
      return certificatesCache?.getCached() ?? [];
    },
  };
}

export type { AgentOptions };
