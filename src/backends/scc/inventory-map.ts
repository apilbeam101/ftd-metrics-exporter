import type { DeviceInventoryEntry } from '../../domain/device-inventory.ts';
import type { MapResult, ParseError } from '../../domain/diagnostics.ts';
import { isPlainObject, readOptionalString, readRequiredString } from '../shared/numbers.ts';

/**
 * Pure mapper: `SccInventoryResponse` (an untyped JSON object from the wire)
 * -> `DeviceInventoryEntry[]`, plus diagnostics as data (DESIGN.md §3.2.6 —
 * same discipline as map.ts). `MapResult.snapshots` is the generic
 * container name shared with the health mapper; here it holds inventory
 * entries, not health snapshots.
 *
 * Filters to `deviceType === "CDFMC_MANAGED_FTD"` — confirmed live
 * (2026-08-11) that this endpoint also returns non-FTD entries (a
 * `MERAKI_MX` device, in the capture that found this). Without the filter,
 * a Meraki appliance would render as a permanently-"unreachable" phantom
 * FTD on `ftd_device_connectivity_up` forever.
 */
const FTD_DEVICE_TYPE = 'CDFMC_MANAGED_FTD';

export function mapSccInventoryResponse(payload: unknown): MapResult<DeviceInventoryEntry> {
  const snapshots: DeviceInventoryEntry[] = [];
  const parseErrors: ParseError[] = [];

  if (!isPlainObject(payload)) {
    parseErrors.push({ group: 'inventory', message: 'inventory response is not an object' });
    return { snapshots, parseErrors };
  }

  const items = payload.items;
  if (!Array.isArray(items)) {
    parseErrors.push({ group: 'inventory', message: 'inventory response has no "items" array' });
    return { snapshots, parseErrors };
  }

  for (const rawDevice of items) {
    if (!isPlainObject(rawDevice)) {
      parseErrors.push({ group: 'inventory', message: 'inventory item is not an object' });
      continue;
    }

    const deviceType = readOptionalString(rawDevice, 'deviceType');
    if (!deviceType.ok) {
      parseErrors.push({
        group: 'inventory',
        message: 'inventory item deviceType is not a string',
      });
      continue;
    }
    if (deviceType.value !== FTD_DEVICE_TYPE) {
      // Not a parse error — a Meraki (or any future non-FTD) entry in this
      // response is expected, not malformed. Silently excluded.
      continue;
    }

    const deviceUid = readRequiredString(rawDevice, 'uid');
    const deviceName = readRequiredString(rawDevice, 'name');
    if (!deviceUid.ok || !deviceName.ok) {
      parseErrors.push({
        group: 'inventory',
        message: 'FTD inventory item missing uid/name',
      });
      continue;
    }

    const entry: DeviceInventoryEntry = {
      deviceUid: deviceUid.value,
      deviceName: deviceName.value,
    };

    const connectivityState = readOptionalString(rawDevice, 'connectivityState');
    if (!connectivityState.ok) {
      parseErrors.push({
        deviceUid: deviceUid.value,
        group: 'inventory',
        message: `connectivityState on ${deviceName.value} is not a string`,
      });
    } else if (connectivityState.value !== undefined) {
      entry.connectivityState = connectivityState.value;
    }

    const redundancyMode = readOptionalString(rawDevice, 'redundancyMode');
    if (!redundancyMode.ok) {
      parseErrors.push({
        deviceUid: deviceUid.value,
        group: 'inventory',
        message: `redundancyMode on ${deviceName.value} is not a string`,
      });
    } else if (redundancyMode.value !== undefined) {
      entry.redundancyMode = redundancyMode.value;
    }

    snapshots.push(entry);
  }

  return { snapshots, parseErrors };
}
