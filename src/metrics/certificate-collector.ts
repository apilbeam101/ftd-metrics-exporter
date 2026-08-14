import type { Counter } from 'prom-client';
import type { DeviceCertificateEntry } from '../domain/certificate-status.ts';
import { lowercaseEnumLabel } from '../domain/enums.ts';
import { allCertificateGauges, type CertificateMetrics } from './certificate-metrics.ts';
import { classifyCertificateStatus } from './enum-render.ts';

/**
 * Renders `DeviceCertificateEntry[]` into the `ftd_certificate_*` gauges
 * (DESIGN.md §4.6.2). Same reset-then-repopulate + cardinality-tripwire
 * discipline as inventory-collector.ts.
 */
export interface CertificateCollectorDeps {
  metrics: CertificateMetrics;
  unknownEnumTotal: Counter<'metric' | 'value'>;
}

export interface CertificateRenderResult {
  seriesCount: number;
}

export function renderCertificateMetrics(
  deps: CertificateCollectorDeps,
  entries: readonly DeviceCertificateEntry[],
): CertificateRenderResult {
  const { metrics, unknownEnumTotal } = deps;

  for (const gauge of allCertificateGauges(metrics)) {
    gauge.reset();
  }

  const gaugeIndex = new Map<object, number>();
  const seenSeries = new Set<string>();
  function trackSet(gauge: object, labels: Record<string, string>): void {
    let index = gaugeIndex.get(gauge);
    if (index === undefined) {
      index = gaugeIndex.size;
      gaugeIndex.set(gauge, index);
    }
    const labelKey = Object.keys(labels)
      .sort()
      .map((key) => `${key}=${labels[key]}`)
      .join(',');
    seenSeries.add(`${index}{${labelKey}}`);
  }

  for (const entry of entries) {
    const base = {
      device_uid: entry.deviceUid,
      device_name: entry.deviceName,
      cert_name: entry.certName,
      cert_type: entry.certType,
    };

    metrics.expiryTimestampSeconds.set(base, entry.expiresAt.getTime() / 1000);
    trackSet(metrics.expiryTimestampSeconds, base);

    const statusResult = classifyCertificateStatus(entry.status);
    const statusLabels = { ...base, status: statusResult.label };
    metrics.statusInfo.set(statusLabels, 1);
    trackSet(metrics.statusInfo, statusLabels);
    if (statusResult.unrecognizedRawValue !== undefined) {
      unknownEnumTotal.inc({
        metric: 'ftd_certificate_status_info',
        value: lowercaseEnumLabel(statusResult.unrecognizedRawValue),
      });
    }
  }

  return { seriesCount: seenSeries.size };
}
