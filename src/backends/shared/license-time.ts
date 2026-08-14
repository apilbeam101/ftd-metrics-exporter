/**
 * The Smart License endpoint's timestamps are neither SCC's ISO 8601
 * (scc/time.ts) nor FMC's health/metrics format (fmc/time.ts) — confirmed
 * live (2026-08-14) on both backends: `"YYYY-MM-DDTHH:MM:SSUTC"`, a literal
 * "UTC" suffix in place of "Z" or an offset. Same "validate the narrower
 * format explicitly" discipline as scc/time.ts: `Date.parse` would silently
 * mis-parse or reject this shape in browser-dependent ways, so the suffix is
 * rewritten to "Z" only after an explicit shape check.
 */
const LICENSE_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})UTC$/;

export function parseLicenseTimestamp(value: string): Date | undefined {
  const match = LICENSE_TIMESTAMP_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  // `new Date()` silently rolls a calendar-overflow field (e.g. day 30 in a
  // 28-day February) forward into the next month rather than rejecting it —
  // confirmed directly (`new Date('2034-02-30T00:00:00Z')` succeeds as
  // March 2nd). Round-tripping the parsed UTC components against the
  // matched input digits catches that silently-wrong date instead of
  // returning it (Opus review finding, 2026-08-14).
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) {
    return undefined;
  }
  return date;
}
