import type { ParseError } from '../domain/diagnostics.ts';
import type { SelfMetrics } from '../metrics/self.ts';

/**
 * Binds the per-request/per-adapter-event `ftd_exporter_*` counters and
 * gauges from DESIGN.md §11 to the optional callback hooks both backend
 * adapters already expose (`onParseError`, `onRateLimitDeferral`,
 * `onUpstreamRequest`, `onTokenRefresh`, `onTokenReauth`,
 * `onTokenExpiryUpdate`, `onDiscoverySuccess`, `onDiscoveryFailure` — see
 * scc/adapter.ts and fmc/adapter.ts's `CreateSccAdapterOptions`/
 * `CreateFmcAdapterOptions`). Kept as its own module, separate from the
 * poll-cycle-level metrics (`up`, `poll_total`, `poll_errors_total`,
 * `poll_duration_seconds`, `last_successful_poll_timestamp_seconds`,
 * `devices`) that poller.ts owns directly, because those need
 * cycle-scoped context (start time, resulting snapshot count) that only
 * the poll loop has — this module only ever reacts to one event at a time
 * with no cross-event state.
 *
 * `onUpstreamRetry` deliberately has no wiring here: DESIGN.md §11's table
 * has no dedicated "retry" counter (a retry that eventually succeeds is
 * invisible to the metric surface by design, and one that is ultimately
 * exhausted still surfaces via `poll_errors_total`/`ftd_exporter_up`), so
 * there is nothing to bind it to.
 */
export interface SelfMetricsRecorder {
  onParseError(error: ParseError): void;
  onRateLimitDeferral(): void;
  onUpstreamRequest(endpoint: string, statusCode: number, durationSeconds: number): void;
  onTokenRefresh(): void;
  onTokenReauth(): void;
  onTokenExpiryUpdate(expiryUnixSeconds: number): void;
  onDiscoverySuccess(deviceCount: number): void;
  onDiscoveryFailure(): void;
  onSccInventoryError(): void;
}

export function createSelfMetricsRecorder(
  metrics: Pick<
    SelfMetrics,
    | 'parseErrorsTotal'
    | 'rateLimitDeferralsTotal'
    | 'upstreamRequestsTotal'
    | 'upstreamRequestDurationSeconds'
    | 'fmcTokenRefreshesTotal'
    | 'fmcTokenReauthsTotal'
    | 'fmcTokenExpiryTimestampSeconds'
    | 'devicesDiscovered'
    | 'discoveryErrorsTotal'
    | 'sccInventoryErrorsTotal'
  >,
): SelfMetricsRecorder {
  return {
    onParseError(error: ParseError): void {
      metrics.parseErrorsTotal.inc({ group: error.group });
    },
    onRateLimitDeferral(): void {
      metrics.rateLimitDeferralsTotal.inc();
    },
    onUpstreamRequest(endpoint: string, statusCode: number, durationSeconds: number): void {
      metrics.upstreamRequestsTotal.inc({ endpoint, status_code: String(statusCode) });
      metrics.upstreamRequestDurationSeconds.observe({ endpoint }, durationSeconds);
    },
    onTokenRefresh(): void {
      metrics.fmcTokenRefreshesTotal.inc();
    },
    onTokenReauth(): void {
      metrics.fmcTokenReauthsTotal.inc();
    },
    onTokenExpiryUpdate(expiryUnixSeconds: number): void {
      metrics.fmcTokenExpiryTimestampSeconds.set(expiryUnixSeconds);
    },
    onDiscoverySuccess(deviceCount: number): void {
      metrics.devicesDiscovered.set(deviceCount);
    },
    onDiscoveryFailure(): void {
      metrics.discoveryErrorsTotal.inc();
    },
    onSccInventoryError(): void {
      metrics.sccInventoryErrorsTotal.inc();
    },
  };
}

/**
 * `ftd_exporter_build_info` and `ftd_exporter_tls_verification_disabled`
 * (DESIGN.md §11) are both startup-time-once values, not per-poll-cycle or
 * per-request events — Stage 11's `index.ts` is what actually knows the
 * version/commit/node-version/backend and the resolved
 * `tlsInsecureSkipVerify` setting, so these are exported as standalone
 * setters here rather than folded into `SelfMetricsRecorder`'s per-event
 * shape above.
 */
export function setBuildInfo(
  metrics: Pick<SelfMetrics, 'buildInfo'>,
  labels: { version: string; commit: string; node_version: string; backend: string },
): void {
  metrics.buildInfo.set(labels, 1);
}

export function setTlsVerificationDisabled(
  metrics: Pick<SelfMetrics, 'tlsVerificationDisabled'>,
  disabled: boolean,
): void {
  metrics.tlsVerificationDisabled.set(disabled ? 1 : 0);
}
