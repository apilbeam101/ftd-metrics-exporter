import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

/**
 * Every `ftd_exporter_*` declaration from DESIGN.md §11, all declared here
 * even though most are only incremented starting in Stages 6-11 — the point
 * (per the plan's Stage 3 scope) is that later stages wire into an existing
 * name rather than inventing one ad hoc, keeping the metric surface's naming
 * decisions in one reviewable place.
 *
 * `cacheAgeSeconds` is the one gauge in this module that is a collect-time
 * computation, not a set-on-poll value (DESIGN.md §11: "computed at scrape
 * time") — it takes a `collect` callback reading an injected clock and cache
 * reference, resolved by the poller/server stages. It has no setter here
 * because nothing in Stage 3 owns "current cache age."
 *
 * `pollErrorsTotal`'s `reason` label is deliberately bounded (DESIGN.md
 * §11): `auth | rate_limited | timeout | network | http_5xx | parse |
 * unknown`. Nothing enforces that bound at the type level here — the
 * Stage 6+ caller passing the label value owns matching this vocabulary.
 */
export interface SelfMetrics {
  up: Gauge<never>;
  buildInfo: Gauge<'version' | 'commit' | 'node_version' | 'backend'>;
  lastSuccessfulPollTimestampSeconds: Gauge<never>;
  cacheAgeSeconds: Gauge<never>;
  pollDurationSeconds: Histogram<never>;
  pollTotal: Counter<never>;
  pollErrorsTotal: Counter<'reason'>;
  upstreamRequestsTotal: Counter<'endpoint' | 'status_code'>;
  upstreamRequestDurationSeconds: Histogram<'endpoint'>;
  devices: Gauge<never>;
  devicesDiscovered: Gauge<never>;
  discoveryErrorsTotal: Counter<never>;
  sccInventoryErrorsTotal: Counter<never>;
  series: Gauge<never>;
  parseErrorsTotal: Counter<'group'>;
  unknownEnumTotal: Counter<'metric' | 'value'>;
  fmcTokenRefreshesTotal: Counter<never>;
  fmcTokenReauthsTotal: Counter<never>;
  fmcTokenExpiryTimestampSeconds: Gauge<never>;
  tlsVerificationDisabled: Gauge<never>;
  rateLimitDeferralsTotal: Counter<never>;
}

export interface CreateSelfMetricsOptions {
  /** Injected so `ftd_exporter_cache_age_seconds` is testable without a real clock or cache. */
  cacheAgeSecondsCollect?: () => number;
}

