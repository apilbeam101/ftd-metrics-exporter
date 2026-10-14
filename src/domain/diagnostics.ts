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

export interface MapResult<T> {
  snapshots: T[];
  parseErrors: ParseError[];
}
