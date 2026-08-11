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
}
