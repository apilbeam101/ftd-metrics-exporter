/**
 * Wire shape for `GET /v1/inventory/devices`, verified against a live
 * capture (2026-08-11, extended 2026-09-14) including a real HA pair and a
 * real unreachable device. Same "describe what the wire actually looks
 * like" discipline as scc/schema.ts — the mapper (inventory-map.ts) is
 * responsible for safely narrowing an actual HTTP response body into this
 * shape.
 *
 * Every field below is confirmed live (2026-08-11's `connectivityState`/
 * `configState`/`redundancyMode`, 2026-09-14's remaining fields — DESIGN.md
 * §4.6.3). Deliberately not modeled: `connectorType`, `address`,
 * `deviceRoles`, `ftdLicenses`, the HA pair's own `haPairUid`/`haPairName`/
 * `haNodeType` and each node's `serial`/`softwareVersion`/`uidOnFmc`/
 * `status`, `uidOnFmc`'s sibling `deviceRecordOnFmc`, `fmcAccessPolicy`,
 * `modelNumber`, `hardwareModel`, `deviceMaintenanceWindow` — see §4.6.3 for
 * why each was left out (mostly: duplicates data already exposed via
 * `/health/metrics`, or out of the scope decided for this pass).
 *
 * `uid`, not `deviceUid` — this endpoint's identifier field name genuinely
 * differs from `/health/metrics`'s `deviceUid`. Caught only by a live
 * smoke test after this feature was first built entirely against an
 * (incorrect) assumption that the two endpoints shared a field name; the
 * value itself is the same identifier (confirmed: matches `/health/metrics`'s
 * `deviceUid` for the same device, byte for byte).
 */
export interface SccInventoryDeviceEntry {
  name: string;
  uid: string;
  /** Filters this response to FTDs (DESIGN.md §4.6.1): the live capture also returned `MERAKI_MX` entries alongside `CDFMC_MANAGED_FTD`. */
  deviceType?: string;
  connectivityState?: string;
  configState?: string;
  redundancyMode?: string;
  /** DESIGN.md §4.6.2: the FMC-side device-record UUID, confirmed live to be `devices/certificates`' join key on this backend — see device-inventory.ts's `uidOnFmc`. */
  uidOnFmc?: string;
  softwareVersion?: string;
  serial?: string;
  ftdPerformanceTier?: string;
  conflictDetectionState?: string;
  licenseStatus?: string;
  complianceStatus?: string;
  /** Only present when `redundancyMode === "HA"` — confirmed live 2026-09-14. */
  ftdHaInfo?: SccInventoryHaInfo;
}

/** `ftdHaInfo` on a live HA device's inventory row — confirmed live 2026-09-14. */
export interface SccInventoryHaInfo {
  primaryNode?: SccInventoryHaNode;
  secondaryNode?: SccInventoryHaNode;
}

/**
 * One node of `SccInventoryHaInfo`. The wire also carries `serial` and
 * `softwareVersion` per node — deliberately not modeled here, see
 * `DeviceInventoryEntry.haNodes`'s doc comment for why.
 */
export interface SccInventoryHaNode {
  name?: string;
  /** Raw value confirmed live: "ACTIVE"/"STANDBY". Distinct from the wire's own `haNodeType` (PRIMARY/SECONDARY, a static config assignment already exposed via `/health/metrics`'s `haHealthMetrics.nodeType` as `ftd_ha_node_info`'s `node_type`) — this `role` field is the dynamic active/standby state. The mapper derives a `nodeType` for `DeviceInventoryHaNode` from *which key* this object came from (`primaryNode`/`secondaryNode`), not from a wire field of that name on this object — see `inventory-map.ts`'s `HA_INFO_NODE_KEYS`. */
  role?: string;
}

/** The full response body: `{ count, limit, offset, items }` — confirmed live; `items` is the only field this mapper actually needs. */
export interface SccInventoryResponse {
  items: SccInventoryDeviceEntry[];
}
