import type { Counter, Gauge } from 'prom-client';
import {
  HA_NODE_STATUS_VALUES,
  lowercaseEnumLabel,
  TUNNEL_STATE_VALUES,
  tunnelStateLabel,
} from '../domain/enums.ts';
import type { DeviceHealthSnapshot } from '../domain/snapshot.ts';
import type { DeviceMetrics } from './device-metrics.ts';
import {
  classifyBinaryEnum,
  classifyHaNodeStatus,
  classifyHaNodeType,
  classifyTunnelState,
} from './enum-render.ts';

/**
 * The custom collector (DESIGN.md §4.8). Rather than relying on
 * prom-client's per-metric async `collect` option — which would spread the
 * reset-then-repopulate invariant across ~25 independent callbacks with no
 * shared ordering guarantee — this module owns rendering explicitly: the
 * HTTP layer (a later stage) calls `renderDeviceMetrics` synchronously
 * immediately before asking the registry for its text form. Every `reset()`
 * and every `.set()` call below happens in one synchronous pass with no
 * `await` in between, which is what makes two overlapping renders safe: in
 * single-threaded JS, the second render's mutations cannot interleave with
 * the first's, because the first has no yield point to interleave at
 * (verified by test in collector.test.ts). This satisfies the same
 * atomicity DESIGN.md §2.2 requires of the cache swap itself.
 *
 * Self-metrics are untouched here except for the two that only the renderer
 * can compute — `ftd_exporter_series` (needs the post-render series
 * count) and `ftd_exporter_unknown_enum_total` (needs render-time enum
 * recognition, DESIGN.md §3.2.6/§4.4). Every other `ftd_exporter_*` metric
 * belongs to later stages (poll cycle, HTTP client, discovery) and must
 * never be reset here — see self.ts.
 */

export interface DeviceCollectorDeps {
  metrics: DeviceMetrics;
  unknownEnumTotal: Counter<'metric' | 'value'>;
  series: Gauge<string>;
}

