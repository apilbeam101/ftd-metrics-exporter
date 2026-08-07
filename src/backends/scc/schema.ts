/**
 * Types describing the *upstream* SCC payload shape, verified against
 * Cisco's API documentation and a live capture (DESIGN.md Appendix B).
 * Deliberately not the domain model (DESIGN.md §2.3) — this is what the
 * wire actually looks like, including its "absent means unavailable"
 * conditional groups.
 *
 * All fields are typed `unknown`-adjacent (no runtime guarantees beyond
 * "this is what we observed"); the mapper (Stage 2) is responsible for
 * safely narrowing an actual HTTP response body into this shape.
 */

export interface SccCpuHealthMetrics {
  linaUsageAvg?: number;
  snortUsageAvg?: number;
  systemUsageAvg?: number;
}

export interface SccMemoryHealthMetrics {
  linaUsageAvg?: number;
  snortUsageAvg?: number;
  systemUsageAvg?: number;
}

export interface SccDiskHealthMetrics {
  totalDiskUsageAvg?: number;
}

export interface SccChassisStatsHealthMetrics {
  fan1RpmAvg?: number;
  fan2RpmAvg?: number;
  fan3RpmAvg?: number;
  fan4RpmAvg?: number;
  psu1FanStatus?: string;
  psu1InputStatus?: string;
  psu1OutputStatus?: string;
  psu2FanStatus?: string;
  psu2InputStatus?: string;
  psu2OutputStatus?: string;
}

export interface SccInterfaceHealthMetric {
  /** Hardware id, e.g. "Ethernet1/1". Always present. */
  interface: string;
  /** Human label, e.g. "outside". Optional — confirmed frequently absent. */
  interfaceName?: string;
  interfaceType?: string;
  linkStatus?: string;
  operationalStatus?: string;
  /** Documented; not observed in the initial live sample, but seen since on FMC. */
  duplexMode?: string;
  inputBytesAvg?: number;
  outputBytesAvg?: number;
  inputPacketSizeAvg?: number;
  outputPacketSizeAvg?: number;
  inputErrorsAvg?: number;
  outputErrorsAvg?: number;
  dropPacketsAvg?: number;
  bufferOverrunsAvg?: number;
  bufferUnderrunsAvg?: number;
  l2DecodeDropsAvg?: number;
}

export interface SccHaHealthMetrics {
  nodeStatus?: string;
  nodeType?: string;
}

export interface SccRaVpnSessionHealthMetrics {
  activeRavpnSessionsAvg?: number;
  inactiveRavpnSessionsAvg?: number;
  peakConcurRavpnSessions?: number;
}

export interface SccS2sVpnTunnelHealthMetric {
  tunnelId?: string;
  tunnelName?: string;
  tunnelState?: string;
}

export interface SccDeviceHealthMetrics {
  deviceUid: string;
  deviceName: string;
  /** ISO 8601. */
  startTime?: string;
  /** ISO 8601. */
  endTime?: string;
  cpuHealthMetrics?: SccCpuHealthMetrics;
  memoryHealthMetrics?: SccMemoryHealthMetrics;
  diskHealthMetrics?: SccDiskHealthMetrics;
  chassisStatsHealthMetrics?: SccChassisStatsHealthMetrics;
  interfaceHealthMetrics?: SccInterfaceHealthMetric[];
  haHealthMetrics?: SccHaHealthMetrics;
  raVpnSessionHealthMetrics?: SccRaVpnSessionHealthMetrics;
  s2sVpnTunnelHealthMetrics?: SccS2sVpnTunnelHealthMetric[];
}

/** The full response body: a JSON array, one object per managed device. */
export type SccHealthMetricsResponse = SccDeviceHealthMetrics[];
