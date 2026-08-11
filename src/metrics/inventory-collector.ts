import type { Counter } from 'prom-client';
import type { DeviceInventoryEntry } from '../domain/device-inventory.ts';
import { lowercaseEnumLabel } from '../domain/enums.ts';
import { classifyConnectivityState, classifyRedundancyMode } from './enum-render.ts';
import { allDeviceInventoryGauges, type DeviceInventoryMetrics } from './inventory-metrics.ts';

/**
 * Renders `DeviceInventoryEntry[]` (SCC device inventory) into
 * `ftd_device_info`/`ftd_device_connectivity_up` (DESIGN.md §4.6.1).
 * Same reset-then-repopulate + single synchronous pass discipline as
 * collector.ts's `renderDeviceMetrics`, on its own gauge set so it can be
 * called independently on the render path without disturbing the
 * health-snapshot gauges — see index.ts's `renderMetrics` wiring, which
 * calls this right after `renderDeviceMetrics` in the same synchronous pass.
 */
export interface InventoryCollectorDeps {
  metrics: DeviceInventoryMetrics;
  unknownEnumTotal: Counter<'metric' | 'value'>;
}

export interface InventoryRenderResult {
  seriesCount: number;
}

export function renderDeviceInventoryMetrics(
  deps: InventoryCollectorDeps,
  entries: readonly DeviceInventoryEntry[],
): InventoryRenderResult {
  const { metrics, unknownEnumTotal } = deps;

  for (const gauge of allDeviceInventoryGauges(metrics)) {
    gauge.reset();
  }

  // Same cardinality-tripwire discipline as collector.ts's renderDeviceMetrics:
  // count distinct rendered series (by gauge identity + label set), not one
  // per set() call — ftd_exporter_series (DESIGN.md §11) is meant to reflect
  // what's actually exposed on /metrics across BOTH device gauge sets, and
  // this feature's whole premise is that its device count is not bounded by
  // health/metrics, so it must contribute to that same tripwire.
  const gaugeIndex = new Map<object, number>();
  const seenSeries = new Set<string>();
  function trackSet(gauge: object, labels: Record<string, string>): void {
    let index = gaugeIndex.get(gauge);
    if (index === undefined) {
      index = gaugeIndex.size;
      gaugeIndex.set(gauge, index);
    }
    const labelKey = Object.keys(labels)
      .sort()
      .map((key) => `${key}=${labels[key]}`)
      .join(',');
    seenSeries.add(`${index}{${labelKey}}`);
  }

  for (const device of entries) {
    const d = { device_uid: device.deviceUid, device_name: device.deviceName };

    // Absence isn't a new enum value -- no diagnostic, just the bounded
    // fallback label, same distinction the rest of this module's callers
    // (collector.ts) make between "field missing" and "value unrecognized".
    const redundancyModeResult =
      device.redundancyMode !== undefined
        ? classifyRedundancyMode(device.redundancyMode)
        : { label: 'unknown' as const };
    const infoLabels = { ...d, redundancy_mode: redundancyModeResult.label };
    metrics.deviceInfo.set(infoLabels, 1);
    trackSet(metrics.deviceInfo, infoLabels);
    if (redundancyModeResult.unrecognizedRawValue !== undefined) {
      unknownEnumTotal.inc({
        metric: 'ftd_device_info',
        value: lowercaseEnumLabel(redundancyModeResult.unrecognizedRawValue),
      });
    }

    const connectivityResult = classifyConnectivityState(device.connectivityState);
    if (connectivityResult.kind === 'recognized') {
      metrics.deviceConnectivityUp.set(d, connectivityResult.value);
      trackSet(metrics.deviceConnectivityUp, d);
    } else if (connectivityResult.kind === 'unrecognized') {
      unknownEnumTotal.inc({
        metric: 'ftd_device_connectivity_up',
        value: lowercaseEnumLabel(connectivityResult.rawValue),
      });
    }
  }

  return { seriesCount: seenSeries.size };
}
