import { Gauge, type Registry } from 'prom-client';

/**
 * Declarations for the SCC device-inventory metrics (`ftd_device_info`,
 * `ftd_device_connectivity_up` — DESIGN.md §4.6.1, built 2026-08-11;
 * `ftd_device_status_info`, `ftd_device_ha_role_info` — §4.6.3, built
 * 2026-09-14). Deliberately a separate module from device-metrics.ts: these
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
const DEVICE_INFO_LABELS = [
  ...DEVICE_INVENTORY_LABELS,
  'redundancy_mode',
  'software_version',
  'serial',
  'performance_tier',
] as const;
const DEVICE_STATUS_LABELS = [
  ...DEVICE_INVENTORY_LABELS,
  'config_state',
  'conflict_detection_state',
  'license_status',
  'compliance_status',
] as const;
const DEVICE_HA_ROLE_LABELS = [
  ...DEVICE_INVENTORY_LABELS,
  'node_name',
  'node_type',
  'role',
] as const;

export interface DeviceInventoryMetrics {
  deviceInfo: Gauge<(typeof DEVICE_INFO_LABELS)[number]>;
  deviceConnectivityUp: Gauge<(typeof DEVICE_INVENTORY_LABELS)[number]>;
  deviceStatusInfo: Gauge<(typeof DEVICE_STATUS_LABELS)[number]>;
  deviceHaRoleInfo: Gauge<(typeof DEVICE_HA_ROLE_LABELS)[number]>;
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
      help: 'Always 1. Informational; from SCC device inventory. redundancy_mode carries standalone/ha (lowercased), or unknown. software_version/serial/performance_tier are raw upstream passthrough values, empty string if absent.',
      labelNames: DEVICE_INFO_LABELS,
      registers,
    }),
    deviceConnectivityUp: new Gauge({
      name: 'ftd_device_connectivity_up',
      help: '1 if SCC device inventory reports the device ONLINE, 0 if UNREACHABLE. Independent of the health-metrics poll — populated even for a device absent from every other ftd_* series. Omitted when connectivity state is absent or unrecognized.',
      labelNames: DEVICE_INVENTORY_LABELS,
      registers,
    }),
    deviceStatusInfo: new Gauge({
      name: 'ftd_device_status_info',
      help: 'Always 1. Informational; from SCC device inventory. config_state/conflict_detection_state/license_status/compliance_status carry the lowercased upstream state, or unknown if absent or unrecognized.',
      labelNames: DEVICE_STATUS_LABELS,
      registers,
    }),
    deviceHaRoleInfo: new Gauge({
      name: 'ftd_device_ha_role_info',
      help: 'Always 1. Informational; from SCC device inventory, one series per HA node. role carries active/standby (lowercased), or unknown. Only present for devices in an HA pair. node_name distinguishes the two peer nodes, which otherwise share device_uid and device_name (DESIGN.md §14.14). node_type carries primary/secondary (lowercased) - the same vocabulary ftd_ha_node_info uses for its own node_type label, so the two can be joined on (device_uid, node_type) to relate a node role to its other health-metrics series.',
      labelNames: DEVICE_HA_ROLE_LABELS,
      registers,
    }),
  };
}
