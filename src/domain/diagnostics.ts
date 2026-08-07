/**
 * Diagnostics returned as data from the pure response mappers (Stage 2),
 * never emitted via a logger or a metrics counter directly — DESIGN.md
 * §3.2.6 keeps mapping functions pure so they stay exhaustively testable;
 * the adapter layer (Stage 7/8) translates these into
 * `ftd_exporter_parse_errors_total{group}` and
 * `ftd_exporter_unknown_enum_total{metric,value}`.
 */

export interface ParseError {
  /** Device this diagnostic pertains to, when known. */
  deviceUid?: string;
  /** The metric group or field affected, e.g. "cpu", "startTime". */
  group: string;
  message: string;
}

/**
 * Emitted by the Stage 3 renderer, not by the mappers in this file's
 * package. `metric` is a *rendered* metric name (e.g.
 * "ftd_interface_link_up"), a vocabulary the pure mapper does not have —
 * DESIGN.md §3.2.6 keeps the raw upstream string on the domain object
 * precisely so recognition happens at render time. See the comment on
 * `mapInterfaceEntry` in shared/interfaces.ts for the full rationale.
 */
export interface UnknownEnum {
  /** The rendered metric name this enum feeds, e.g. "ftd_interface_link_up". */
  metric: string;
  /** The raw, unrecognized upstream value. */
  value: string;
}

export interface MapResult<T> {
  snapshots: T[];
  parseErrors: ParseError[];
}
