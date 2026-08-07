import { collectDefaultMetrics, Registry } from 'prom-client';

/**
 * One `Registry` per process (DESIGN.md §11), created fresh rather than
 * using prom-client's importable `register` singleton — a singleton would
 * make every test file share state unless each one remembered to `clear()`
 * it, which is exactly the kind of cross-test leakage `createRegistry`
 * avoids by construction.
 *
 * `ENABLE_DEFAULT_METRICS` (DESIGN.md §11, default `true`) is a config
 * concern owned by Stage 4's loader, not this module — `enableDefaultMetrics`
 * is taken as an already-resolved boolean so this module has no env-var
 * parsing of its own.
 */
export function createRegistry(enableDefaultMetrics = true): Registry {
  const registry = new Registry();
  if (enableDefaultMetrics) {
    collectDefaultMetrics({ register: registry });
  }
  return registry;
}
