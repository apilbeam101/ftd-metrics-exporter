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
