/**
 * Domain shape for per-device certificate enrollment status (DESIGN.md
 * §4.6.2's v1.1 item), sourced from `GET .../devices/certificates` —
 * confirmed live (2026-08-14) on both backends. One entry per enrolled
 * certificate's CA or identity component (a single enrolled certificate can
 * contribute up to two entries). A component with status `NOT_APPLICABLE`
 * (e.g. a self-signed cert's CA half) is genuinely absent, not an entry with
 * a placeholder expiry — see certificate-map.ts.
 */
export type CertificateComponentType = 'ca' | 'identity';

export interface DeviceCertificateEntry {
  deviceUid: string;
  deviceName: string;
  certName: string;
  certType: CertificateComponentType;
  /** Raw upstream enum, e.g. "AVAILABLE". Recognition happens at render time (DESIGN.md §3.2.6). */
  status: string;
  expiresAt: Date;
}
