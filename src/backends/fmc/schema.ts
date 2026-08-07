/**
 * Types describing the *upstream* standalone FMC payload shapes, verified
 * against a live lab FMC (v10.0.0, four FTDv devices) for CPU/MEM/
 * DISK_STATS/INTERFACE (DESIGN.md Appendix C, §14.1). HA/VPN/chassis group
 * shapes are documentation-only and unverified on this backend — kept
 * provisional and isolated per DESIGN.md §3.3.5/§13.
 *
 * FMC's `health/aggregatemetrics` wraps one device/one metric-family per
 * request in an `items[]` array — genuinely different from SCC's flat,
 * multi-family-per-device array (DESIGN.md Appendix C). Each item carries
 * its own `startTime`/`endTime` in a non-ISO-8601 format
 * ("YYYY-MM-DD HH:mm:ss.SSS UTC").
 */

export interface FmcCpuHealthMetrics {
  linaUsageAvg?: number;
  snortUsageAvg?: number;
  systemUsageAvg?: number;
}

export interface FmcMemoryHealthMetrics {
  linaUsageAvg?: number;
  snortUsageAvg?: number;
  systemUsageAvg?: number;
}

export interface FmcDiskHealthMetrics {
  totalDiskUsageAvg?: number;
}

/**
 * Verified: the wrapper key is `interfaceHealthMetricsList`, not SCC's
 * `interfaceHealthMetrics` — a genuine naming divergence (DESIGN.md §14.1).
 */
export interface FmcInterfaceHealthMetric {
  /** Hardware id, e.g. "GigabitEthernet0/0". Always present. */
  interface: string;
  interfaceName?: string;
  interfaceType?: string;
  /** Verified: FMC uses `currentLinkStatus`, not SCC's `linkStatus`. */
  currentLinkStatus?: string;
  /** Verified: FMC uses `currentOperationalStatus`, not SCC's `operationalStatus`. */
  currentOperationalStatus?: string;
  /** Verified populated on FMC (e.g. "FULL"); unobserved on SCC. */
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

/** Provisional — documentation-only, never observed populated (DESIGN.md §14.1). */
export interface FmcChassisStatsHealthMetrics {
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

/** Provisional — documentation-only, never observed populated (DESIGN.md §14.1). */
export interface FmcHaHealthMetrics {
  nodeStatus?: string;
  nodeType?: string;
}

/** Provisional — documentation-only, never observed populated (DESIGN.md §14.1). */
export interface FmcRaVpnSessionHealthMetrics {
  activeRavpnSessionsAvg?: number;
  inactiveRavpnSessionsAvg?: number;
  peakConcurRavpnSessions?: number;
}

/** Provisional — documentation-only, never observed populated (DESIGN.md §14.1). */
export interface FmcS2sVpnTunnelHealthMetric {
  tunnelId?: string;
  tunnelName?: string;
  tunnelState?: string;
}

/**
 * A supported metric family name for the `metric:` filter clause
 * (DESIGN.md §3.3.4).
 */
export type FmcMetricFamily = 'CPU' | 'MEM' | 'INTERFACE' | 'DISK_STATS' | 'CHASSIS_STATS';

/** One item in a family response's `items[]` array — one device's data for one family. */
export interface FmcAggregateMetricItem {
  /** "YYYY-MM-DD HH:mm:ss.SSS UTC" — not ISO 8601 (DESIGN.md §14.1). */
  startTime: string;
  /** "YYYY-MM-DD HH:mm:ss.SSS UTC" — not ISO 8601 (DESIGN.md §14.1). */
  endTime: string;
  cpuHealthMetrics?: FmcCpuHealthMetrics;
  memoryHealthMetrics?: FmcMemoryHealthMetrics;
  diskHealthMetrics?: FmcDiskHealthMetrics;
  chassisStatsHealthMetrics?: FmcChassisStatsHealthMetrics;
  interfaceHealthMetricsList?: FmcInterfaceHealthMetric[];
  haHealthMetrics?: FmcHaHealthMetrics;
  raVpnSessionHealthMetrics?: FmcRaVpnSessionHealthMetrics;
  s2sVpnTunnelHealthMetrics?: FmcS2sVpnTunnelHealthMetric[];
  links?: { self?: string };
  name: string;
  id: string;
  type?: string;
}

export interface FmcPaging {
  offset: number;
  limit: number;
  count: number;
  pages: number;
}

/**
 * A capability- or policy-gated-absent family response is `200` with an
 * empty result set, not an error and not zeros (DESIGN.md §14.6,
 * Appendix C) — `items` is absent entirely, `paging.count` is `0`.
 */
export interface FmcAggregateMetricsResponse {
  links: { self?: string };
  items?: FmcAggregateMetricItem[];
  paging: FmcPaging;
}

/** A per-device request failure, e.g. "Device not connected." (DESIGN.md §2.5, Appendix C). */
export interface FmcErrorResponse {
  error: {
    category: string;
    messages: Array<{ description: string }>;
    severity: string;
  };
}

export interface FmcDeviceRecord {
  id: string;
  name: string;
  type: 'Device';
  isConnected?: boolean;
}

export interface FmcDeviceRecordsResponse {
  links: { self?: string };
  items?: FmcDeviceRecord[];
  paging: FmcPaging;
}
