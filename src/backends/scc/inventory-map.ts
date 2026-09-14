import type { DeviceInventoryEntry, DeviceInventoryHaNode } from '../../domain/device-inventory.ts';
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

    const uid = deviceUid.value;
    const name = deviceName.value;
    const entry: DeviceInventoryEntry = { deviceUid: uid, deviceName: name };

    function readOptionalField(key: string): string | undefined {
      const field = readOptionalString(rawDevice, key);
      if (!field.ok) {
        parseErrors.push({
          deviceUid: uid,
          group: 'inventory',
          message: `${key} on ${name} is not a string`,
        });
        return undefined;
      }
      return field.value;
    }

    const connectivityState = readOptionalField('connectivityState');
    if (connectivityState !== undefined) entry.connectivityState = connectivityState;
    const redundancyMode = readOptionalField('redundancyMode');
    if (redundancyMode !== undefined) entry.redundancyMode = redundancyMode;
    const uidOnFmc = readOptionalField('uidOnFmc');
    if (uidOnFmc !== undefined) entry.uidOnFmc = uidOnFmc;
    const softwareVersion = readOptionalField('softwareVersion');
    if (softwareVersion !== undefined) entry.softwareVersion = softwareVersion;
    const serial = readOptionalField('serial');
    if (serial !== undefined) entry.serial = serial;
    const ftdPerformanceTier = readOptionalField('ftdPerformanceTier');
    if (ftdPerformanceTier !== undefined) entry.ftdPerformanceTier = ftdPerformanceTier;
    const configState = readOptionalField('configState');
    if (configState !== undefined) entry.configState = configState;
    const conflictDetectionState = readOptionalField('conflictDetectionState');
    if (conflictDetectionState !== undefined) entry.conflictDetectionState = conflictDetectionState;
    const licenseStatus = readOptionalField('licenseStatus');
    if (licenseStatus !== undefined) entry.licenseStatus = licenseStatus;
    const complianceStatus = readOptionalField('complianceStatus');
    if (complianceStatus !== undefined) entry.complianceStatus = complianceStatus;

    const haNodes = readHaNodes(rawDevice.ftdHaInfo, uid, name, parseErrors);
    if (haNodes !== undefined) {
      entry.haNodes = haNodes;
    }

    snapshots.push(entry);
  }

  return { snapshots, parseErrors };
}

/** ftdHaInfo's two node slots, and the `node_type` label each maps to (§4.6.3's join-key fix). */
const HA_INFO_NODE_KEYS = [
  { key: 'primaryNode', nodeType: 'PRIMARY' },
  { key: 'secondaryNode', nodeType: 'SECONDARY' },
] as const;

/**
 * Parses the wire's `ftdHaInfo.primaryNode`/`secondaryNode` into
 * `DeviceInventoryHaNode[]` (DESIGN.md §4.6.3). Isolated per-node: a
 * malformed single node is skipped with a parse error, not the whole
 * device entry — same "smallest reasonable failure unit" discipline as
 * every other per-component parse in this codebase (certificate
 * components, per-device/per-family health). `ftdHaInfo` being absent
 * entirely (a non-HA device) is normal, not a parse error. Two nodes
 * sharing a `name` (should never happen upstream, but nothing prevents it)
 * are deduped to the first, with a diagnostic — same discipline
 * `certificate-map.ts` uses for a `(cert_name, cert_type)` collision,
 * rather than letting two contradictory series render for the same label
 * set silently.
 */
function readHaNodes(
  rawFtdHaInfo: unknown,
  deviceUid: string,
  deviceName: string,
  parseErrors: ParseError[],
): DeviceInventoryHaNode[] | undefined {
  if (rawFtdHaInfo === undefined) {
    return undefined;
  }
  if (!isPlainObject(rawFtdHaInfo)) {
    parseErrors.push({
      deviceUid,
      group: 'inventory',
      message: `ftdHaInfo on ${deviceName} is not an object`,
    });
    return undefined;
  }

  const nodes: DeviceInventoryHaNode[] = [];
  const seenNodeNames = new Set<string>();
  for (const { key, nodeType } of HA_INFO_NODE_KEYS) {
    const rawNode = rawFtdHaInfo[key];
    if (rawNode === undefined) {
      continue;
    }
    if (!isPlainObject(rawNode)) {
      parseErrors.push({
        deviceUid,
        group: 'inventory',
        message: `ftdHaInfo.${key} on ${deviceName} is not an object`,
      });
      continue;
    }
    const nodeName = readRequiredString(rawNode, 'name');
    if (!nodeName.ok) {
      parseErrors.push({
        deviceUid,
        group: 'inventory',
        message: `ftdHaInfo.${key} on ${deviceName} is missing a string "name"`,
      });
      continue;
    }
    if (seenNodeNames.has(nodeName.value)) {
      parseErrors.push({
        deviceUid,
        group: 'inventory',
        message: `ftdHaInfo.${key} on ${deviceName} has the same name as another node ("${nodeName.value}") — dropped, kept the first`,
      });
      continue;
    }
    seenNodeNames.add(nodeName.value);
    const role = readOptionalString(rawNode, 'role');
    if (!role.ok) {
      parseErrors.push({
        deviceUid,
        group: 'inventory',
        message: `ftdHaInfo.${key}.role on ${deviceName} is not a string`,
      });
      nodes.push({ nodeName: nodeName.value, nodeType });
      continue;
    }
    nodes.push(
      role.value !== undefined
        ? { nodeName: nodeName.value, nodeType, role: role.value }
        : { nodeName: nodeName.value, nodeType },
    );
  }

  return nodes.length > 0 ? nodes : undefined;
}
