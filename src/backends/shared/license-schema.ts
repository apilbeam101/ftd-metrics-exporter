/**
 * Wire shape for `GET .../license/smartlicenses`, confirmed live
 * (2026-08-14) identical on both SCC (via the `cdfmc` proxy) and standalone
 * FMC. One quirk seen on both live captures: FMC's response had the
 * `metadata` key appear twice on the same item (both occurrences identical
 * in content) — not modeled specially here, since `JSON.parse` already
 * resolves a duplicate key to its last occurrence, which is what the mapper
 * reads regardless.
 */
export interface SccSmartLicenseMetadata {
  authStatus?: string;
  evalUsed?: boolean;
  evalExpiresInDays?: number;
  lastSynchronizedTime?: string;
  lastRenewedTime?: string;
}

export interface SmartLicenseEntry {
  regStatus?: string;
  metadata?: SccSmartLicenseMetadata;
}

export interface SmartLicenseResponse {
  items: SmartLicenseEntry[];
}
