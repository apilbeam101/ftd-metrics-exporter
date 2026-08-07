import { Gauge, type Registry } from 'prom-client';

/**
 * Declarations only (DESIGN.md §4.2) — population happens in collector.ts.
 * Every metric is constructed with `registers: [registry]` explicitly so it
 * is never auto-registered to prom-client's shared default registry; that
 * default-registry behavior is what makes constructing the same metric
 * twice across two tests throw "already registered" — passing an explicit
 * registry keeps every registry (and every test) independent.
 *
 * Nothing here calls `.set()`/`.reset()`. This module only shapes the
 * metric surface — the frozen public API per DESIGN.md §13.
 */

const DEVICE_LABELS = ['device_uid', 'device_name'] as const;
const COMPONENT_LABELS = [...DEVICE_LABELS, 'component'] as const;
const INTERFACE_LABELS = [
  ...DEVICE_LABELS,
  'interface',
  'interface_name',
  'interface_type',
] as const;
const INTERFACE_DUPLEX_LABELS = [...INTERFACE_LABELS, 'duplex_mode'] as const;
const FAN_LABELS = [...DEVICE_LABELS, 'fan'] as const;
const PSU_LABELS = [...DEVICE_LABELS, 'psu'] as const;
const HA_STATUS_LABELS = [...DEVICE_LABELS, 'status'] as const;
const HA_INFO_LABELS = [...DEVICE_LABELS, 'node_type'] as const;
const TUNNEL_LABELS = [...DEVICE_LABELS, 'tunnel_id', 'tunnel_name', 'state'] as const;

export interface DeviceMetrics {
  cpuUsageRatio: Gauge<(typeof COMPONENT_LABELS)[number]>;
  memoryUsageRatio: Gauge<(typeof COMPONENT_LABELS)[number]>;
  diskUsageRatio: Gauge<(typeof DEVICE_LABELS)[number]>;

  interfaceInputBytesAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceOutputBytesAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceInputPacketSizeAvgBytes: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceOutputPacketSizeAvgBytes: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceInputErrorsAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceOutputErrorsAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceDropPacketsAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceBufferOverrunsAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceBufferUnderrunsAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceL2DecodeDropsAvg: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceLinkUp: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceOperationalUp: Gauge<(typeof INTERFACE_LABELS)[number]>;
  interfaceDuplexInfo: Gauge<(typeof INTERFACE_DUPLEX_LABELS)[number]>;

  chassisFanRpm: Gauge<(typeof FAN_LABELS)[number]>;
  chassisPsuFanUp: Gauge<(typeof PSU_LABELS)[number]>;
  chassisPsuInputUp: Gauge<(typeof PSU_LABELS)[number]>;
  chassisPsuOutputUp: Gauge<(typeof PSU_LABELS)[number]>;

  haNodeStatus: Gauge<(typeof HA_STATUS_LABELS)[number]>;
  haNodeInfo: Gauge<(typeof HA_INFO_LABELS)[number]>;

  ravpnSessionsActiveAvg: Gauge<(typeof DEVICE_LABELS)[number]>;
  ravpnSessionsInactiveAvg: Gauge<(typeof DEVICE_LABELS)[number]>;
  ravpnSessionsPeakConcurrent: Gauge<(typeof DEVICE_LABELS)[number]>;

  s2sTunnelState: Gauge<(typeof TUNNEL_LABELS)[number]>;

  healthWindowStartTimestampSeconds: Gauge<(typeof DEVICE_LABELS)[number]>;
  healthWindowEndTimestampSeconds: Gauge<(typeof DEVICE_LABELS)[number]>;
}

/** Every gauge in `DeviceMetrics`, for reset-all/enumerate-all callers (collector.ts, series counting). */
export function allDeviceGauges(metrics: DeviceMetrics): Gauge<string>[] {
  return Object.values(metrics);
}

