import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Counter, Registry } from 'prom-client';
import type { LicenseStatus } from '../../src/domain/license-status.ts';
import { renderLicenseMetrics } from '../../src/metrics/license-collector.ts';
import { createLicenseMetrics } from '../../src/metrics/license-metrics.ts';

function harness() {
  const registry = new Registry();
  const metrics = createLicenseMetrics(registry);
  const unknownEnumTotal = new Counter({
    name: 'test_unknown_enum_total',
    help: 'test-only',
    labelNames: ['metric', 'value'],
    registers: [],
  });
  return { registry, metrics, unknownEnumTotal };
}

test('createLicenseMetrics: the four labelless gauges publish no series at construction time, before any render (Opus review finding, 2026-08-14)', async () => {
  // A labelless prom-client Gauge starts life with an implicit
  // `{value: 0}` entry unless explicitly `.remove()`d -- verified directly
  // against prom-client. A registry read taken before the first render
  // (this test never calls renderLicenseMetrics at all) would otherwise
  // publish four false zeros for fields upstream never reported.
  const { registry } = harness();
  const exposition = await registry.metrics();
  for (const name of [
    'ftd_license_eval_used',
    'ftd_license_eval_expires_in_days',
    'ftd_license_last_synchronized_timestamp_seconds',
    'ftd_license_last_renewed_timestamp_seconds',
  ]) {
    // A value line starts at column 0 with the bare metric name (HELP/TYPE
    // comment lines start with "# " and would otherwise false-positive
    // match a plain `.includes()` check, since they also contain the name).
    const valueLinePattern = new RegExp(`^${name} `, 'm');
    assert.equal(
      valueLinePattern.test(exposition),
      false,
      `expected no ${name} value line before the first render:\n${exposition}`,
    );
  }
});

test('renderLicenseMetrics: a full status renders every gauge with no device labels', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const status: LicenseStatus = {
    regStatus: 'REGISTERED',
    authStatus: 'AUTHORIZED',
    evalUsed: true,
    evalExpiresInDays: 0,
    lastSynchronizedTime: new Date('2026-08-11T13:02:22Z'),
    lastRenewedTime: new Date('2026-02-27T10:14:37Z'),
  };
  const result = renderLicenseMetrics({ metrics, unknownEnumTotal }, status);
  assert.equal(result.seriesCount, 6);

  const reg = await metrics.registrationInfo.get();
  assert.deepEqual(reg.values[0]?.labels, { reg_status: 'registered' });
  assert.equal(reg.values[0]?.value, 1);

  const auth = await metrics.authorizationInfo.get();
  assert.deepEqual(auth.values[0]?.labels, { auth_status: 'authorized' });

  assert.equal((await metrics.evalUsed.get()).values[0]?.value, 1);
  assert.equal((await metrics.evalExpiresInDays.get()).values[0]?.value, 0);
  assert.equal(
    (await metrics.lastSynchronizedTimestampSeconds.get()).values[0]?.value,
    new Date('2026-08-11T13:02:22Z').getTime() / 1000,
  );
});

test('renderLicenseMetrics: undefined status resets every gauge to empty, series count 0', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderLicenseMetrics(
    { metrics, unknownEnumTotal },
    {
      regStatus: 'REGISTERED',
      evalUsed: true,
    },
  );
  const result = renderLicenseMetrics({ metrics, unknownEnumTotal }, undefined);
  assert.equal(result.seriesCount, 0);
  assert.equal((await metrics.registrationInfo.get()).values.length, 0);
  assert.equal((await metrics.evalUsed.get()).values.length, 0);
});

test('renderLicenseMetrics: optional fields absent leave their gauges unset (not zero), only regStatus renders', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const result = renderLicenseMetrics({ metrics, unknownEnumTotal }, { regStatus: 'REGISTERED' });
  assert.equal(result.seriesCount, 1);
  assert.equal((await metrics.authorizationInfo.get()).values.length, 0);
  assert.equal((await metrics.evalUsed.get()).values.length, 0);
  assert.equal((await metrics.evalExpiresInDays.get()).values.length, 0);
});

test('renderLicenseMetrics: an unrecognized regStatus renders "unknown" and increments the diagnostic counter', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderLicenseMetrics({ metrics, unknownEnumTotal }, { regStatus: 'SOMETHING_NEW' });
  const reg = await metrics.registrationInfo.get();
  assert.deepEqual(reg.values[0]?.labels, { reg_status: 'unknown' });
  const counter = await unknownEnumTotal.get();
  assert.equal(
    counter.values.find((v) => v.labels.metric === 'ftd_license_registration_info')?.value,
    1,
  );
});

test('renderLicenseMetrics: a genuine evalUsed=false renders 0, not omitted (truthiness guard)', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderLicenseMetrics({ metrics, unknownEnumTotal }, { regStatus: 'REGISTERED', evalUsed: false });
  const evalUsed = await metrics.evalUsed.get();
  assert.equal(evalUsed.values.length, 1);
  assert.equal(evalUsed.values[0]?.value, 0);
});
