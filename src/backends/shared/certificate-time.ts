/**
 * `devices/certificates`' expiry fields use a third timestamp shape,
 * distinct from both scc/time.ts and license-time.ts — confirmed live
 * (2026-08-14) on both backends: ISO 8601 but at *minute* precision, no
 * seconds field (`"2034-07-16T14:23Z"`), though a seconds-bearing value is
 * accepted too since nothing in the live samples rules it out. The literal
 * string `"-"` is a separate, expected sentinel meaning "not applicable"
 * (paired with a `NOT_APPLICABLE` status on the same component) — that is
 * handled by the caller (certificate-map.ts), not this parser, since it is
 * not a timestamp-shape problem.
 */
const CERT_EXPIRY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/;

export function parseCertificateExpiry(value: string): Date | undefined {
  const match = CERT_EXPIRY_PATTERN.exec(value);
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
    string | undefined,
  ];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  // Round-trip the parsed UTC components against the matched input digits —
  // `new Date()` silently rolls a calendar-overflow field (e.g. day 30 in a
  // 28-day February) into the next month rather than rejecting it, verified
  // directly (Opus review finding, 2026-08-14). Same check as
  // license-time.ts's parser, applied to this format's own capture groups.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second ?? '0')
  ) {
    return undefined;
  }
  return date;
}
