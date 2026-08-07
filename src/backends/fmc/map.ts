import type { ParseError } from '../../domain/diagnostics.ts';
import type { DeviceHealthSnapshot } from '../../domain/snapshot.ts';
import { mapChassis, mapCpu, mapDisk, mapMemory } from '../shared/groups.ts';
import { FMC_INTERFACE_STATUS_FIELDS, mapInterfaceEntry } from '../shared/interfaces.ts';
import { isPlainObject, readOptionalString } from '../shared/numbers.ts';
import { isEmptyFamilyResponse } from './empty.ts';
import type { FmcMetricFamily } from './schema.ts';
import { parseFmcTimestamp } from './time.ts';

/**
 * One family's worth of mapped data for one device — the intermediate
 * result of `mapFmcFamilyResponse`, later folded into a full
 * `DeviceHealthSnapshot` by `mergeFmcFamilies`.
 *
 * Kept separate from `DeviceHealthSnapshot` because FMC's
 * `health/aggregatemetrics` is one request per device *per family*
 * (DESIGN.md §3.3.4) — there is no single upstream payload that is "one
 * device's snapshot" the way SCC's is. `mapFmcFamilyResponse` handles one
 * `items[]` wrapper for one device and one family; `mergeFmcFamilies`
 * assembles N of these into one snapshot (DESIGN.md Stage 2 plan).
 */
export interface FmcFamilyMapResult {
  windowStart?: Date;
  windowEnd?: Date;
  partial: Partial<
    Pick<
      DeviceHealthSnapshot,
      'cpu' | 'memory' | 'disk' | 'chassis' | 'ha' | 'raVpn' | 's2sTunnels' | 'interfaces'
    >
  >;
  parseErrors: ParseError[];
}

/**
 * Maps one `health/aggregatemetrics` response for one device/one family.
 * Takes an unvalidated `unknown` body — nothing upstream of this function
 * guarantees the response actually matches `FmcAggregateMetricsResponse`;
 * that type describes the *expected* shape, and this is the boundary where
 * an actual HTTP body gets checked (mirrors `mapSccResponse`'s contract,
 * per shared/numbers.ts's own header comment). A `null`/string/array body,
 * or an FMC per-device error envelope (`{"error":{...}}`), is a parse
 * failure here, not a crash and not silent absence.
 *
 * A capability- or policy-gated-absent family (DESIGN.md §14.6, Appendix
 * C: `200` with no `items`, `paging.count === 0`) yields an empty result
 * with **no diagnostic** — that is the normal, expected shape, not a
 * parse failure.
 */
export function mapFmcFamilyResponse(
  response: unknown,
  family: FmcMetricFamily,
  deviceUid: string,
): FmcFamilyMapResult {
  const parseErrors: ParseError[] = [];

  if (!isPlainObject(response)) {
    parseErrors.push({
      deviceUid,
      group: family,
      message: `${family} response body is not an object`,
    });
    return { partial: {}, parseErrors };
  }

  if (isPlainObject(response.error)) {
    parseErrors.push({
      deviceUid,
      group: family,
      message: `${family} request returned an FMC error envelope, not metrics`,
    });
    return { partial: {}, parseErrors };
  }

  if (isEmptyFamilyResponse(response)) {
    return { partial: {}, parseErrors };
  }

  const items = response.items;
  const paging = isPlainObject(response.paging) ? response.paging : undefined;
  if (typeof paging?.count === 'number' && paging.count > 1) {
    // F10 (review finding, deliberate fail-closed choice): a single-device
    // filter query matching more than one device is a data-integrity
    // signal, not a cosmetic one — this project has a real prior bug
    // class of exactly this shape (a missing device-identity check
    // silently attributing one device's data to another). Rather than
    // publishing `items[0]` anyway alongside a loud diagnostic, the whole
    // family result for this device/family is dropped as untrustworthy —
    // the caller already treats "no snapshot for this family" as a normal
    // partial-success outcome (DESIGN.md §2.5), so this costs one family's
    // worth of data for one poll cycle rather than risking a silent
    // misattribution.
    parseErrors.push({
      deviceUid,
      group: family,
      message: `${family} response for a single-device query unexpectedly matched ${paging.count} devices — the request filter may not have scoped correctly; dropping this family's result for this device rather than trusting items[0]`,
    });
    return { partial: {}, parseErrors };
  }

  const item = Array.isArray(items) ? items[0] : undefined;
  if (!isPlainObject(item)) {
    parseErrors.push({
      deviceUid,
      group: family,
      message: `${family} response items[0] is not an object`,
    });
    return { partial: {}, parseErrors };
  }

  const itemId = readOptionalString(item, 'id');
  if (!itemId.ok) {
    parseErrors.push({
      deviceUid,
      group: family,
      message: `${family} response items[0].id is not a string`,
    });
    return { partial: {}, parseErrors };
  }
  if (itemId.value !== undefined && itemId.value !== deviceUid) {
    parseErrors.push({
      deviceUid,
      group: family,
      message: `${family} response items[0].id ("${itemId.value}") does not match the requested device`,
    });
    return { partial: {}, parseErrors };
  }

  const result: FmcFamilyMapResult = { partial: {}, parseErrors };

  if (typeof item.startTime === 'string') {
    const parsed = parseFmcTimestamp(item.startTime);
    if (parsed !== undefined) {
      result.windowStart = parsed;
    } else {
      parseErrors.push({
        deviceUid,
        group: family,
        message: `unparseable FMC startTime: "${item.startTime}"`,
      });
    }
  }
  if (typeof item.endTime === 'string') {
    const parsed = parseFmcTimestamp(item.endTime);
    if (parsed !== undefined) {
      result.windowEnd = parsed;
    } else {
      parseErrors.push({
        deviceUid,
        group: family,
        message: `unparseable FMC endTime: "${item.endTime}"`,
      });
    }
  }

  switch (family) {
    case 'CPU': {
      const cpu = mapCpu(item.cpuHealthMetrics, deviceUid);
      parseErrors.push(...cpu.parseErrors);
      if (cpu.value !== undefined) result.partial.cpu = cpu.value;
      break;
    }
    case 'MEM': {
      const memory = mapMemory(item.memoryHealthMetrics, deviceUid);
      parseErrors.push(...memory.parseErrors);
      if (memory.value !== undefined) result.partial.memory = memory.value;
      break;
    }
    case 'DISK_STATS': {
      const disk = mapDisk(item.diskHealthMetrics, deviceUid);
      parseErrors.push(...disk.parseErrors);
      if (disk.value !== undefined) result.partial.disk = disk.value;
      break;
    }
    case 'CHASSIS_STATS': {
      const chassis = mapChassis(item.chassisStatsHealthMetrics, deviceUid);
      parseErrors.push(...chassis.parseErrors);
      if (chassis.value !== undefined) result.partial.chassis = chassis.value;
      break;
    }
    case 'INTERFACE': {
      // Verified: the wrapper key is `interfaceHealthMetricsList`, NOT
      // SCC's `interfaceHealthMetrics` (DESIGN.md §14.1, Appendix C). Using
      // the wrong key here would silently produce zero interfaces.
      const rawList = item.interfaceHealthMetricsList;
      if (rawList !== undefined) {
        if (!Array.isArray(rawList)) {
          parseErrors.push({
            deviceUid,
            group: 'interface',
            message: 'interfaceHealthMetricsList is not an array',
          });
        } else {
          const interfaces = [];
          for (const rawInterface of rawList) {
            const mapped = mapInterfaceEntry(rawInterface, deviceUid, FMC_INTERFACE_STATUS_FIELDS);
            parseErrors.push(...mapped.parseErrors);
            if (mapped.interface !== undefined) {
              interfaces.push(mapped.interface);
            }
          }
          result.partial.interfaces = interfaces;
        }
      }
      break;
    }
  }

  return result;
}

