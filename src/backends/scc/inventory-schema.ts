/**
 * Wire shape for `GET /v1/inventory/devices` (DESIGN.md §4.6.1), verified
 * against a live capture (2026-08-11) including a real HA pair and a real
 * unreachable device. Same "describe what the wire actually looks like"
 * discipline as scc/schema.ts — the mapper (inventory-map.ts) is
 * responsible for safely narrowing an actual HTTP response body into this
 * shape.
 *
 * Confirmed fields only: `name`, `uid`, `deviceType`,
 * `connectivityState`, `configState`, `redundancyMode`. DESIGN.md §4.6.1
 * additionally lists `conflictDetectionState`, `softwareVersion`, `serial`,
 * `licenseStatus`, `complianceStatus`, `ftdPerformanceTier`, and four
 * version fields as future candidates — deliberately not modeled here,
 * since none of them were part of the live capture that motivated this
 * feature (an unreachable device is invisible to health/metrics; the fix
 * needed only connectivity + identity, not the full inventory record).
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
}

/** The full response body: `{ count, limit, offset, items }` — confirmed live; `items` is the only field this mapper actually needs. */
export interface SccInventoryResponse {
  items: SccInventoryDeviceEntry[];
}
