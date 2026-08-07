import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from 'prom-client';
import { allDeviceGauges, createDeviceMetrics } from '../../src/metrics/device-metrics.ts';

/**
 * Regression guard for review finding 8: nothing previously failed if a
 * gauge were added to `createDeviceMetrics`'s return object but omitted
 * from `allDeviceGauges()` (or vice versa) — collector.ts's reset-all loop
 * iterates `Object.values(metrics)` directly today, but any future caller
 * relying on `allDeviceGauges()` (the doc generator already does) would
 * silently miss a family if the two ever drifted apart.
 */
test('allDeviceGauges() enumerates every ftd_* gauge createDeviceMetrics registers — no gauge is added to one without the other', () => {
  const registry = new Registry();
  const metrics = createDeviceMetrics(registry);

  const registeredNames = new Set(registry.getMetricsAsArray().map((m) => m.name));
  const enumeratedNames = new Set(
    allDeviceGauges(metrics).map((g) => (g as unknown as { name: string }).name),
  );

  assert.equal(enumeratedNames.size, registeredNames.size);
  for (const name of registeredNames) {
    assert.ok(enumeratedNames.has(name), `allDeviceGauges() is missing registered metric ${name}`);
  }
  for (const name of enumeratedNames) {
    assert.ok(name.startsWith('ftd_'), `allDeviceGauges() enumerated a non-ftd_* metric: ${name}`);
  }
});

test('every gauge returned by allDeviceGauges() is cleared by calling reset() on it', () => {
  const registry = new Registry();
  const metrics = createDeviceMetrics(registry);
  for (const gauge of allDeviceGauges(metrics)) {
    gauge.set({}, 1);
  }
  for (const gauge of allDeviceGauges(metrics)) {
    gauge.reset();
  }
  // reset() on a labeled gauge with no explicit label set clears its
  // hashMap entirely (prom-client only auto-seeds a bare 0 for
  // zero-label-name gauges) — verifying no leftover entries confirms
  // every gauge in the list is a real, resettable Gauge instance.
  for (const gauge of allDeviceGauges(metrics)) {
    assert.deepEqual((gauge as unknown as { hashMap: Record<string, unknown> }).hashMap, {});
  }
});
