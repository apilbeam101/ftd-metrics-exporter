import type { TimeRange } from '../../config/types.ts';
import type { FmcMetricFamily } from './schema.ts';

/**
 * The FMC `filter` query-parameter builder (DESIGN.md §3.3.4, §12.1: "a
 * small function with an unusual format and therefore a likely bug site").
 * The *decoded* value FMC expects is exactly
 * `device_uuid:<uuid>;metric:<FAMILY>;timeRange:<range>` — a
 * semicolon-delimited `key:value` string, not standard
 * `key1=v1&key2=v2` query syntax. This function builds that exact decoded
 * string; `buildAggregateMetricsUrl` below is responsible for the one
 * `encodeURIComponent`-equivalent step needed to place it inside a URL
 * (Appendix C's captured `links.self` shows the accepted encoded form —
 * `%3A`/`%3B` for the colons/semicolons — which is exactly what
 * `URLSearchParams`/`encodeURIComponent` produce, so no custom encoding is
 * needed here).
 */

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Rejects (throws) rather than silently truncating or passing through a
 * device UUID containing unexpected characters — plan testing step 21.
 * A UUID that failed this check would otherwise be concatenated directly
 * into the filter string, and a `;` or `:` inside it would corrupt the
 * `metric:`/`timeRange:` clauses that follow it. FMC device UUIDs are
 * always well-formed RFC 4122 UUIDs in every observed response
 * (Appendix C, devicerecords fixtures); a value that doesn't match this
 * shape indicates a bug elsewhere (e.g. discovery parsing garbage), not a
 * legitimate device this function should try to accommodate.
 */
function assertValidDeviceUuid(deviceUuid: string): void {
  if (!UUID_PATTERN.test(deviceUuid)) {
    throw new Error(
      `buildFmcFilter: "${deviceUuid}" is not a well-formed device UUID — refusing to build a filter string that could corrupt the semicolon-delimited clauses that follow it`,
    );
  }
}

export function buildFmcFilter(
  deviceUuid: string,
  family: FmcMetricFamily,
  timeRange: TimeRange,
): string {
  assertValidDeviceUuid(deviceUuid);
  return `device_uuid:${deviceUuid};metric:${family};timeRange:${timeRange}`;
}

/**
 * Builds the full `health/aggregatemetrics` request URL for one
 * device/family/timeRange, percent-encoding the filter string's `:`/`;`
 * characters via `URLSearchParams` (the standard, non-bespoke way to place
 * an arbitrary string value in a query parameter) rather than hand-rolling
 * escaping — DESIGN.md §12.1 specifically flags this filter builder as a
 * likely bug site, and reusing a standard encoder removes one hand-written
 * escaping implementation from that risk surface.
 */
export function buildAggregateMetricsUrl(
  host: string,
  domainUuid: string,
  deviceUuid: string,
  family: FmcMetricFamily,
  timeRange: TimeRange,
): string {
  const filter = buildFmcFilter(deviceUuid, family, timeRange);
  const params = new URLSearchParams({ filter });
  return `https://${host}/api/fmc_config/v1/domain/${encodeURIComponent(domainUuid)}/health/aggregatemetrics?${params.toString()}`;
}
