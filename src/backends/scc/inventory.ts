import type { DeviceInventoryEntry } from '../../domain/device-inventory.ts';
import type { Clock } from '../../http/clock.ts';

/**
 * Refresh-if-due cache for SCC's device inventory, on its own independent
 * cadence from the health-metrics poll (DESIGN.md §4.6.1's v1.1 item). Mirrors
 * `backends/fmc/discovery.ts`'s `createFmcDiscovery` cache-with-TTL pattern,
 * split into two halves that pattern doesn't need:
 *
 * - `refreshIfDue()` — async, does the actual HTTP work when due. Called
 *   only from the poll path (inside `SccAdapter.fetchSnapshot()`), so it
 *   shares that adapter's spacing guard and never runs concurrently with
 *   the health-metrics request against SCC's 2 requests/minute limit
 *   (DESIGN.md §3.2.4) — the two calls are simply two callers of the same
 *   guard, so the limit holds structurally regardless of either cadence.
 * - `getCached()` — sync, returns whatever the last successful refresh
 *   produced. Called only from the render path (`renderMetrics` in
 *   index.ts), which must never reach the network (the poll-cache-serve
 *   contract, DESIGN.md §2.2) — `createFmcDiscovery`'s single `getDevices()`
 *   doesn't need this split because FMC never renders discovery data
 *   directly as a metric.
 *
 * A refresh failure keeps the previous list and does not throw — same
 * rationale as FMC discovery: an inventory hiccup must not turn an
 * otherwise-successful health poll cycle into a failure.
 */
export interface CreateSccDeviceInventoryOptions {
  clock: Clock;
  /** `SCC_INVENTORY_POLL_INTERVAL_SECONDS` in ms. */
  intervalMs: number;
  fetchDevices: () => Promise<DeviceInventoryEntry[]>;
  onFailure?: () => void;
}

export interface SccDeviceInventory {
  refreshIfDue(): Promise<void>;
  getCached(): DeviceInventoryEntry[];
}

export function createSccDeviceInventory(
  options: CreateSccDeviceInventoryOptions,
): SccDeviceInventory {
  let cached: DeviceInventoryEntry[] = [];
  let lastSuccessAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  async function runRefresh(): Promise<void> {
    try {
      cached = await options.fetchDevices();
      lastSuccessAt = options.clock.now();
    } catch {
      options.onFailure?.();
    }
  }

  return {
    refreshIfDue(): Promise<void> {
      if (inFlight !== undefined) {
        return inFlight;
      }
      const isDue =
        lastSuccessAt === undefined || options.clock.now() - lastSuccessAt >= options.intervalMs;
      if (!isDue) {
        return Promise.resolve();
      }
      const promise = runRefresh().finally(() => {
        if (inFlight === promise) {
          inFlight = undefined;
        }
      });
      inFlight = promise;
      return promise;
    },
    getCached(): DeviceInventoryEntry[] {
      return cached;
    },
  };
}
