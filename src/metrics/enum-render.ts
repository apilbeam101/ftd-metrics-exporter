import {
  HA_NODE_STATUS_VALUES,
  HA_NODE_TYPE_VALUES,
  lowercaseEnumLabel,
  TUNNEL_STATE_VALUES,
  tunnelStateLabel,
} from '../domain/enums.ts';

/**
 * Render-time enum recognition (DESIGN.md §4.4) — deliberately not done at
 * parse time (§3.2.6), so this module is the one place that decides what
 * counts as a recognized upstream value. Pure and side-effect-free: callers
 * (collector.ts) own incrementing `ftd_exporter_unknown_enum_total`.
 */

export type BinaryEnumResult =
  | { kind: 'absent' }
  | { kind: 'recognized'; value: 0 | 1 }
  | { kind: 'unrecognized'; rawValue: string };

/**
 * Classifies a raw UP/DOWN-shaped upstream value. Shared by link status,
 * operational status, and the three chassis PSU status fields — all are the
 * same two-value vocabulary (DESIGN.md §4.4 rule 2: binary states become a
 * boolean gauge named for the true condition).
 */
export function classifyBinaryEnum(raw: string | undefined): BinaryEnumResult {
  if (raw === undefined) return { kind: 'absent' };
  if (raw === 'UP') return { kind: 'recognized', value: 1 };
  if (raw === 'DOWN') return { kind: 'recognized', value: 0 };
  return { kind: 'unrecognized', rawValue: raw };
}

export interface StateSetResult {
  /** The lowercased label value to set to 1; every other possible value is set to 0. */
  activeLabel: string;
  /**
   * Set only when `raw` was a genuinely novel value, not merely the
   * already-recognized literal "UNKNOWN"/"TUNNEL_..." fallback — those are
   * expected upstream values, not schema drift, and must not fire the
   * diagnostic counter (DESIGN.md §4.4's "new Cisco enum value" rationale).
   */
  unrecognizedRawValue?: string;
}

/** State-set classification for `ftd_ha_node_status` (DESIGN.md §4.2/§4.4). */
export function classifyHaNodeStatus(raw: string): StateSetResult {
  if ((HA_NODE_STATUS_VALUES as readonly string[]).includes(raw)) {
    return { activeLabel: lowercaseEnumLabel(raw) };
  }
  return { activeLabel: 'unknown', unrecognizedRawValue: raw };
}

/** State-set classification for `ftd_s2s_tunnel_state` (DESIGN.md §4.2/§4.4). */
export function classifyTunnelState(raw: string): StateSetResult {
  if ((TUNNEL_STATE_VALUES as readonly string[]).includes(raw)) {
    return { activeLabel: tunnelStateLabel(raw) };
  }
  return { activeLabel: 'unknown', unrecognizedRawValue: raw };
}

export interface InfoEnumResult {
  /** The lowercased label value to carry on the `_info` gauge. */
  label: string;
  /** Set only when `raw` did not match the documented vocabulary — see `StateSetResult`. */
  unrecognizedRawValue?: string;
}

/**
 * Classification for informational-attribute labels (DESIGN.md §4.4 rule 3:
 * "an `_info`-suffixed gauge always equal to 1"). Like the state-set enums,
 * an unrecognized value falls back to the bounded `"unknown"` label — the
 * gauge is still emitted (never omitted, since it is informational, not a
 * health signal), but the raw value only ever reaches
 * `ftd_exporter_unknown_enum_total` (already bounded by being a diagnostic),
 * never the `node_type` label itself, so a new Cisco role/type value cannot
 * mint an unbounded series on `ftd_ha_node_info`.
 */
export function classifyHaNodeType(raw: string): InfoEnumResult {
  if ((HA_NODE_TYPE_VALUES as readonly string[]).includes(raw)) {
    return { label: lowercaseEnumLabel(raw) };
  }
  return { label: 'unknown', unrecognizedRawValue: raw };
}