export function createDeviceMetrics(registry: Registry): DeviceMetrics {
  const registers = [registry];

  return {
    cpuUsageRatio: new Gauge({
      name: 'ftd_cpu_usage_ratio',
      help: 'Average CPU utilization over the sample window, 0-1.',
      labelNames: COMPONENT_LABELS,
      registers,
    }),
    memoryUsageRatio: new Gauge({
      name: 'ftd_memory_usage_ratio',
      help: 'Average memory utilization over the sample window, 0-1.',
      labelNames: COMPONENT_LABELS,
      registers,
    }),
    diskUsageRatio: new Gauge({
      name: 'ftd_disk_usage_ratio',
      help: 'Average disk utilization over the sample window, 0-1.',
      labelNames: DEVICE_LABELS,
      registers,
    }),

    interfaceInputBytesAvg: new Gauge({
      name: 'ftd_interface_input_bytes_avg',
      help: 'Average inbound byte counter over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceOutputBytesAvg: new Gauge({
      name: 'ftd_interface_output_bytes_avg',
      help: 'Average outbound byte counter over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceInputPacketSizeAvgBytes: new Gauge({
      name: 'ftd_interface_input_packet_size_avg_bytes',
      help: 'Average inbound packet size over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceOutputPacketSizeAvgBytes: new Gauge({
      name: 'ftd_interface_output_packet_size_avg_bytes',
      help: 'Average outbound packet size over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceInputErrorsAvg: new Gauge({
      name: 'ftd_interface_input_errors_avg',
      help: 'Average inbound error count over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceOutputErrorsAvg: new Gauge({
      name: 'ftd_interface_output_errors_avg',
      help: 'Average outbound error count over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceDropPacketsAvg: new Gauge({
      name: 'ftd_interface_drop_packets_avg',
      help: 'Average dropped packet count over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceBufferOverrunsAvg: new Gauge({
      name: 'ftd_interface_buffer_overruns_avg',
      help: 'Average buffer overrun count over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceBufferUnderrunsAvg: new Gauge({
      name: 'ftd_interface_buffer_underruns_avg',
      help: 'Average buffer underrun count over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceL2DecodeDropsAvg: new Gauge({
      name: 'ftd_interface_l2_decode_drops_avg',
      help: 'Average L2 decode drop count over the sample window.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceLinkUp: new Gauge({
      name: 'ftd_interface_link_up',
      help: '1 if the interface link is up, 0 if down. Omitted when link status is unrecognized.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceOperationalUp: new Gauge({
      name: 'ftd_interface_operational_up',
      help: '1 if the interface is operationally up, 0 if down. Omitted when operational status is unrecognized.',
      labelNames: INTERFACE_LABELS,
      registers,
    }),
    interfaceDuplexInfo: new Gauge({
      name: 'ftd_interface_duplex_info',
      help: 'Always 1. Informational; duplex_mode carries the reported value.',
      labelNames: INTERFACE_DUPLEX_LABELS,
      registers,
    }),

    chassisFanRpm: new Gauge({
      name: 'ftd_chassis_fan_rpm',
      help: 'Chassis fan speed in RPM.',
      labelNames: FAN_LABELS,
      registers,
    }),
    chassisPsuFanUp: new Gauge({
      name: 'ftd_chassis_psu_fan_up',
      help: '1 if the PSU fan status is up, 0 if down. Omitted when unrecognized.',
      labelNames: PSU_LABELS,
      registers,
    }),
    chassisPsuInputUp: new Gauge({
      name: 'ftd_chassis_psu_input_up',
      help: '1 if the PSU input status is up, 0 if down. Omitted when unrecognized.',
      labelNames: PSU_LABELS,
      registers,
    }),
    chassisPsuOutputUp: new Gauge({
      name: 'ftd_chassis_psu_output_up',
      help: '1 if the PSU output status is up, 0 if down. Omitted when unrecognized.',
      labelNames: PSU_LABELS,
      registers,
    }),

    haNodeStatus: new Gauge({
      name: 'ftd_ha_node_status',
      help: 'State set: exactly one status label is 1 for a given device.',
      labelNames: HA_STATUS_LABELS,
      registers,
    }),
    haNodeInfo: new Gauge({
      name: 'ftd_ha_node_info',
      help: 'Always 1. Informational; node_type carries the HA role.',
      labelNames: HA_INFO_LABELS,
      registers,
    }),

    ravpnSessionsActiveAvg: new Gauge({
      name: 'ftd_ravpn_sessions_active_avg',
      help: 'Average active RA VPN session count over the sample window.',
      labelNames: DEVICE_LABELS,
      registers,
    }),
    ravpnSessionsInactiveAvg: new Gauge({
      name: 'ftd_ravpn_sessions_inactive_avg',
      help: 'Average inactive RA VPN session count over the sample window.',
      labelNames: DEVICE_LABELS,
      registers,
    }),
    ravpnSessionsPeakConcurrent: new Gauge({
      name: 'ftd_ravpn_sessions_peak_concurrent',
      help: 'Peak concurrent RA VPN session count over the sample window.',
      labelNames: DEVICE_LABELS,
      registers,
    }),

    s2sTunnelState: new Gauge({
      name: 'ftd_s2s_tunnel_state',
      help: 'State set: exactly one state label is 1 for a given tunnel.',
      labelNames: TUNNEL_LABELS,
      registers,
    }),

    healthWindowStartTimestampSeconds: new Gauge({
      name: 'ftd_health_window_start_timestamp_seconds',
      help: 'Start of the averaging window this snapshot describes, unix seconds.',
      labelNames: DEVICE_LABELS,
      registers,
    }),
    healthWindowEndTimestampSeconds: new Gauge({
      name: 'ftd_health_window_end_timestamp_seconds',
      help: 'End of the averaging window this snapshot describes, unix seconds.',
      labelNames: DEVICE_LABELS,
      registers,
    }),
  };
}
