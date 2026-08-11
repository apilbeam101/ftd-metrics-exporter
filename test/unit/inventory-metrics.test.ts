import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Registry } from 'prom-client';
import {
  allDeviceInventoryGauges,
  createDeviceInventoryMetrics,
} from '../../src/metrics/inventory-metrics.ts';

/**
 * Same regression guard as device-metrics.test.ts's "allDeviceGauges()
 * enumerates every ftd_* gauge" test, for the inventory-metrics module.
 */
test('allDeviceInventoryGauges() enumerates every ftd_* gauge createDeviceInventoryMetrics registers', () => {
  const registry = new Registry();
  const metrics = createDeviceInventoryMetrics(registry);

  const registeredNames = new Set(registry.getMetricsAsArray().map((m) => m.name));
  const enumeratedNames = new Set(
    allDeviceInventoryGauges(metrics).map((g) => (g as unknown as { name: string }).name),
  );

  assert.equal(enumeratedNames.size, registeredNames.size);
  for (const name of registeredNames) {
    assert.ok(
      enumeratedNames.has(name),
      `allDeviceInventoryGauges() is missing registered metric ${name}`,
    );
  }
  for (const name of enumeratedNames) {
    assert.ok(
      name.startsWith('ftd_'),
      `allDeviceInventoryGauges() enumerated a non-ftd_* metric: ${name}`,
    );
  }
});

test('every gauge returned by allDeviceInventoryGauges() is cleared by calling reset() on it', () => {
  const registry = new Registry();
  const metrics = createDeviceInventoryMetrics(registry);
  for (const gauge of allDeviceInventoryGauges(metrics)) {
    gauge.set({}, 1);
  }
  for (const gauge of allDeviceInventoryGauges(metrics)) {
    gauge.reset();
  }
  for (const gauge of allDeviceInventoryGauges(metrics)) {
    assert.deepEqual((gauge as unknown as { hashMap: Record<string, unknown> }).hashMap, {});
  }
});
