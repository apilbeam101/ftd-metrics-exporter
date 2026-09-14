/**
 * Canonical enum vocabularies for upstream string enums (DESIGN.md §4.4).
 * The domain model keeps the original upstream string; these are the
 * recognized values plus their lowercased label form used in rendered
 * Prometheus label values. Unrecognized values map to "unknown" at
 * render time (never at parse time) — see DESIGN.md §3.2.6.
 */

export type LinkStatus = 'UP' | 'DOWN';
export type OperationalStatus = 'UP' | 'DOWN';

export type HaNodeStatus = 'NORMAL' | 'ERROR' | 'WARNING' | 'DISABLED' | 'UNKNOWN';
export type HaNodeType = 'PRIMARY' | 'SECONDARY';

export type TunnelState = 'TUNNEL_UP' | 'TUNNEL_DOWN' | 'UNKNOWN';

export type PsuStatus = 'UP' | 'DOWN';

/**
 * Interface-type values confirmed live (DESIGN.md §4.3/Appendix B):
 * `Ethernet`, `Management`, `SubInterface` (SCC, 2026-08-11 FTDv/subinterface
 * capture); `GigabitEthernet` is documented on FMC but not yet live-verified.
 * Unlike every other enum here, this is purely informational, not a state
 * signal, and its rendered label is the versioned public API (DESIGN.md
 * §13) — see `classifyInterfaceType` in enum-render.ts: an unrecognized
 * value is flagged for `ftd_exporter_unknown_enum_total` but is NEVER
 * coerced to a fallback label, unlike the state-set/info enums above.
 */
export const KNOWN_INTERFACE_TYPE_VALUES: readonly string[] = [
  'Ethernet',
  'Management',
  'SubInterface',
  'GigabitEthernet',
];

/**
 * SCC device-inventory redundancy mode (DESIGN.md §4.6.1), confirmed live
 * (2026-08-11): `STANDALONE` on every device before pairing, `HA` on a real
 * paired device's single inventory row. Unlike `interface_type`, this is a
 * bounded state descriptor, not an unbounded informational field — an
 * unrecognized value falls back to `"unknown"` like every other enum in
 * this file (see `classifyRedundancyMode` in enum-render.ts).
 */
export type RedundancyMode = 'STANDALONE' | 'HA';
export const REDUNDANCY_MODE_VALUES: readonly RedundancyMode[] = ['STANDALONE', 'HA'];

/**
 * SCC device-inventory `configState` (DESIGN.md §4.6.3), confirmed live
 * 2026-09-14: `SYNCED` and `NOT_SYNCED`. Bounded state descriptor, same
 * fallback-to-"unknown" treatment as `redundancy_mode`.
 */
export type ConfigState = 'SYNCED' | 'NOT_SYNCED';
export const CONFIG_STATE_VALUES: readonly ConfigState[] = ['SYNCED', 'NOT_SYNCED'];

/** SCC device-inventory `conflictDetectionState` (DESIGN.md §4.6.3). Only `NO_CONFLICTS` confirmed live so far; a real conflict state is undocumented but presumed to exist. */
export type ConflictDetectionState = 'NO_CONFLICTS';
export const CONFLICT_DETECTION_STATE_VALUES: readonly ConflictDetectionState[] = ['NO_CONFLICTS'];

/** SCC device-inventory per-device `licenseStatus` (DESIGN.md §4.6.3). Distinct from the fleet-scoped `LicenseRegStatus`/`LicenseAuthStatus` (§4.6.2). Only `LICENSED` confirmed live so far. */
export type DeviceLicenseStatus = 'LICENSED';
export const DEVICE_LICENSE_STATUS_VALUES: readonly DeviceLicenseStatus[] = ['LICENSED'];

/** SCC device-inventory `complianceStatus` (DESIGN.md §4.6.3). Only `IN_COMPLIANCE` confirmed live so far. */
export type DeviceComplianceStatus = 'IN_COMPLIANCE';
export const DEVICE_COMPLIANCE_STATUS_VALUES: readonly DeviceComplianceStatus[] = ['IN_COMPLIANCE'];

/**
 * SCC device-inventory `ftdHaInfo.{primaryNode,secondaryNode}.role`
 * (DESIGN.md §4.6.3), confirmed live 2026-09-14 on a real HA pair: `ACTIVE`
 * on the currently-active node, `STANDBY` on the other. Distinct from
 * `HaNodeType` (`PRIMARY`/`SECONDARY`, a static config assignment already
 * exposed via `/health/metrics`'s `haHealthMetrics.nodeType`) — `role` is
 * the dynamic active/standby state that flips on failover.
 */
