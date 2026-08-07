/**
 * The exporter's own domain model (DESIGN.md §2.3) — not a pass-through of
 * either vendor payload. Every conditional group is optional at the type
 * level because the live API samples confirm these keys are *absent* on
 * devices lacking the capability/configuration, not null or zero
 * (DESIGN.md §4.8, Appendix B, Appendix C).
 *
 * Enum-valued fields keep the original upstream string rather than a
 * pre-converted boolean/lowercased form — DESIGN.md §3.2.6: "String enums
 * are mapped to numeric gauges at render time, not at parse time." This
 * lets the renderer (Stage 3) own representation decisions and keeps this
 * layer a pure, backend-agnostic value object.
 */

export interface CpuStats {
  lina?: number;
  snort?: number;
  system?: number;
}

export interface MemoryStats {
  lina?: number;
  snort?: number;
  system?: number;
}

export interface DiskStats {
  totalUsagePercent?: number;
}

export interface InterfaceStats {
  /** Hardware id, e.g. "Ethernet1/1". Always present upstream on both backends. */
  interface: string;
  /**
   * Human label, e.g. "outside". Upstream `interfaceName` is optional and
   * frequently absent for unnamed/unused interfaces (DESIGN.md §3.2.6) — the
   * mapper (Stage 2) is responsible for the fallback to `interface`, so by
   * the time a value reaches this domain type, `interfaceName` is always set.
   */
  interfaceName: string;
  interfaceType?: string;
  /**
   * Raw upstream enum, e.g. "UP" | "DOWN". Optional at this layer — absent
   * when the upstream field itself was missing. Kept distinct from an
   * upstream literal `"UNKNOWN"` value on purpose: recognizing/counting
   * unrecognized *values* is the Stage 3 renderer's job (DESIGN.md
   * §3.2.6), and conflating "field absent" with "value is UNKNOWN" would
   * make that counter fire on every interface with no status field at all.
   */
  linkStatus?: string;
  /** Raw upstream enum, e.g. "UP" | "DOWN". See `linkStatus` for why this is optional. */
  operationalStatus?: string;
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

export interface ChassisFanStats {
  /** Numeric fan index as a string, e.g. "1".."4". */
  fan: string;
  rpmAvg: number;
}

export interface ChassisPsuStats {
  /** Numeric PSU index as a string, e.g. "1" | "2". */
  psu: string;
  /** Raw upstream enum, e.g. "UP" | "DOWN". */
  fanStatus?: string;
  /** Raw upstream enum, e.g. "UP" | "DOWN". */
  inputStatus?: string;
  /** Raw upstream enum, e.g. "UP" | "DOWN". */
  outputStatus?: string;
}

export interface ChassisStats {
  fans: ChassisFanStats[];
  psus: ChassisPsuStats[];
}

export interface HaStats {
  /** Raw upstream enum, e.g. "NORMAL" | "ERROR" | "WARNING" | "DISABLED" | "UNKNOWN". */
  nodeStatus: string;
  /** Raw upstream enum, e.g. "PRIMARY" | "SECONDARY". */
  nodeType: string;
}

export interface RaVpnStats {
  activeSessionsAvg?: number;
  inactiveSessionsAvg?: number;
  peakConcurrentSessions?: number;
}

export interface S2sTunnelStats {
  tunnelId: string;
  tunnelName: string;
  /** Raw upstream enum, e.g. "TUNNEL_UP" | "TUNNEL_DOWN" | "UNKNOWN". */
  tunnelState: string;
}

export interface DeviceHealthSnapshot {
  deviceUid: string;
  deviceName: string;
  /** Start of the averaging window this snapshot describes (DESIGN.md §4.5). */
  windowStart?: Date;
  /** End of the averaging window this snapshot describes (DESIGN.md §4.5). */
  windowEnd?: Date;
  cpu?: CpuStats;
  memory?: MemoryStats;
  disk?: DiskStats;
  /** Absent entirely on non-chassis hardware (confirmed on an FTD 1010 and on FTDv). */
  chassis?: ChassisStats;
  interfaces?: InterfaceStats[];
  /** Absent unless the device is in an HA pair. */
  ha?: HaStats;
  /** Absent unless RA VPN is configured. */
  raVpn?: RaVpnStats;
  /** Absent unless site-to-site VPN is configured. Upstream array capped at 1000 entries. */
  s2sTunnels?: S2sTunnelStats[];
}