export interface RenderResult {
  seriesCount: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function renderDeviceMetrics(
  deps: DeviceCollectorDeps,
  snapshots: readonly DeviceHealthSnapshot[],
): RenderResult {
  const { metrics, unknownEnumTotal } = deps;

  for (const gauge of Object.values(metrics)) {
    gauge.reset();
  }

  // Keyed by gauge identity + a stable serialization of its label set, not
  // incremented per `set()` call — an upstream duplicate (two S2S tunnels
  // sharing a tunnelId/tunnelName, for instance; the mapper does not dedupe
  // tunnels) resolves to one series in prom-client's label-hashed storage,
  // and `ftd_exporter_series` (the cardinality tripwire, plan test 11)
  // must report that same one series, not one count per `set()` call.
  // `Gauge<T>`'s public type does not expose `name`, so gauge identity is
  // established via a per-render index rather than reading an undocumented
  // runtime property.
  const gaugeIndex = new Map<Gauge<string>, number>();
  const seenSeries = new Set<string>();

  const set = <T extends string>(
    gauge: Gauge<T>,
    labels: Partial<Record<T, string>>,
    value: number,
  ): void => {
    gauge.set(labels, value);
    const asUntyped = gauge as unknown as Gauge<string>;
    let index = gaugeIndex.get(asUntyped);
    if (index === undefined) {
      index = gaugeIndex.size;
      gaugeIndex.set(asUntyped, index);
    }
    const labelKey = Object.keys(labels)
      .sort()
      .map((key) => `${key}=${labels[key as T]}`)
      .join(',');
    seenSeries.add(`${index}{${labelKey}}`);
  };

  for (const device of snapshots) {
    const deviceUid = device.deviceUid;
    const deviceName = device.deviceName;
    const d = { device_uid: deviceUid, device_name: deviceName };

    if (device.cpu !== undefined) {
      if (device.cpu.lina !== undefined)
        set(metrics.cpuUsageRatio, { ...d, component: 'lina' }, device.cpu.lina / 100);
      if (device.cpu.snort !== undefined)
        set(metrics.cpuUsageRatio, { ...d, component: 'snort' }, device.cpu.snort / 100);
      if (device.cpu.system !== undefined)
        set(metrics.cpuUsageRatio, { ...d, component: 'system' }, device.cpu.system / 100);
    }

    if (device.memory !== undefined) {
      if (device.memory.lina !== undefined)
        set(metrics.memoryUsageRatio, { ...d, component: 'lina' }, device.memory.lina / 100);
      if (device.memory.snort !== undefined)
        set(metrics.memoryUsageRatio, { ...d, component: 'snort' }, device.memory.snort / 100);
      if (device.memory.system !== undefined)
        set(metrics.memoryUsageRatio, { ...d, component: 'system' }, device.memory.system / 100);
    }

    if (device.disk?.totalUsagePercent !== undefined) {
      set(metrics.diskUsageRatio, d, device.disk.totalUsagePercent / 100);
    }

    for (const iface of device.interfaces ?? []) {
      const base = {
        ...d,
        interface: iface.interface,
        interface_name: nonEmpty(iface.interfaceName) ?? iface.interface,
        ...(nonEmpty(iface.interfaceType) !== undefined
          ? { interface_type: iface.interfaceType }
          : {}),
      };

      if (iface.inputBytesAvg !== undefined)
        set(metrics.interfaceInputBytesAvg, base, iface.inputBytesAvg);
      if (iface.outputBytesAvg !== undefined)
        set(metrics.interfaceOutputBytesAvg, base, iface.outputBytesAvg);
      if (iface.inputPacketSizeAvg !== undefined)
        set(metrics.interfaceInputPacketSizeAvgBytes, base, iface.inputPacketSizeAvg);
      if (iface.outputPacketSizeAvg !== undefined)
        set(metrics.interfaceOutputPacketSizeAvgBytes, base, iface.outputPacketSizeAvg);
      if (iface.inputErrorsAvg !== undefined)
        set(metrics.interfaceInputErrorsAvg, base, iface.inputErrorsAvg);
      if (iface.outputErrorsAvg !== undefined)
        set(metrics.interfaceOutputErrorsAvg, base, iface.outputErrorsAvg);
      if (iface.dropPacketsAvg !== undefined)
        set(metrics.interfaceDropPacketsAvg, base, iface.dropPacketsAvg);
      if (iface.bufferOverrunsAvg !== undefined)
        set(metrics.interfaceBufferOverrunsAvg, base, iface.bufferOverrunsAvg);
      if (iface.bufferUnderrunsAvg !== undefined)
        set(metrics.interfaceBufferUnderrunsAvg, base, iface.bufferUnderrunsAvg);
      if (iface.l2DecodeDropsAvg !== undefined)
        set(metrics.interfaceL2DecodeDropsAvg, base, iface.l2DecodeDropsAvg);

      const linkStatus = classifyBinaryEnum(iface.linkStatus);
      if (linkStatus.kind === 'recognized') {
        set(metrics.interfaceLinkUp, base, linkStatus.value);
      } else if (linkStatus.kind === 'unrecognized') {
        unknownEnumTotal.inc({
          metric: 'ftd_interface_link_up',
          value: lowercaseEnumLabel(linkStatus.rawValue),
        });
      }

      const operationalStatus = classifyBinaryEnum(iface.operationalStatus);
      if (operationalStatus.kind === 'recognized') {
        set(metrics.interfaceOperationalUp, base, operationalStatus.value);
      } else if (operationalStatus.kind === 'unrecognized') {
        unknownEnumTotal.inc({
          metric: 'ftd_interface_operational_up',
          value: lowercaseEnumLabel(operationalStatus.rawValue),
        });
      }

      const duplexMode = nonEmpty(iface.duplexMode);
      if (duplexMode !== undefined) {
        set(metrics.interfaceDuplexInfo, { ...base, duplex_mode: duplexMode }, 1);
      }
    }

    if (device.chassis !== undefined) {
      for (const fan of device.chassis.fans) {
        set(metrics.chassisFanRpm, { ...d, fan: fan.fan }, fan.rpmAvg);
      }
      for (const psu of device.chassis.psus) {
        const psuLabels = { ...d, psu: psu.psu };

        const fanStatus = classifyBinaryEnum(psu.fanStatus);
        if (fanStatus.kind === 'recognized') {
          set(metrics.chassisPsuFanUp, psuLabels, fanStatus.value);
        } else if (fanStatus.kind === 'unrecognized') {
          unknownEnumTotal.inc({
            metric: 'ftd_chassis_psu_fan_up',
            value: lowercaseEnumLabel(fanStatus.rawValue),
          });
        }

        const inputStatus = classifyBinaryEnum(psu.inputStatus);
        if (inputStatus.kind === 'recognized') {
          set(metrics.chassisPsuInputUp, psuLabels, inputStatus.value);
        } else if (inputStatus.kind === 'unrecognized') {
          unknownEnumTotal.inc({
            metric: 'ftd_chassis_psu_input_up',
            value: lowercaseEnumLabel(inputStatus.rawValue),
          });
        }

        const outputStatus = classifyBinaryEnum(psu.outputStatus);
        if (outputStatus.kind === 'recognized') {
          set(metrics.chassisPsuOutputUp, psuLabels, outputStatus.value);
        } else if (outputStatus.kind === 'unrecognized') {
          unknownEnumTotal.inc({
            metric: 'ftd_chassis_psu_output_up',
            value: lowercaseEnumLabel(outputStatus.rawValue),
          });
        }
      }
    }

    if (device.ha !== undefined) {
      const statusResult = classifyHaNodeStatus(device.ha.nodeStatus);
      for (const value of HA_NODE_STATUS_VALUES) {
        const label = lowercaseEnumLabel(value);
        set(
          metrics.haNodeStatus,
          { ...d, status: label },
          label === statusResult.activeLabel ? 1 : 0,
        );
      }
      if (statusResult.unrecognizedRawValue !== undefined) {
        unknownEnumTotal.inc({
          metric: 'ftd_ha_node_status',
          value: lowercaseEnumLabel(statusResult.unrecognizedRawValue),
        });
      }

      const nodeTypeResult = classifyHaNodeType(device.ha.nodeType);
      set(metrics.haNodeInfo, { ...d, node_type: nodeTypeResult.label }, 1);
      if (nodeTypeResult.unrecognizedRawValue !== undefined) {
        unknownEnumTotal.inc({
          metric: 'ftd_ha_node_info',
          value: lowercaseEnumLabel(nodeTypeResult.unrecognizedRawValue),
        });
      }
    }

    if (device.raVpn !== undefined) {
      if (device.raVpn.activeSessionsAvg !== undefined)
        set(metrics.ravpnSessionsActiveAvg, d, device.raVpn.activeSessionsAvg);
      if (device.raVpn.inactiveSessionsAvg !== undefined)
        set(metrics.ravpnSessionsInactiveAvg, d, device.raVpn.inactiveSessionsAvg);
      if (device.raVpn.peakConcurrentSessions !== undefined)
        set(metrics.ravpnSessionsPeakConcurrent, d, device.raVpn.peakConcurrentSessions);
    }

    for (const tunnel of device.s2sTunnels ?? []) {
      const tunnelResult = classifyTunnelState(tunnel.tunnelState);
      const tunnelLabels = { ...d, tunnel_id: tunnel.tunnelId, tunnel_name: tunnel.tunnelName };
      for (const value of TUNNEL_STATE_VALUES) {
        const label = tunnelStateLabel(value);
        set(
          metrics.s2sTunnelState,
          { ...tunnelLabels, state: label },
          label === tunnelResult.activeLabel ? 1 : 0,
        );
      }
      if (tunnelResult.unrecognizedRawValue !== undefined) {
        unknownEnumTotal.inc({
          metric: 'ftd_s2s_tunnel_state',
          value: lowercaseEnumLabel(tunnelResult.unrecognizedRawValue),
        });
      }
    }

    if (device.windowStart !== undefined) {
      set(metrics.healthWindowStartTimestampSeconds, d, device.windowStart.getTime() / 1000);
    }
    if (device.windowEnd !== undefined) {
      set(metrics.healthWindowEndTimestampSeconds, d, device.windowEnd.getTime() / 1000);
    }
  }

  deps.series.set(seenSeries.size);
  return { seriesCount: seenSeries.size };
}