export type HaRole = 'ACTIVE' | 'STANDBY';
export const HA_ROLE_VALUES: readonly HaRole[] = ['ACTIVE', 'STANDBY'];

export const HA_NODE_STATUS_VALUES: readonly HaNodeStatus[] = [
  'NORMAL',
  'ERROR',
  'WARNING',
  'DISABLED',
  'UNKNOWN',
];

export const HA_NODE_TYPE_VALUES: readonly HaNodeType[] = ['PRIMARY', 'SECONDARY'];

export const TUNNEL_STATE_VALUES: readonly TunnelState[] = ['TUNNEL_UP', 'TUNNEL_DOWN', 'UNKNOWN'];

export const LINK_STATUS_VALUES: readonly LinkStatus[] = ['UP', 'DOWN'];
export const OPERATIONAL_STATUS_VALUES: readonly OperationalStatus[] = ['UP', 'DOWN'];
export const PSU_STATUS_VALUES: readonly PsuStatus[] = ['UP', 'DOWN'];

/**
 * Smart License registration/authorization vocabularies (DESIGN.md §4.6.2),
 * taken from Cisco's `fmc_swagger.json` `getSmartLicense` example and
 * confirmed live (2026-08-14): `REGISTERED`/`AUTHORIZED` on SCC,
 * `REGISTERED`/`OUT_OF_COMPLIANCE` on FMC — the other values are documented
 * but not yet observed live.
 */
export type LicenseRegStatus =
  | 'REGISTERED'
  | 'UNREGISTERED'
  | 'RESERVATION_IN_PROGRESS'
  | 'EVALUATION';
export const LICENSE_REG_STATUS_VALUES: readonly LicenseRegStatus[] = [
  'REGISTERED',
  'UNREGISTERED',
  'RESERVATION_IN_PROGRESS',
  'EVALUATION',
];

export type LicenseAuthStatus =
  | 'AUTHORIZED'
  | 'AUTHORIZED_RESERVED'
  | 'OUT_OF_COMPLIANCE'
  | 'AUTHORIZATION_EXPIRED'
  | 'NOT_AUTHORIZED';
export const LICENSE_AUTH_STATUS_VALUES: readonly LicenseAuthStatus[] = [
  'AUTHORIZED',
  'AUTHORIZED_RESERVED',
  'OUT_OF_COMPLIANCE',
  'AUTHORIZATION_EXPIRED',
  'NOT_AUTHORIZED',
];

/**
 * Per-component certificate status (DESIGN.md §4.6.2). `NOT_APPLICABLE` is
 * deliberately excluded — `certificate-map.ts` filters that state out before
 * a `DeviceCertificateEntry` is ever produced (DESIGN.md §4.8's absent-not-
 * zero rule), so it never reaches this classifier. `AVAILABLE` is the only
 * value confirmed live so far.
 */
export type CertificateStatus = 'AVAILABLE';
export const CERTIFICATE_STATUS_VALUES: readonly CertificateStatus[] = ['AVAILABLE'];

/**
 * Lowercases an upstream enum value for use as a rendered label value
 * (DESIGN.md §4.3 — "Enum values are lowercased in labels"). Use this for
 * enums whose upstream and rendered forms differ only by case (link status,
 * operational status, HA node status/type, PSU status). Enums with a
 * differently-shaped rendered form (tunnel state) need a dedicated mapper —
 * see `tunnelStateLabel` below.
 */
export function lowercaseEnumLabel(value: string): string {
  return value.toLowerCase();
}

/**
 * Maps the upstream tunnel-state enum to its rendered label form
 * (DESIGN.md §4.2 — `ftd_s2s_tunnel_state{...,state="up|down|unknown"}`).
 * `TUNNEL_UP`/`TUNNEL_DOWN` don't merely lowercase to the target label —
 * `lowercaseEnumLabel` would produce "tunnel_up", not "up" — so this is a
 * separate, explicit mapping rather than a case transform.
 */
export function tunnelStateLabel(value: TunnelState | string): string {
  switch (value) {
    case 'TUNNEL_UP':
      return 'up';
    case 'TUNNEL_DOWN':
      return 'down';
    case 'UNKNOWN':
      return 'unknown';
    default:
      return 'unknown';
  }
}
