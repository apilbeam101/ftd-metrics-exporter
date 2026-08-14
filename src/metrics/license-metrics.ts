import { Gauge, type Registry } from 'prom-client';

/**
 * Declarations for Smart License status metrics (DESIGN.md §4.6.2). Fleet
 * (well, per-manager: one SCC tenant, or one FMC instance) scoped, not
 * per-device — the upstream response carries no device identifier at all
 * (confirmed live, 2026-08-14), so unlike every other metric group in this
 * project, none of these gauges carry `device_uid`/`device_name` labels.
 */
export interface LicenseMetrics {
  registrationInfo: Gauge<'reg_status'>;
  authorizationInfo: Gauge<'auth_status'>;
  evalUsed: Gauge<never>;
  evalExpiresInDays: Gauge<never>;
  lastSynchronizedTimestampSeconds: Gauge<never>;
  lastRenewedTimestampSeconds: Gauge<never>;
}

export function createLicenseMetrics(registry: Registry): LicenseMetrics {
  const registers = [registry];

  const metrics: LicenseMetrics = {
    registrationInfo: new Gauge({
      name: 'ftd_license_registration_info',
      help: 'Always 1 when license status is known. reg_status carries the raw Smart License registration state (lowercased), or unknown.',
      labelNames: ['reg_status'],
      registers,
    }),
    authorizationInfo: new Gauge({
      name: 'ftd_license_authorization_info',
      help: 'Always 1 when license authorization status is known. auth_status carries the raw Smart License authorization state (lowercased), or unknown. Omitted if upstream did not report an authorization status.',
      labelNames: ['auth_status'],
      registers,
    }),
    evalUsed: new Gauge({
      name: 'ftd_license_eval_used',
      help: '1 if the Smart License evaluation period has been used, 0 otherwise. Omitted if upstream did not report this field.',
      registers,
    }),
    evalExpiresInDays: new Gauge({
      name: 'ftd_license_eval_expires_in_days',
      help: 'Days remaining in the Smart License evaluation period. Omitted if upstream did not report this field.',
      registers,
    }),
    lastSynchronizedTimestampSeconds: new Gauge({
      name: 'ftd_license_last_synchronized_timestamp_seconds',
      help: 'Unix timestamp of the last successful Smart License synchronization with Cisco. Omitted if upstream did not report this field.',
      registers,
    }),
    lastRenewedTimestampSeconds: new Gauge({
      name: 'ftd_license_last_renewed_timestamp_seconds',
      help: 'Unix timestamp of the last Smart License renewal. Omitted if upstream did not report this field.',
      registers,
    }),
  };

  // A labelless prom-client Gauge starts life with an implicit single
  // `{value: 0}` entry (verified directly against prom-client — the same
  // quirk `license-collector.ts`'s reset step already works around on every
  // render). Without this sweep, a registry read taken before the first
  // render — a debug endpoint, a test harness — would publish four false
  // zeros for fields upstream never actually reported (Opus review finding,
  // 2026-08-14). The two labeled `_info` gauges above start genuinely empty
  // and need no equivalent call.
  metrics.evalUsed.remove();
  metrics.evalExpiresInDays.remove();
  metrics.lastSynchronizedTimestampSeconds.remove();
  metrics.lastRenewedTimestampSeconds.remove();

  return metrics;
}
