/**
 * The startup request-budget projection and warning (DESIGN.md §3.3.4).
 * Pure function, deliberately: it returns a value/message for the caller
 * to log (`src/index.ts`, Stage 11) rather than calling a logger itself,
 * matching every other module in this codebase that stays injectable
 * rather than reaching for a global side effect (see `sizing.ts`'s peers
 * — `budget.ts`, `spacing.ts` — which take an `onDefer` callback rather
 * than logging directly).
 *
 * The worked example from DESIGN.md §3.3.4: 50 devices × 5 metric
 * families at a 60 s poll interval = 250 requests/minute — "uncomfortably
 * close to the 300/minute ceiling." The warning threshold is ~70% of 300
 * (i.e. 210/minute) per the same section: "warn when the projection
 * exceeds ~70% of the budget."
 */

export const FMC_REQUEST_BUDGET_PER_MINUTE = 300;
export const WARNING_THRESHOLD_FRACTION = 0.7;

export interface FmcSizingProjection {
  requestsPerMinute: number;
  warning?: string;
}

export function projectFmcRequestVolume(
  deviceCount: number,
  familyCount: number,
  pollIntervalSeconds: number,
): FmcSizingProjection {
  const requestsPerMinute = (deviceCount * familyCount * 60) / pollIntervalSeconds;
  const threshold = FMC_REQUEST_BUDGET_PER_MINUTE * WARNING_THRESHOLD_FRACTION;

  if (requestsPerMinute <= threshold) {
    return { requestsPerMinute };
  }

  return {
    requestsPerMinute,
    warning:
      `Projected FMC request volume is ${requestsPerMinute.toFixed(1)} requests/minute ` +
      `(${deviceCount} devices x ${familyCount} metric families at a ${pollIntervalSeconds}s poll ` +
      `interval), which exceeds ${(WARNING_THRESHOLD_FRACTION * 100).toFixed(0)}% of FMC's documented ` +
      `${FMC_REQUEST_BUDGET_PER_MINUTE} requests/minute source-IP limit. Consider raising ` +
      'POLL_INTERVAL_SECONDS or reducing FMC_METRIC_FAMILIES to leave headroom for retries and ' +
      'other API consumers.',
  };
}
