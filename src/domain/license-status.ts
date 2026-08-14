/**
 * Domain shape for Cisco's Smart License registration status (DESIGN.md
 * §4.6.2's v1.1 item), sourced from `GET .../license/smartlicenses` —
 * confirmed live (2026-08-14) to be byte-identical in shape on both SCC
 * (via the `cdfmc` proxy) and standalone FMC, since both expose the same
 * `fmc_platform` API surface. Fleet/domain-scoped, not per-device: the
 * response carries no device identifier at all, unlike every other metric
 * group in this project.
 */
export interface LicenseStatus {
  regStatus: string;
  /** Raw upstream enum, e.g. "AUTHORIZED" | "OUT_OF_COMPLIANCE" | .... Recognition happens at render time (DESIGN.md §3.2.6). */
  authStatus?: string;
  evalUsed?: boolean;
  evalExpiresInDays?: number;
  lastSynchronizedTime?: Date;
  lastRenewedTime?: Date;
}
