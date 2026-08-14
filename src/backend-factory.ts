import { type CreateFmcAdapterOptions, createFmcAdapter } from './backends/fmc/adapter.ts';
import {
  type CreateSccAdapterOptions,
  createSccAdapter,
  type SccHealthBackend,
} from './backends/scc/adapter.ts';
import type {
  DeviceCertificatesBackend,
  HealthBackend,
  LicenseStatusBackend,
} from './backends/types.ts';
import type { AppConfig } from './config/types.ts';
import type { DeviceCertificateEntry } from './domain/certificate-status.ts';
import type { DeviceInventoryEntry } from './domain/device-inventory.ts';
import type { ParseError } from './domain/diagnostics.ts';
import type { LicenseStatus } from './domain/license-status.ts';
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
  /** SCC-only: device-inventory poll failure (DESIGN.md §4.6.1) — the previous inventory list is kept. */
  onInventoryError?: () => void;
  /** Both backends (DESIGN.md §4.6.2): license-status poll failure. The previous status is kept. */
  onLicenseError?: () => void;
  /** Both backends (DESIGN.md §4.6.2): device-certificates poll failure. The previous list is kept. */
  onCertificateError?: () => void;
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
      inventoryPollIntervalSeconds: backend.inventoryPollIntervalSeconds,
      licensePollIntervalSeconds: backend.licensePollIntervalSeconds,
      certificatePollIntervalSeconds: backend.certificatePollIntervalSeconds,
      clock: options.clock,
      logger: options.logger,
      requestTimeoutMs,
      ...(hooks.onParseError !== undefined && { onParseError: hooks.onParseError }),
      ...(hooks.onRateLimitDeferral !== undefined && {
        onRateLimitDeferral: hooks.onRateLimitDeferral,
      }),
      ...(hooks.onUpstreamRequest !== undefined && { onUpstreamRequest: hooks.onUpstreamRequest }),
      ...(hooks.onUpstreamRetry !== undefined && { onUpstreamRetry: hooks.onUpstreamRetry }),
      ...(hooks.onInventoryError !== undefined && { onInventoryError: hooks.onInventoryError }),
      ...(hooks.onLicenseError !== undefined && { onLicenseError: hooks.onLicenseError }),
      ...(hooks.onCertificateError !== undefined && {
        onCertificateError: hooks.onCertificateError,
      }),
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
    licensePollIntervalSeconds: backend.licensePollIntervalSeconds,
    certificatePollIntervalSeconds: backend.certificatePollIntervalSeconds,
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
    ...(hooks.onLicenseError !== undefined && { onLicenseError: hooks.onLicenseError }),
    ...(hooks.onCertificateError !== undefined && {
      onCertificateError: hooks.onCertificateError,
    }),
    ...(hooks.onFmcRawResponse !== undefined && { onRawResponse: hooks.onFmcRawResponse }),
  });
}

/**
 * Narrows a `HealthBackend` returned by `createBackend` to `SccHealthBackend`
 * and returns its device-inventory reader, or `undefined` for FMC. Kept here
 * rather than as an inline cast at the one call site that needs it
 * (`src/index.ts`) so "how config maps to adapter specifics" — this
 * module's own stated purpose — stays the one place branching on
 * `backend.kind` for this feature, matching every other backend-specific
 * decision in this file. Safe because `createBackend` guarantees a `kind:
 * 'scc'` result is always the object `createSccAdapter` returned, which
 * always satisfies `SccHealthBackend`.
 */
export function getSccDeviceInventoryReader(
  backend: HealthBackend,
): (() => DeviceInventoryEntry[]) | undefined {
  if (backend.kind !== 'scc') {
    return undefined;
  }
  const scc = backend as SccHealthBackend;
  return () => scc.getDeviceInventory();
}

/**
 * Both backends implement `LicenseStatusBackend`/`DeviceCertificatesBackend`
 * (DESIGN.md §4.6.2, unlike device inventory above, which stays SCC-only) —
 * so unlike `getSccDeviceInventoryReader`, there is no `undefined` case to
 * consider; the cast is always safe for a `HealthBackend` `createBackend`
 * itself returned.
 */
export function getLicenseStatusReader(backend: HealthBackend): () => LicenseStatus | undefined {
  const withLicense = backend as LicenseStatusBackend;
  return () => withLicense.getLicenseStatus();
}

export function getDeviceCertificatesReader(
  backend: HealthBackend,
): () => DeviceCertificateEntry[] {
  const withCertificates = backend as DeviceCertificatesBackend;
  return () => withCertificates.getDeviceCertificates();
}
