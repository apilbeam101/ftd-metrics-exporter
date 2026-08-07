/**
 * FMC's `startTime`/`endTime` are NOT ISO 8601 — confirmed live as
 * "YYYY-MM-DD HH:mm:ss.SSS UTC" (DESIGN.md §14.1, Appendix C). Handing
 * this string to `new Date()` and hoping is exactly the mistake DESIGN.md
 * warns against: "the FMC adapter's parser must not assume a shared
 * timestamp format across backends." This parser accepts only that exact
 * shape and always treats it as UTC.
 */
const FMC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) UTC$/;

export function parseFmcTimestamp(value: string): Date | undefined {
  const match = FMC_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, millis] = match;
  const isoLike = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
  const date = new Date(isoLike);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}
