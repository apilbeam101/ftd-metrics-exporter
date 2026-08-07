import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from 'prom-client';
import { createDeviceMetrics } from '../../src/metrics/device-metrics.ts';
import { createRegistry } from '../../src/metrics/registry.ts';
import { createSelfMetrics } from '../../src/metrics/self.ts';

test('createSelfMetrics declares every ftd_exporter_* metric named in DESIGN.md §11', async () => {
  const registry = new Registry();
  createSelfMetrics(registry);
  const text = await registry.metrics();
  const expectedNames = [
    'ftd_exporter_up',
    'ftd_exporter_build_info',
    'ftd_exporter_last_successful_poll_timestamp_seconds',
    'ftd_exporter_cache_age_seconds',
    'ftd_exporter_poll_duration_seconds',
    'ftd_exporter_poll_total',
    'ftd_exporter_poll_errors_total',
    'ftd_exporter_upstream_requests_total',
    'ftd_exporter_upstream_request_duration_seconds',
    'ftd_exporter_devices',
    'ftd_exporter_devices_discovered',
    'ftd_exporter_discovery_errors_total',
    'ftd_exporter_series',
    'ftd_exporter_parse_errors_total',
    'ftd_exporter_unknown_enum_total',
    'ftd_exporter_fmc_token_refreshes_total',
    'ftd_exporter_fmc_token_reauths_total',
    'ftd_exporter_fmc_token_expiry_timestamp_seconds',
    'ftd_exporter_tls_verification_disabled',
    'ftd_exporter_rate_limit_deferrals_total',
  ];
  for (const name of expectedNames) {
    assert.match(text, new RegExp(`# TYPE ${name} `), `missing declaration for ${name}`);
  }
});

// --- Regression: `_total` suffix must imply `counter`, never `gauge` (Prometheus
// naming-conventions audit, finding A) — checked across the whole registered
// metric surface, not just the two names the audit happened to find. ---

test('every metric with a _total-suffixed name is declared as a counter, on both the self-metric and device-metric registries', async () => {
  for (const registry of [
    (() => {
      const r = new Registry();
      createSelfMetrics(r);
      return r;
    })(),
    (() => {
      const r = new Registry();
      createDeviceMetrics(r);
      return r;
    })(),
  ]) {
    const text = await registry.metrics();
    const typeLines = text.matchAll(/^# TYPE (\S+) (\S+)$/gm);
    for (const [, name, type] of typeLines) {
      if (name?.endsWith('_total')) {
        assert.equal(type, 'counter', `${name} ends in _total but is declared as ${type}`);
      }
    }
  }
});

test('upstream_request_duration_seconds buckets extend past a plausible REQUEST_TIMEOUT_SECONDS value (30s default)', async () => {
  const registry = new Registry();
  const self = createSelfMetrics(registry);
  self.upstreamRequestDurationSeconds.observe({ endpoint: 'test' }, 30);
  const text = await registry.metrics();
  const bucketLines = [
    ...text.matchAll(
      /ftd_exporter_upstream_request_duration_seconds_bucket\{[^}]*le="(\d+(?:\.\d+)?)"/g,
    ),
  ];
  const upperBounds = bucketLines.map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
  assert.ok(upperBounds.length > 0);
  assert.ok(
    Math.max(...upperBounds) > 30,
    'no bucket upper bound exceeds a 30s request timeout — a slow request would collapse into +Inf',
  );
});

test('ftd_exporter_cache_age_seconds is computed at scrape time via a collect callback, not a stored value', async () => {
  const registry = new Registry();
  let calls = 0;
  const self = createSelfMetrics(registry, {
    cacheAgeSecondsCollect: () => {
      calls++;
      return calls * 10;
    },
  });

  const first = await self.cacheAgeSeconds.get();
  assert.equal(first.values[0]?.value, 10);
  const second = await self.cacheAgeSeconds.get();
  assert.equal(second.values[0]?.value, 20);
});

test('a counter survives a poll-metrics scrape: ftd_exporter_poll_total is never reset by rendering device metrics', async () => {
  const registry = new Registry();
  const self = createSelfMetrics(registry);
  self.pollTotal.inc();
  self.pollTotal.inc();
  await registry.metrics();
  await registry.metrics();
  const value = await self.pollTotal.get();
  assert.equal(value.values[0]?.value, 2);
});

test('createRegistry(true) includes default Node.js process metrics; createRegistry(false) does not', async () => {
  const withDefaults = createRegistry(true);
  const withoutDefaults = createRegistry(false);
  const withText = await withDefaults.metrics();
  const withoutText = await withoutDefaults.metrics();
  assert.match(withText, /process_cpu_user_seconds_total/);
  assert.doesNotMatch(withoutText, /process_cpu_user_seconds_total/);
});
