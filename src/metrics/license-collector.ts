import type { Counter } from 'prom-client';
import { lowercaseEnumLabel } from '../domain/enums.ts';
import type { LicenseStatus } from '../domain/license-status.ts';
import { classifyLicenseAuthStatus, classifyLicenseRegStatus } from './enum-render.ts';
import type { LicenseMetrics } from './license-metrics.ts';

/**
 * Renders `LicenseStatus` into the `ftd_license_*` gauges (DESIGN.md
 * §4.6.2). Simpler than collector.ts/inventory-collector.ts's per-device
 * loop: there is at most one logical "row" here (fleet/manager-scoped, no
 * device labels), so each gauge is set at most once per render and a plain
 * increment is a safe cardinality count — no risk of two `set()` calls
 * colliding on the same label set within one render.
 *
 * The reset step below deliberately does NOT do a uniform `for (const gauge
 * of allGauges) gauge.reset()` loop, unlike every other collector in this
 * codebase: prom-client's `Gauge.reset()` re-seeds a *labelless* gauge back
 * to a single `{value: 0}` entry rather than removing it (verified against
 * prom-client directly — a real quirk, not a misreading of its docs), which
 * would render `ftd_license_eval_used`/etc. as a false `0` instead of
 * genuinely absent whenever upstream omits the field — exactly the "absent,
 * not zero" bug DESIGN.md §4.8 exists to prevent. `Gauge.remove()` (no
 * arguments, on a gauge declared with no `labelNames`) is the only
 * operation that actually empties it. The two `_info` gauges below DO have
 * labels, so their ordinary `.reset()` behaves correctly and is used as
 * normal.
 */
export interface LicenseCollectorDeps {
  metrics: LicenseMetrics;
  unknownEnumTotal: Counter<'metric' | 'value'>;
}

export interface LicenseRenderResult {
  seriesCount: number;
}

export function renderLicenseMetrics(
  deps: LicenseCollectorDeps,
  status: LicenseStatus | undefined,
): LicenseRenderResult {
  const { metrics, unknownEnumTotal } = deps;

  metrics.registrationInfo.reset();
  metrics.authorizationInfo.reset();
  metrics.evalUsed.remove();
  metrics.evalExpiresInDays.remove();
  metrics.lastSynchronizedTimestampSeconds.remove();
  metrics.lastRenewedTimestampSeconds.remove();

  if (status === undefined) {
    return { seriesCount: 0 };
  }

  let seriesCount = 0;

  const regResult = classifyLicenseRegStatus(status.regStatus);
  metrics.registrationInfo.set({ reg_status: regResult.label }, 1);
  seriesCount++;
  if (regResult.unrecognizedRawValue !== undefined) {
    unknownEnumTotal.inc({
      metric: 'ftd_license_registration_info',
      value: lowercaseEnumLabel(regResult.unrecognizedRawValue),
    });
  }

  if (status.authStatus !== undefined) {
    const authResult = classifyLicenseAuthStatus(status.authStatus);
    metrics.authorizationInfo.set({ auth_status: authResult.label }, 1);
    seriesCount++;
    if (authResult.unrecognizedRawValue !== undefined) {
      unknownEnumTotal.inc({
        metric: 'ftd_license_authorization_info',
        value: lowercaseEnumLabel(authResult.unrecognizedRawValue),
      });
    }
  }

  if (status.evalUsed !== undefined) {
    metrics.evalUsed.set(status.evalUsed ? 1 : 0);
    seriesCount++;
  }
  if (status.evalExpiresInDays !== undefined) {
    metrics.evalExpiresInDays.set(status.evalExpiresInDays);
    seriesCount++;
  }
  if (status.lastSynchronizedTime !== undefined) {
    metrics.lastSynchronizedTimestampSeconds.set(status.lastSynchronizedTime.getTime() / 1000);
    seriesCount++;
  }
  if (status.lastRenewedTime !== undefined) {
    metrics.lastRenewedTimestampSeconds.set(status.lastRenewedTime.getTime() / 1000);
    seriesCount++;
  }

  return { seriesCount };
}
