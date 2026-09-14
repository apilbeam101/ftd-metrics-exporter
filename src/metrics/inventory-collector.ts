import type { Counter } from 'prom-client';
import type { DeviceInventoryEntry } from '../domain/device-inventory.ts';
import { lowercaseEnumLabel } from '../domain/enums.ts';
import {
  classifyConfigState,
  classifyConflictDetectionState,
  classifyConnectivityState,
  classifyDeviceComplianceStatus,
  classifyDeviceLicenseStatus,
  classifyHaNodeType,
  classifyHaRole,
  classifyRedundancyMode,
  type InfoEnumResult,
} from './enum-render.ts';
import { allDeviceInventoryGauges, type DeviceInventoryMetrics } from './inventory-metrics.ts';

/**
 * Renders `DeviceInventoryEntry[]` (SCC device inventory) into
 * `ftd_device_info`, `ftd_device_connectivity_up` (DESIGN.md §4.6.1),
 * `ftd_device_status_info`, and `ftd_device_ha_role_info` (§4.6.3).
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
  //
  // The label key is built via JSON.stringify on sorted [key, value] pairs,
  // not string concatenation — several labels here now carry unvalidated
  // upstream passthrough values (serial, software_version), and a `,`/`=`
  // inside one of those could otherwise collide two genuinely distinct
  // series onto the same tripwire key (review finding, pre-commit).
  const gaugeIndex = new Map<object, number>();
  const seenSeries = new Set<string>();
  function trackSet(gauge: object, labels: Record<string, string>): void {
    let index = gaugeIndex.get(gauge);
    if (index === undefined) {
      index = gaugeIndex.size;
      gaugeIndex.set(gauge, index);
    }
    const sortedPairs = Object.keys(labels)
      .sort()
      .map((key) => [key, labels[key]]);
    seenSeries.add(`${index}${JSON.stringify(sortedPairs)}`);
  }

  // Absence isn't a new enum value -- no diagnostic, just the bounded
  // fallback label, same distinction the rest of this module's callers
  // (collector.ts) make between "field missing" and "value unrecognized".
  function classifyOptionalInfoEnum(
    raw: string | undefined,
    classify: (raw: string) => InfoEnumResult,
  ): InfoEnumResult {
    return raw !== undefined ? classify(raw) : { label: 'unknown' };
  }

  function recordUnrecognized(metric: string, result: InfoEnumResult): void {
    if (result.unrecognizedRawValue !== undefined) {
      unknownEnumTotal.inc({ metric, value: lowercaseEnumLabel(result.unrecognizedRawValue) });
    }
  }

  for (const device of entries) {
    const d = { device_uid: device.deviceUid, device_name: device.deviceName };

    const redundancyModeResult = classifyOptionalInfoEnum(
      device.redundancyMode,
      classifyRedundancyMode,
    );
    const infoLabels = {
      ...d,
      redundancy_mode: redundancyModeResult.label,
      software_version: device.softwareVersion ?? '',
      serial: device.serial ?? '',
      performance_tier: device.ftdPerformanceTier ?? '',
    };
    metrics.deviceInfo.set(infoLabels, 1);
    trackSet(metrics.deviceInfo, infoLabels);
    recordUnrecognized('ftd_device_info', redundancyModeResult);

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

    const configStateResult = classifyOptionalInfoEnum(device.configState, classifyConfigState);
    const conflictDetectionResult = classifyOptionalInfoEnum(
      device.conflictDetectionState,
      classifyConflictDetectionState,
    );
    const licenseStatusResult = classifyOptionalInfoEnum(
      device.licenseStatus,
      classifyDeviceLicenseStatus,
    );
    const complianceStatusResult = classifyOptionalInfoEnum(
      device.complianceStatus,
      classifyDeviceComplianceStatus,
    );
    const statusLabels = {
      ...d,
      config_state: configStateResult.label,
      conflict_detection_state: conflictDetectionResult.label,
      license_status: licenseStatusResult.label,
      compliance_status: complianceStatusResult.label,
    };
    metrics.deviceStatusInfo.set(statusLabels, 1);
    trackSet(metrics.deviceStatusInfo, statusLabels);
    recordUnrecognized('ftd_device_status_info', configStateResult);
    recordUnrecognized('ftd_device_status_info', conflictDetectionResult);
    recordUnrecognized('ftd_device_status_info', licenseStatusResult);
    recordUnrecognized('ftd_device_status_info', complianceStatusResult);

    for (const node of device.haNodes ?? []) {
      const roleResult = classifyOptionalInfoEnum(node.role, classifyHaRole);
      // node.nodeType is mapper-assigned from which ftdHaInfo key the node
      // came from, not upstream-driven — always exactly "PRIMARY"/
      // "SECONDARY" — but still classified rather than trusted raw, so this
      // stays correct if that ever changes. It is the join key back to
      // ftd_ha_node_info's own node_type label (review finding, pre-commit):
      // node_name/device_name give no other series in common with this one.
      const nodeTypeResult = classifyHaNodeType(node.nodeType);
      const haRoleLabels = {
        ...d,
        node_name: node.nodeName,
        node_type: nodeTypeResult.label,
        role: roleResult.label,
      };
      metrics.deviceHaRoleInfo.set(haRoleLabels, 1);
      trackSet(metrics.deviceHaRoleInfo, haRoleLabels);
      recordUnrecognized('ftd_device_ha_role_info', roleResult);
      recordUnrecognized('ftd_device_ha_role_info', nodeTypeResult);
    }
  }

  return { seriesCount: seenSeries.size };
}
