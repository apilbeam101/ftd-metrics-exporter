import { Counter, Gauge, Registry } from 'prom-client';
import type { DeviceHealthSnapshot } from '../../../src/domain/snapshot.ts';
import { renderDeviceMetrics } from '../../../src/metrics/collector.ts';
import { createDeviceMetrics, type DeviceMetrics } from '../../../src/metrics/device-metrics.ts';

/**
 * Test-only rendering harness. Keeps the "unknown enum" counter and
 * "series total" gauge that `renderDeviceMetrics` depends on off the
 * exposed `registry`, so `text()` emits only `ftd_*` device series — the
 * golden files this backs freeze the device metric surface (DESIGN.md
 * §4.2), not the self-metric declarations (self.ts is covered separately).
 */
export interface TestRenderer {
  registry: Registry;
  metrics: DeviceMetrics;
  unknownEnumTotal: Counter<'metric' | 'value'>;
  series: Gauge<string>;
  render(snapshots: readonly DeviceHealthSnapshot[]): { seriesCount: number };
  text(): Promise<string>;
}

export function createTestRenderer(): TestRenderer {
  const registry = new Registry();
  const metrics = createDeviceMetrics(registry);

  const sideRegistry = new Registry();
  const unknownEnumTotal = new Counter({
    name: 'ftd_exporter_unknown_enum_total',
    help: 'test-only',
    labelNames: ['metric', 'value'],
    registers: [sideRegistry],
  });
  const series = new Gauge({
    name: 'ftd_exporter_series',
    help: 'test-only',
    registers: [sideRegistry],
  });

  return {
    registry,
    metrics,
    unknownEnumTotal,
    series,
    render(snapshots) {
      return renderDeviceMetrics({ metrics, unknownEnumTotal, series }, snapshots);
    },
    text() {
      return registry.metrics();
    },
  };
}
