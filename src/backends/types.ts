import type { DeviceCertificateEntry } from '../domain/certificate-status.ts';
import type { LicenseStatus } from '../domain/license-status.ts';
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

/**
 * Narrow extension interfaces (DESIGN.md §4.6.2), same "narrow the base
 * `HealthBackend` cast at the one call site that needs it" shape
 * `SccHealthBackend`/`getSccDeviceInventoryReader` already established for
 * device inventory — kept as separate interfaces rather than widening
 * `HealthBackend` itself, even though *both* concrete adapters now
 * implement both of these (unlike device inventory, which stays SCC-only):
 * widening the base interface would force every existing `HealthBackend`
 * mock across the test suite to grow two new methods it has no reason to
 * care about, for no behavioral benefit over the narrowing-cast pattern
 * already in place.
 */
export interface LicenseStatusBackend extends HealthBackend {
  /** Sync, no network — safe to call from the render path. Returns `undefined` before the first successful refresh, after `close()`, or if upstream reported no license record. */
  getLicenseStatus(): LicenseStatus | undefined;
}

export interface DeviceCertificatesBackend extends HealthBackend {
  /** Sync, no network — safe to call from the render path. Returns `[]` before the first successful refresh or after `close()`. */
  getDeviceCertificates(): DeviceCertificateEntry[];
}
