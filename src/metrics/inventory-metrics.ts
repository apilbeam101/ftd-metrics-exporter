import { Gauge, type Registry } from 'prom-client';

/**
 * Declarations for the SCC device-inventory metrics (DESIGN.md §4.6.1, built
 * 2026-08-11). Deliberately a separate module from device-metrics.ts: these
 * are populated from a completely different upstream endpoint on its own
 * independent poll cadence (inventory-collector.ts, driven by
 * `SccHealthBackend.getDeviceInventory()`), not from `DeviceHealthSnapshot[]`
 * — conflating the two into one reset-then-repopulate cycle would tie
 * inventory's cadence to the health poll's, which is exactly the coupling
 * this feature's own independent cadence exists to avoid.
 *
 * SCC-only: FMC has no equivalent inventory endpoint wired up. `index.ts`
 * renders these only when the backend is SCC.
 */

const DEVICE_INVENTORY_LABELS = ['device_uid', 'device_name'] as const;
const DEVICE_INFO_LABELS = [...DEVICE_INVENTORY_LABELS, 'redundancy_mode'] as const;

export interface DeviceInventoryMetrics {
  deviceInfo: Gauge<(typeof DEVICE_INFO_LABELS)[number]>;
  deviceConnectivityUp: Gauge<(typeof DEVICE_INVENTORY_LABELS)[number]>;
}

/** Every gauge in `DeviceInventoryMetrics`, for reset-all/enumerate-all callers — mirrors device-metrics.ts's `allDeviceGauges`. */
export function allDeviceInventoryGauges(metrics: DeviceInventoryMetrics): Gauge<string>[] {
  return Object.values(metrics);
}

export function createDeviceInventoryMetrics(registry: Registry): DeviceInventoryMetrics {
  const registers = [registry];

  return {
    deviceInfo: new Gauge({
      name: 'ftd_device_info',
      help: 'Always 1. Informational; from SCC device inventory. redundancy_mode carries standalone/ha (lowercased), or unknown.',
      labelNames: DEVICE_INFO_LABELS,
      registers,
    }),
    deviceConnectivityUp: new Gauge({
      name: 'ftd_device_connectivity_up',
      help: '1 if SCC device inventory reports the device ONLINE, 0 if UNREACHABLE. Independent of the health-metrics poll — populated even for a device absent from every other ftd_* series. Omitted when connectivity state is absent or unrecognized.',
      labelNames: DEVICE_INVENTORY_LABELS,
      registers,
    }),
  };
}
