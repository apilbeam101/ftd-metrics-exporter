import type { DeviceHealthSnapshot } from '../domain/snapshot.ts';

/**
 * DESIGN.md §2.3, verbatim. Deliberately this narrow: every additional
 * method is a place for one backend's model (SCC's single batched call vs
 * FMC's many-request discovery-and-fan-out) to leak into the other's
 * adapter surface. `init()` covers auth bootstrap and any one-time
 * resolution (e.g. FMC's domain UUID); `fetchSnapshot()` is the only
 * per-poll operation; `close()` releases whatever `init()` acquired.
 */
export interface HealthBackend {
  readonly kind: 'scc' | 'fmc';
  init(): Promise<void>;
  fetchSnapshot(): Promise<DeviceHealthSnapshot[]>;
  close(): Promise<void>;
}
