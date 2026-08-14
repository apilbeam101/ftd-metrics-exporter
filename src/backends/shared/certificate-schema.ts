/**
 * Wire shape for `GET .../devices/certificates`, confirmed live (2026-08-14)
 * identical on both SCC (via the `cdfmc` proxy) and standalone FMC. `id`'s
 * *meaning* differs by backend even though the field name doesn't: on FMC
 * it is the same device UUID used everywhere else; on SCC it is
 * `uidOnFmc` — a third identifier for the same device, distinct from both
 * `/health/metrics`'s `deviceUid` and `/v1/inventory/devices`'s `uid`.
 * That asymmetry is why the mapper below takes a lookup callback instead of
 * assuming `id` is directly usable as `deviceUid`.
 *
 * `caCertExpiryDate`/`identityCertExpiryDate` are the literal string `"-"`
 * when the paired `*CertificateStatus` is `"NOT_APPLICABLE"` (e.g. a
 * self-signed cert has no CA component) — confirmed on both live captures.
 */
export interface EnrolledCertificateEntry {
  certificate?: { name?: string };
  enrollmentType?: string;
  caCertificateStatus?: string;
  caCertExpiryDate?: string;
  identityCertificateStatus?: string;
  identityCertExpiryDate?: string;
}

export interface DeviceCertificateRecord {
  id?: string;
  enrolledCertificates?: EnrolledCertificateEntry[];
}

export interface DeviceCertificatesResponse {
  items: DeviceCertificateRecord[];
}
