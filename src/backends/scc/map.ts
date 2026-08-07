import type { MapResult, ParseError } from '../../domain/diagnostics.ts';
import type { DeviceHealthSnapshot } from '../../domain/snapshot.ts';
import {
  mapChassis,
  mapCpu,
  mapDisk,
  mapHa,
  mapMemory,
  mapRaVpn,
  mapS2sTunnels,
} from '../shared/groups.ts';
import { mapInterfaceEntry, SCC_INTERFACE_STATUS_FIELDS } from '../shared/interfaces.ts';
import { isPlainObject, readRequiredString } from '../shared/numbers.ts';
import { parseSccTimestamp } from './time.ts';

/**
 * Pure mapper: `SccHealthMetricsResponse` (an untyped JSON array from the
 * wire) → `DeviceHealthSnapshot[]`, plus diagnostics as data rather than
 * side effects (DESIGN.md §3.2.6 — this keeps the function exhaustively
 * testable against fixtures with no network, clock, or logger involved).
 *
 * Per-device isolation: a device whose root fields (deviceUid/deviceName)
 * are broken is skipped entirely; a device with one broken group still
 * yields a snapshot with its other groups intact (DESIGN.md §2.5 —
 * "partial success is a success").
 */
export function mapSccResponse(payload: unknown): MapResult<DeviceHealthSnapshot> {
  const snapshots: DeviceHealthSnapshot[] = [];
  const parseErrors: ParseError[] = [];

  if (!Array.isArray(payload)) {
    parseErrors.push({ group: 'root', message: 'SCC health/metrics response is not an array' });
    return { snapshots, parseErrors };
  }

  for (const rawDevice of payload) {
    if (!isPlainObject(rawDevice)) {
      parseErrors.push({ group: 'root', message: 'device entry is not an object' });
      continue;
    }

    const deviceUid = readRequiredString(rawDevice, 'deviceUid');
    const deviceName = readRequiredString(rawDevice, 'deviceName');
    if (!deviceUid.ok || !deviceName.ok) {
      parseErrors.push({ group: 'root', message: 'device entry missing deviceUid/deviceName' });
      continue;
    }

    const snapshot: DeviceHealthSnapshot = {
      deviceUid: deviceUid.value,
      deviceName: deviceName.value,
    };

    if (typeof rawDevice.startTime === 'string') {
      const parsed = parseSccTimestamp(rawDevice.startTime);
      if (parsed !== undefined) {
        snapshot.windowStart = parsed;
      } else {
        parseErrors.push({
          deviceUid: deviceUid.value,
          group: 'startTime',
          message: `unparseable startTime: "${rawDevice.startTime}"`,
        });
      }
    }
    if (typeof rawDevice.endTime === 'string') {
      const parsed = parseSccTimestamp(rawDevice.endTime);
      if (parsed !== undefined) {
        snapshot.windowEnd = parsed;
      } else {
        parseErrors.push({
          deviceUid: deviceUid.value,
          group: 'endTime',
          message: `unparseable endTime: "${rawDevice.endTime}"`,
        });
      }
    }

    const cpu = mapCpu(rawDevice.cpuHealthMetrics, deviceUid.value);
    parseErrors.push(...cpu.parseErrors);
    if (cpu.value !== undefined) snapshot.cpu = cpu.value;

    const memory = mapMemory(rawDevice.memoryHealthMetrics, deviceUid.value);
    parseErrors.push(...memory.parseErrors);
    if (memory.value !== undefined) snapshot.memory = memory.value;

    const disk = mapDisk(rawDevice.diskHealthMetrics, deviceUid.value);
    parseErrors.push(...disk.parseErrors);
    if (disk.value !== undefined) snapshot.disk = disk.value;

    const chassis = mapChassis(rawDevice.chassisStatsHealthMetrics, deviceUid.value);
    parseErrors.push(...chassis.parseErrors);
    if (chassis.value !== undefined) snapshot.chassis = chassis.value;

    const ha = mapHa(rawDevice.haHealthMetrics, deviceUid.value);
    parseErrors.push(...ha.parseErrors);
    if (ha.value !== undefined) snapshot.ha = ha.value;

    const raVpn = mapRaVpn(rawDevice.raVpnSessionHealthMetrics, deviceUid.value);
    parseErrors.push(...raVpn.parseErrors);
    if (raVpn.value !== undefined) snapshot.raVpn = raVpn.value;

    const s2sTunnels = mapS2sTunnels(rawDevice.s2sVpnTunnelHealthMetrics, deviceUid.value);
    parseErrors.push(...s2sTunnels.parseErrors);
    if (s2sTunnels.value !== undefined) snapshot.s2sTunnels = s2sTunnels.value;

    if (rawDevice.interfaceHealthMetrics !== undefined) {
      if (!Array.isArray(rawDevice.interfaceHealthMetrics)) {
        parseErrors.push({
          deviceUid: deviceUid.value,
          group: 'interface',
          message: 'interfaceHealthMetrics is not an array',
        });
      } else {
        const interfaces = [];
        for (const rawInterface of rawDevice.interfaceHealthMetrics) {
          const mapped = mapInterfaceEntry(
            rawInterface,
            deviceUid.value,
            SCC_INTERFACE_STATUS_FIELDS,
          );
          parseErrors.push(...mapped.parseErrors);
          if (mapped.interface !== undefined) {
            interfaces.push(mapped.interface);
          }
        }
        snapshot.interfaces = interfaces;
      }
    }

    snapshots.push(snapshot);
  }

  return { snapshots, parseErrors };
}
