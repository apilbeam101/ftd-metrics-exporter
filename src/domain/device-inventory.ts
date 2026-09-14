/**
 * Domain shape for SCC's `/v1/inventory/devices` (DESIGN.md §4.6.1's v1.1
 * item, now built). Deliberately separate from `DeviceHealthSnapshot`
 * (snapshot.ts): this data comes from a different upstream endpoint, on its
 * own independent poll cadence, and is the only source that still describes
 * a device SCC's `/health/metrics` endpoint has stopped returning entirely
 * (an unreachable device is silently absent from health/metrics — confirmed
 * live, 2026-08-11 — but still listed here).
 *
 * `deviceUid` is the SAME identifier `/health/metrics` uses, with the same
 * caveat: on SCC, both nodes of an HA pair share one `deviceUid` (see
 * DESIGN.md §2.3's device_uid caveat) — inventory makes this visible
 * directly, since an HA pair is exactly one row here, not two.
 */
export interface DeviceInventoryEntry {
  deviceUid: string;
  deviceName: string;
  /** Raw upstream value (e.g. "ONLINE"/"UNREACHABLE"); absent if the field itself was missing. Recognition happens at render time (DESIGN.md §3.2.6). */
  connectivityState?: string;
  /** Raw upstream value (e.g. "STANDALONE"/"HA"); absent if the field itself was missing. */
  redundancyMode?: string;
  /**
   * The FMC-side device-record UUID (DESIGN.md §4.6.2) — a *third* identifier
   * for the same device, distinct from both this endpoint's own `deviceUid`
   * and `/health/metrics`'s identifier of the same name (which, confusingly,
   * are the same value here but not on FMC — see inventory-map.ts). Exists
   * solely so `certificate-map.ts` can join `/devices/certificates`' `id`
   * field back to a `deviceUid`/`deviceName` pair on the SCC backend; not
   * used anywhere else. Absent if the field itself was missing.
   */
  uidOnFmc?: string;
  /** Unbounded informational passthrough (DESIGN.md §4.6's "remaining fields" row, built in §4.6.3), same treatment as `interface_type`. Absent if the field itself was missing. */
  softwareVersion?: string;
  /** Unbounded informational passthrough. Absent if the field itself was missing. */
  serial?: string;
  /** Unbounded informational passthrough (e.g. "FTDv50"). Absent if the field itself was missing. */
  ftdPerformanceTier?: string;
  /** Raw upstream value (e.g. "SYNCED"/"NOT_SYNCED"); bounded state, recognized at render time. Absent if the field itself was missing. */
  configState?: string;
  /** Raw upstream value (e.g. "NO_CONFLICTS"); bounded state, recognized at render time. Absent if the field itself was missing. */
  conflictDetectionState?: string;
  /** Raw upstream value (e.g. "LICENSED"); bounded state, recognized at render time. Distinct from the fleet-scoped Smart License status (DESIGN.md §4.6.2) — this is per-device. Absent if the field itself was missing. */
  licenseStatus?: string;
  /** Raw upstream value (e.g. "IN_COMPLIANCE"); bounded state, recognized at render time. Absent if the field itself was missing. */
  complianceStatus?: string;
  /**
   * Per-node HA detail, present only when `redundancyMode === "HA"` and the
   * wire's `ftdHaInfo` object parsed (DESIGN.md §4.6.3). Deliberately narrow:
   * only `nodeName`/`role`/`nodeType` are modeled, not the node's own
   * `serial`/`softwareVersion` (also on the wire) — those duplicate the
   * top-level device's own fields for the primary node and were out of the
   * scope decided for this feature. `nodeName`, not `deviceName`, is the
   * per-node label key: on SCC an HA pair's two nodes share one
   * `deviceUid` *and* one top-level `deviceName` (the pair's name, not
   * either node's own name) — see DESIGN.md §14.14.
   */
  haNodes?: DeviceInventoryHaNode[];
}

/** One entry in `DeviceInventoryEntry.haNodes` — see its doc comment. */
export interface DeviceInventoryHaNode {
  nodeName: string;
  /** Raw upstream value (e.g. "ACTIVE"/"STANDBY"); bounded state, recognized at render time. Absent if the field itself was missing. */
  role?: string;
  /**
   * Which `ftdHaInfo` key this node came from ("PRIMARY"/"SECONDARY"),
   * assigned by the mapper (not read from the wire under this name) — this
   * is deliberately the same value/vocabulary as `/health/metrics`'s
   * `haHealthMetrics.nodeType`, already exposed as `ftd_ha_node_info`'s
   * `node_type` label. Without this, `ftd_device_ha_role_info`'s `node_name`
   * (from `ftdHaInfo`) has no label in common with any other series in the
   * metric surface — `device_name` is the pair's name, not either node's —
   * so a device_uid+node_type join is the only way to answer "is the
   * primary or the secondary currently active" against the rest of the
   * exporter's data (review finding, pre-commit).
   */
  nodeType: string;
}
