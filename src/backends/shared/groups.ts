import type { ParseError } from '../../domain/diagnostics.ts';
import type {
  ChassisFanStats,
  ChassisPsuStats,
  ChassisStats,
  CpuStats,
  DiskStats,
  HaStats,
  MemoryStats,
  RaVpnStats,
  S2sTunnelStats,
} from '../../domain/snapshot.ts';
import {
  isPlainObject,
  readOptionalNumber,
  readOptionalString,
  readRequiredString,
} from './numbers.ts';

/**
 * Group-level mappers shared by both backends: CPU, memory, disk, chassis,
 * HA, and RA VPN field names are identical between SCC and FMC (DESIGN.md
 * Appendix C confirms this explicitly for cpu/memory/disk; chassis/ha/
 * raVpn field names are documentation-only on both backends, per §14.1,
 * but at least *consistent* documentation between them). Only the
 * interface group and the timestamp format diverge — see
 * shared/interfaces.ts and the per-backend time.ts modules.
 *
 * Each mapper returns `undefined` when the group key is absent from the
 * input (DESIGN.md §4.8 — absence is the normal, common case and must
 * produce no diagnostic), and a `ParseError` when the key is present but
 * malformed.
 */

export interface GroupMapResult<T> {
  value?: T;
  parseErrors: ParseError[];
}

function readTriple(
  container: Record<string, unknown>,
  group: string,
  deviceUid: string,
): GroupMapResult<CpuStats | MemoryStats> {
  const parseErrors: ParseError[] = [];
  const lina = readOptionalNumber(container, 'linaUsageAvg');
  const snort = readOptionalNumber(container, 'snortUsageAvg');
  const system = readOptionalNumber(container, 'systemUsageAvg');
  if (!lina.ok || !snort.ok || !system.ok) {
    parseErrors.push({
      deviceUid,
      group,
      message: `${group}HealthMetrics has a non-numeric field`,
    });
    return { parseErrors };
  }
  const value: CpuStats | MemoryStats = {};
  if (lina.value !== undefined) value.lina = lina.value;
  if (snort.value !== undefined) value.snort = snort.value;
  if (system.value !== undefined) value.system = system.value;
  return { value, parseErrors };
}

export function mapCpu(raw: unknown, deviceUid: string): GroupMapResult<CpuStats> {
  if (raw === undefined) return { parseErrors: [] };
  if (!isPlainObject(raw)) {
    return {
      parseErrors: [{ deviceUid, group: 'cpu', message: 'cpuHealthMetrics is not an object' }],
    };
  }
  return readTriple(raw, 'cpu', deviceUid);
}

export function mapMemory(raw: unknown, deviceUid: string): GroupMapResult<MemoryStats> {
  if (raw === undefined) return { parseErrors: [] };
  if (!isPlainObject(raw)) {
    return {
      parseErrors: [
        { deviceUid, group: 'memory', message: 'memoryHealthMetrics is not an object' },
      ],
    };
  }
  return readTriple(raw, 'memory', deviceUid);
}

export function mapDisk(raw: unknown, deviceUid: string): GroupMapResult<DiskStats> {
  if (raw === undefined) return { parseErrors: [] };
  if (!isPlainObject(raw)) {
    return {
      parseErrors: [{ deviceUid, group: 'disk', message: 'diskHealthMetrics is not an object' }],
    };
  }
  const total = readOptionalNumber(raw, 'totalDiskUsageAvg');
  if (!total.ok) {
    return {
      parseErrors: [
        {
          deviceUid,
          group: 'disk',
          message: 'diskHealthMetrics.totalDiskUsageAvg is not a finite number',
        },
      ],
    };
  }
  const value: DiskStats = {};
  if (total.value !== undefined) value.totalUsagePercent = total.value;
  return { value, parseErrors: [] };
}

const FAN_KEYS = ['1', '2', '3', '4'] as const;
const PSU_KEYS = ['1', '2'] as const;

