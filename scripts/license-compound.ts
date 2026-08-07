/**
 * Pure detection logic for scripts/check-license-compound.ts, split out so
 * it can be imported by a test with no side effects (the CLI script itself
 * shells out to license-checker-rseidelsohn at module-load time).
 */
export interface LicenseEntry {
  licenses?: string | string[];
}

export function findOffenders(
  data: Record<string, LicenseEntry>,
): Array<{ name: string; license: string }> {
  const offenders: Array<{ name: string; license: string }> = [];
  for (const [name, entry] of Object.entries(data)) {
    const license = Array.isArray(entry.licenses)
      ? entry.licenses.join(', ')
      : (entry.licenses ?? '');
    if (/\band\b/i.test(license) || license.trim().length === 0 || /unknown/i.test(license)) {
      offenders.push({ name, license });
    }
  }
  return offenders;
}
