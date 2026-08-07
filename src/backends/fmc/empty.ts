import { isPlainObject } from '../shared/numbers.ts';

/**
 * A capability- or policy-gated-absent FMC metric family responds `200`
 * with no `items` key and `paging.count === 0` (DESIGN.md §14.6, Appendix
 * C) — absence, not an error and not a parse problem. Callers must treat
 * this as "the group is not present for this device" and produce no
 * diagnostic (DESIGN.md §4.8: "a warning that fires constantly on healthy
 * systems trains operators to ignore logs").
 *
 * Takes an unvalidated `unknown`-shaped body deliberately: an FMC per-
 * device error envelope (`{"error":{...}}`, no `items`, no `paging` —
 * confirmed shape in test/fixtures/fmc/device-not-connected.json) has no
 * `items` key either, and must NOT be misclassified as normal absence —
 * that would silently swallow a real per-device failure with zero
 * diagnostics. A legitimate absence response always carries a `paging`
 * block; an error envelope never does. Checking for `paging` (rather than
 * merely the absence of `items`) is what tells the two apart.
 */
export function isEmptyFamilyResponse(response: Record<string, unknown>): boolean {
  const items = response.items;
  if (items === undefined) {
    return isPlainObject(response.paging);
  }
  return Array.isArray(items) && items.length === 0;
}