export function mapChassis(raw: unknown, deviceUid: string): GroupMapResult<ChassisStats> {
  if (raw === undefined) return { parseErrors: [] };
  if (!isPlainObject(raw)) {
    return {
      parseErrors: [
        { deviceUid, group: 'chassis', message: 'chassisStatsHealthMetrics is not an object' },
      ],
    };
  }
  const parseErrors: ParseError[] = [];
  const fans: ChassisFanStats[] = [];
  for (const fan of FAN_KEYS) {
    const read = readOptionalNumber(raw, `fan${fan}RpmAvg`);
    if (!read.ok) {
      parseErrors.push({
        deviceUid,
        group: 'chassis',
        message: `fan${fan}RpmAvg is not a finite number`,
      });
      continue;
    }
    if (read.value !== undefined) {
      fans.push({ fan, rpmAvg: read.value });
    }
  }

  const psus: ChassisPsuStats[] = [];
  for (const psu of PSU_KEYS) {
    const fanStatus = readOptionalString(raw, `psu${psu}FanStatus`);
    const inputStatus = readOptionalString(raw, `psu${psu}InputStatus`);
    const outputStatus = readOptionalString(raw, `psu${psu}OutputStatus`);
    if (!fanStatus.ok || !inputStatus.ok || !outputStatus.ok) {
      parseErrors.push({
        deviceUid,
        group: 'chassis',
        message: `psu${psu} status field is not a string`,
      });
      continue;
    }
    if (
      fanStatus.value === undefined &&
      inputStatus.value === undefined &&
      outputStatus.value === undefined
    ) {
      continue;
    }
    const psuStats: ChassisPsuStats = { psu };
    if (fanStatus.value !== undefined) psuStats.fanStatus = fanStatus.value;
    if (inputStatus.value !== undefined) psuStats.inputStatus = inputStatus.value;
    if (outputStatus.value !== undefined) psuStats.outputStatus = outputStatus.value;
    psus.push(psuStats);
  }

  return { value: { fans, psus }, parseErrors };
}

export function mapHa(raw: unknown, deviceUid: string): GroupMapResult<HaStats> {
  if (raw === undefined) return { parseErrors: [] };
  if (!isPlainObject(raw)) {
    return {
      parseErrors: [{ deviceUid, group: 'ha', message: 'haHealthMetrics is not an object' }],
    };
  }
  const nodeStatus = readRequiredString(raw, 'nodeStatus');
  const nodeType = readRequiredString(raw, 'nodeType');
  if (!nodeStatus.ok || !nodeType.ok) {
    return {
      parseErrors: [
        { deviceUid, group: 'ha', message: 'haHealthMetrics missing nodeStatus/nodeType' },
      ],
    };
  }
  return { value: { nodeStatus: nodeStatus.value, nodeType: nodeType.value }, parseErrors: [] };
}

export function mapRaVpn(raw: unknown, deviceUid: string): GroupMapResult<RaVpnStats> {
  if (raw === undefined) return { parseErrors: [] };
  if (!isPlainObject(raw)) {
    return {
      parseErrors: [
        { deviceUid, group: 'raVpn', message: 'raVpnSessionHealthMetrics is not an object' },
      ],
    };
  }
  const active = readOptionalNumber(raw, 'activeRavpnSessionsAvg');
  const inactive = readOptionalNumber(raw, 'inactiveRavpnSessionsAvg');
  const peak = readOptionalNumber(raw, 'peakConcurRavpnSessions');
  if (!active.ok || !inactive.ok || !peak.ok) {
    return {
      parseErrors: [
        { deviceUid, group: 'raVpn', message: 'raVpnSessionHealthMetrics has a non-numeric field' },
      ],
    };
  }
  const value: RaVpnStats = {};
  if (active.value !== undefined) value.activeSessionsAvg = active.value;
  if (inactive.value !== undefined) value.inactiveSessionsAvg = inactive.value;
  if (peak.value !== undefined) value.peakConcurrentSessions = peak.value;
  return { value, parseErrors: [] };
}

export function mapS2sTunnels(
  raw: unknown,
  deviceUid: string,
): { value?: S2sTunnelStats[]; parseErrors: ParseError[] } {
  if (raw === undefined) return { parseErrors: [] };
  if (!Array.isArray(raw)) {
    return {
      parseErrors: [
        { deviceUid, group: 's2sTunnels', message: 's2sVpnTunnelHealthMetrics is not an array' },
      ],
    };
  }
  const parseErrors: ParseError[] = [];
  const tunnels: S2sTunnelStats[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      parseErrors.push({
        deviceUid,
        group: 's2sTunnels',
        message: 'tunnel entry is not an object',
      });
      continue;
    }
    const tunnelId = readRequiredString(entry, 'tunnelId');
    const tunnelName = readRequiredString(entry, 'tunnelName');
    const tunnelState = readRequiredString(entry, 'tunnelState');
    if (!tunnelId.ok || !tunnelName.ok || !tunnelState.ok) {
      parseErrors.push({
        deviceUid,
        group: 's2sTunnels',
        message: 'tunnel entry missing a required field',
      });
      continue;
    }
    tunnels.push({
      tunnelId: tunnelId.value,
      tunnelName: tunnelName.value,
      tunnelState: tunnelState.value,
    });
  }
  return { value: tunnels, parseErrors };
}
