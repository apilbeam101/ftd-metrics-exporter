/**
 * SCC's `startTime`/`endTime` are ISO 8601 (DESIGN.md Appendix B, §3.2.6).
 * Unparseable values are dropped with a diagnostic, not fatal — the rest
 * of the snapshot survives (DESIGN.md §3.2.6).
 *
 * Requires an explicit ISO 8601 shape rather than trusting `new Date()`'s
 * permissive parsing, which would also silently "succeed" on FMC's
 * differently-shaped `"YYYY-MM-DD HH:mm:ss.SSS UTC"` timestamps
 * (DESIGN.md §14.1) — a backend-confusion bug that should fail loudly
 * rather than produce a plausible-looking wrong date.
 */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function parseSccTimestamp(value: string): Date | undefined {
  if (!ISO_8601_PATTERN.test(value)) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}