export interface MergeFmcFamiliesResult {
  snapshot?: DeviceHealthSnapshot;
  parseErrors: ParseError[];
}

/**
 * Assembles the N per-family results for one device into one
 * `DeviceHealthSnapshot`. Window timestamps: takes the *latest* `endTime`
 * (and its paired `startTime`) across the families that produced one —
 * a deliberate v1 choice (DESIGN.md §4.5's purpose is staleness detection,
 * and the newest window is the correct answer to "has this device stopped
 * reporting"), not something DESIGN.md specifies directly. A family whose
 * `endTime` is newest but whose `startTime` failed to parse contributes an
 * `windowEnd` with no paired `windowStart`, rather than pairing a fresher
 * end with a stale/wrong start from a different family.
 *
 * If every family failed/was absent for this device, no snapshot is
 * returned at all — a device with nothing to report should not appear as
 * an empty shell (DESIGN.md §2.5 — partial success at the *family* level,
 * but a device that contributed nothing is not "48 of 50 devices," it is
 * simply absent from this cycle).
 */
export function mergeFmcFamilies(
  deviceUid: string,
  deviceName: string,
  familyResults: readonly FmcFamilyMapResult[],
): MergeFmcFamiliesResult {
  const parseErrors: ParseError[] = [];

  const snapshot: DeviceHealthSnapshot = { deviceUid, deviceName };
  let latestEnd: Date | undefined;
  let pairedStart: Date | undefined;
  let contributed = false;

  for (const result of familyResults) {
    parseErrors.push(...result.parseErrors);

    if (result.partial.cpu !== undefined) {
      snapshot.cpu = result.partial.cpu;
      contributed = true;
    }
    if (result.partial.memory !== undefined) {
      snapshot.memory = result.partial.memory;
      contributed = true;
    }
    if (result.partial.disk !== undefined) {
      snapshot.disk = result.partial.disk;
      contributed = true;
    }
    if (result.partial.chassis !== undefined) {
      snapshot.chassis = result.partial.chassis;
      contributed = true;
    }
    if (result.partial.ha !== undefined) {
      snapshot.ha = result.partial.ha;
      contributed = true;
    }
    if (result.partial.raVpn !== undefined) {
      snapshot.raVpn = result.partial.raVpn;
      contributed = true;
    }
    if (result.partial.s2sTunnels !== undefined) {
      snapshot.s2sTunnels = result.partial.s2sTunnels;
      contributed = true;
    }
    if (result.partial.interfaces !== undefined) {
      snapshot.interfaces = result.partial.interfaces;
      contributed = true;
    }

    if (
      result.windowEnd !== undefined &&
      (latestEnd === undefined || result.windowEnd > latestEnd)
    ) {
      latestEnd = result.windowEnd;
      pairedStart = result.windowStart;
    }
  }

  if (!contributed) {
    return { parseErrors };
  }

  if (pairedStart !== undefined) snapshot.windowStart = pairedStart;
  if (latestEnd !== undefined) snapshot.windowEnd = latestEnd;

  return { snapshot, parseErrors };
}
