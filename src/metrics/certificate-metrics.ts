import { Gauge, type Registry } from 'prom-client';

/** Declarations for per-device certificate-expiry metrics (DESIGN.md §4.6.2). */
const CERTIFICATE_LABELS = ['device_uid', 'device_name', 'cert_name', 'cert_type'] as const;
const CERTIFICATE_STATUS_LABELS = [...CERTIFICATE_LABELS, 'status'] as const;

export interface CertificateMetrics {
  expiryTimestampSeconds: Gauge<(typeof CERTIFICATE_LABELS)[number]>;
  statusInfo: Gauge<(typeof CERTIFICATE_STATUS_LABELS)[number]>;
}

/** Every gauge in `CertificateMetrics`, for reset-all/enumerate-all callers — mirrors device-metrics.ts's `allDeviceGauges`. */
export function allCertificateGauges(metrics: CertificateMetrics): Gauge<string>[] {
  return Object.values(metrics);
}

export function createCertificateMetrics(registry: Registry): CertificateMetrics {
  const registers = [registry];

  return {
    expiryTimestampSeconds: new Gauge({
      name: 'ftd_certificate_expiry_timestamp_seconds',
      help: 'Unix timestamp when this certificate component (cert_type: ca|identity) expires. Omitted entirely for a component reported NOT_APPLICABLE upstream (e.g. a self-signed certificate has no CA component) — genuinely absent, not zero.',
      labelNames: CERTIFICATE_LABELS,
      registers,
    }),
    statusInfo: new Gauge({
      name: 'ftd_certificate_status_info',
      help: 'Always 1. Informational; status carries the raw upstream deployment/availability state (lowercased), or unknown. Same omission rule as ftd_certificate_expiry_timestamp_seconds for a NOT_APPLICABLE component.',
      labelNames: CERTIFICATE_STATUS_LABELS,
      registers,
    }),
  };
}
