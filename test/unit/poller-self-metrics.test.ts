import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRegistry } from '../../src/metrics/registry.ts';
import { createSelfMetrics } from '../../src/metrics/self.ts';
import {
  createSelfMetricsRecorder,
  setBuildInfo,
  setTlsVerificationDisabled,
} from '../../src/poller/self-metrics.ts';

function harness() {
  const registry = createRegistry(false);
  const metrics = createSelfMetrics(registry);
  const recorder = createSelfMetricsRecorder(metrics);
  return { registry, metrics, recorder };
}

test('createSelfMetricsRecorder.onParseError increments parseErrorsTotal by group', async () => {
  const { metrics, recorder } = harness();
  recorder.onParseError({ group: 'cpu', message: 'boom' });
  recorder.onParseError({ group: 'cpu', message: 'boom again' });
  recorder.onParseError({ group: 'memory', message: 'boom' });
  const cpu = await metrics.parseErrorsTotal.get();
  assert.equal(cpu.values.find((v) => v.labels.group === 'cpu')?.value, 2);
  assert.equal(cpu.values.find((v) => v.labels.group === 'memory')?.value, 1);
});

test('createSelfMetricsRecorder.onRateLimitDeferral increments rateLimitDeferralsTotal', async () => {
  const { metrics, recorder } = harness();
  recorder.onRateLimitDeferral();
  recorder.onRateLimitDeferral();
  const result = await metrics.rateLimitDeferralsTotal.get();
  assert.equal(result.values[0]?.value, 2);
});

test('createSelfMetricsRecorder.onUpstreamRequest increments the counter and observes the histogram, both labeled by templated endpoint', async () => {
  const { metrics, recorder } = harness();
  const endpoint = '/v1/inventory/managers/:fmcUid/health/metrics';
  recorder.onUpstreamRequest(endpoint, 200, 0.25);
  const counter = await metrics.upstreamRequestsTotal.get();
  assert.equal(
    counter.values.find((v) => v.labels.endpoint === endpoint && v.labels.status_code === '200')
      ?.value,
    1,
  );
  const histogram = await metrics.upstreamRequestDurationSeconds.get();
  const sumSample = histogram.values.find(
    (v) => v.metricName?.endsWith('_sum') && v.labels.endpoint === endpoint,
  );
  assert.equal(sumSample?.value, 0.25);
});

test('createSelfMetricsRecorder token/discovery hooks wire to the correct metric each', async () => {
  const { metrics, recorder } = harness();
  recorder.onTokenRefresh();
  recorder.onTokenReauth();
  recorder.onTokenExpiryUpdate(1_700_000_000);
  recorder.onDiscoverySuccess(42);
  recorder.onDiscoveryFailure();
  recorder.onSccInventoryError();

  assert.equal((await metrics.fmcTokenRefreshesTotal.get()).values[0]?.value, 1);
  assert.equal((await metrics.fmcTokenReauthsTotal.get()).values[0]?.value, 1);
  assert.equal(
    (await metrics.fmcTokenExpiryTimestampSeconds.get()).values[0]?.value,
    1_700_000_000,
  );
  assert.equal((await metrics.devicesDiscovered.get()).values[0]?.value, 42);
  assert.equal((await metrics.discoveryErrorsTotal.get()).values[0]?.value, 1);
  assert.equal((await metrics.sccInventoryErrorsTotal.get()).values[0]?.value, 1);
});

test('setBuildInfo sets ftd_exporter_build_info to 1 with version/commit/node_version/backend labels', async () => {
  const { metrics } = harness();
  setBuildInfo(metrics, {
    version: '0.1.0',
    commit: 'abc123',
    node_version: 'v24.0.0',
    backend: 'scc',
  });
  const result = await metrics.buildInfo.get();
  assert.equal(result.values[0]?.value, 1);
  assert.deepEqual(result.values[0]?.labels, {
    version: '0.1.0',
    commit: 'abc123',
    node_version: 'v24.0.0',
    backend: 'scc',
  });
});

test('setTlsVerificationDisabled maps boolean true/false to 1/0', async () => {
  const { metrics } = harness();
  setTlsVerificationDisabled(metrics, true);
  assert.equal((await metrics.tlsVerificationDisabled.get()).values[0]?.value, 1);
  setTlsVerificationDisabled(metrics, false);
  assert.equal((await metrics.tlsVerificationDisabled.get()).values[0]?.value, 0);
});