export function createSelfMetrics(
  registry: Registry,
  options: CreateSelfMetricsOptions = {},
): SelfMetrics {
  const registers = [registry];

  return {
    up: new Gauge({
      name: 'ftd_exporter_up',
      help: '1 if the most recent poll cycle succeeded.',
      registers,
    }),
    buildInfo: new Gauge({
      name: 'ftd_exporter_build_info',
      help: 'Always 1. Labels identify the running build.',
      labelNames: ['version', 'commit', 'node_version', 'backend'],
      registers,
    }),
    lastSuccessfulPollTimestampSeconds: new Gauge({
      name: 'ftd_exporter_last_successful_poll_timestamp_seconds',
      help: 'Unix timestamp of the last successful poll.',
      registers,
    }),
    cacheAgeSeconds: new Gauge({
      name: 'ftd_exporter_cache_age_seconds',
      help: 'Age of the currently served snapshot, computed at scrape time.',
      registers,
      collect() {
        if (options.cacheAgeSecondsCollect !== undefined) {
          this.set(options.cacheAgeSecondsCollect());
        }
      },
    }),
    pollDurationSeconds: new Histogram({
      name: 'ftd_exporter_poll_duration_seconds',
      help: 'Poll cycle latency.',
      // prom-client's default buckets top out at 10s — fine for a
      // single-request SCC cycle, but a realistic 250-request FMC cycle can
      // land anywhere from ~12s to ~130s, all of which would collapse into
      // the same +Inf bucket and make the histogram unable to distinguish a
      // slow cycle from a badly degraded one (DESIGN.md §11's stated
      // purpose for this metric). Extended out to 300s, comfortably past
      // REQUEST_TIMEOUT_SECONDS's usual range; per-backend bucket sets are
      // still plan Stage 9's own "where later adjustment is likely" note,
      // not a metric rename, so patch-safe to revisit.
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180, 300],
      registers,
    }),
    pollTotal: new Counter({
      name: 'ftd_exporter_poll_total',
      help: 'Total poll cycles attempted.',
      registers,
    }),
    pollErrorsTotal: new Counter({
      name: 'ftd_exporter_poll_errors_total',
      help: 'Poll cycle failures, by reason.',
      labelNames: ['reason'],
      registers,
    }),
    upstreamRequestsTotal: new Counter({
      name: 'ftd_exporter_upstream_requests_total',
      help: 'Upstream HTTP requests, by templated endpoint and status code.',
      labelNames: ['endpoint', 'status_code'],
      registers,
    }),
    upstreamRequestDurationSeconds: new Histogram({
      name: 'ftd_exporter_upstream_request_duration_seconds',
      help: 'Upstream HTTP request latency, by templated endpoint.',
      // Same bug class as pollDurationSeconds above: prom-client's default
      // buckets top out at 10s, but REQUEST_TIMEOUT_SECONDS defaults to 30 —
      // every request between 10s and the timeout (the "Cisco is getting
      // slow" signal this metric exists to catch, DESIGN.md §11) would
      // otherwise collapse into +Inf. Extended out to 60s, comfortably past
      // a single request's timeout (distinct from pollDurationSeconds's
      // 300s, which bounds a whole multi-request FMC cycle).
      buckets: [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60],
      labelNames: ['endpoint'],
      registers,
    }),
    devices: new Gauge({
      name: 'ftd_exporter_devices',
      help: 'Devices in the current snapshot.',
      registers,
    }),
    devicesDiscovered: new Gauge({
      name: 'ftd_exporter_devices_discovered',
      help: 'FMC backend: devices found by discovery.',
      registers,
    }),
    discoveryErrorsTotal: new Counter({
      name: 'ftd_exporter_discovery_errors_total',
      help: 'FMC backend: discovery failures.',
      registers,
    }),
    sccInventoryErrorsTotal: new Counter({
      name: 'ftd_exporter_scc_inventory_errors_total',
      help: 'SCC backend: device-inventory poll failures.',
      registers,
    }),
    series: new Gauge({
      name: 'ftd_exporter_series',
      help: 'Series currently rendered on /metrics.',
      registers,
    }),
    parseErrorsTotal: new Counter({
      name: 'ftd_exporter_parse_errors_total',
      help: 'Parse failures, by metric group.',
      labelNames: ['group'],
      registers,
    }),
    unknownEnumTotal: new Counter({
      name: 'ftd_exporter_unknown_enum_total',
      help: 'Unrecognized upstream enum values encountered while rendering, by metric and value.',
      labelNames: ['metric', 'value'],
      registers,
    }),
    fmcTokenRefreshesTotal: new Counter({
      name: 'ftd_exporter_fmc_token_refreshes_total',
      help: 'FMC backend: token refreshes.',
      registers,
    }),
    fmcTokenReauthsTotal: new Counter({
      name: 'ftd_exporter_fmc_token_reauths_total',
      help: 'FMC backend: full re-authentications.',
      registers,
    }),
    fmcTokenExpiryTimestampSeconds: new Gauge({
      name: 'ftd_exporter_fmc_token_expiry_timestamp_seconds',
      help: 'FMC backend: current token expiry, unix seconds.',
      registers,
    }),
    tlsVerificationDisabled: new Gauge({
      name: 'ftd_exporter_tls_verification_disabled',
      help: '1 if TLS verification is disabled for the upstream backend.',
      registers,
    }),
    rateLimitDeferralsTotal: new Counter({
      name: 'ftd_exporter_rate_limit_deferrals_total',
      help: 'Times a request was delayed by the internal rate limiter.',
      registers,
    }),
  };
}
