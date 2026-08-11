import type { AppConfig } from './types.ts';

/**
 * Self-contained effective-configuration summary formatter (DESIGN.md
 * §9.4/§8.5 — "the startup configuration summary is generated from a
 * redaction-aware formatter, and there is no code path that prints the raw
 * config object"). Deliberately does not import from src/log/ (Stage 5,
 * built in parallel) — this module owns its own redaction so it has no
 * dependency on that stage's completion or module shape.
 *
 * `AppConfig`'s secret fields are already `Secret` instances (see
 * secret.ts) whose `toString()`/`toJSON()` return "[REDACTED]" by
 * construction, so this formatter's main job is to lay out the non-secret
 * fields legibly; it never needs to know a field is a `Secret` to redact it
 * correctly. That said, it is written to be safe even if a plain string
 * secret were passed through untransformed — see `redactValue` below — as a
 * defense-in-depth measure, since test 19 asserts on the actual absence of
 * the secret value, not merely that some redaction path executed.
 */

const SECRET_KEY_PATTERN = /token|password|secret|apikey|api_key|bearer|authorization/i;

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  if (value !== null && typeof value === 'object' && 'reveal' in value) {
    return '[REDACTED]';
  }
  return value;
}

function formatLine(key: string, value: unknown): string {
  if (value === undefined) return `  ${key}: (unset)`;
  if (Array.isArray(value)) return `  ${key}: ${value.join(',')}`;
  return `  ${key}: ${String(value)}`;
}

/**
 * Builds the human-readable effective-configuration summary logged once at
 * startup. Returns a plain multi-line string (no logger dependency) so
 * callers can pass it to whatever line-based sink they use.
 */
export function formatConfigSummary(config: AppConfig): string {
  const lines: string[] = ['Effective configuration:'];

  lines.push(formatLine('BACKEND_TYPE', config.backend.kind));
  lines.push(formatLine('METRICS_PORT', config.metricsPort));
  lines.push(formatLine('METRICS_BIND_ADDRESS', config.metricsBindAddress));
  lines.push(formatLine('POLL_INTERVAL_SECONDS', config.pollIntervalSeconds));
  lines.push(formatLine('LOG_LEVEL', config.logLevel));
  lines.push(formatLine('LOG_FORMAT', config.logFormat));
  lines.push(formatLine('REQUEST_TIMEOUT_SECONDS', config.requestTimeoutSeconds));
  lines.push(formatLine('ENABLE_DEFAULT_METRICS', config.enableDefaultMetrics));

  if (config.backend.kind === 'scc') {
    const backend = config.backend;
    lines.push(formatLine('SCC_BASE_URL', backend.baseUrl));
    lines.push(formatLine('SCC_API_TOKEN', redactValue('SCC_API_TOKEN', backend.apiToken)));
    lines.push(formatLine('SCC_FMC_UID', backend.fmcUid));
    lines.push(formatLine('SCC_TIME_RANGE', backend.timeRange));
    lines.push(
      formatLine('SCC_INVENTORY_POLL_INTERVAL_SECONDS', backend.inventoryPollIntervalSeconds),
    );
  } else {
    const backend = config.backend;
    lines.push(formatLine('FMC_HOST', backend.host));
    lines.push(formatLine('FMC_USERNAME', backend.username));
    lines.push(formatLine('FMC_PASSWORD', redactValue('FMC_PASSWORD', backend.password)));
    lines.push(formatLine('FMC_DOMAIN_UUID', backend.domainUuid));
    lines.push(formatLine('FMC_CA_BUNDLE_PATH', backend.caBundlePath));
    lines.push(formatLine('FMC_TLS_INSECURE_SKIP_VERIFY', backend.tlsInsecureSkipVerify));
    lines.push(formatLine('FMC_MAX_CONCURRENT_REQUESTS', backend.maxConcurrentRequests));
    lines.push(formatLine('FMC_DISCOVERY_INTERVAL_SECONDS', backend.discoveryIntervalSeconds));
    lines.push(formatLine('FMC_METRIC_FAMILIES', backend.metricFamilies));
    lines.push(formatLine('FMC_TIME_RANGE', backend.timeRange));
  }

  if (config.metricsTls !== undefined) {
    lines.push(formatLine('METRICS_TLS_CERT_PATH', config.metricsTls.certPath));
    lines.push(formatLine('METRICS_TLS_KEY_PATH', config.metricsTls.keyPath));
    lines.push(formatLine('METRICS_TLS_MIN_VERSION', config.metricsTls.minVersion));
    lines.push(formatLine('METRICS_TLS_CLIENT_CA_PATH', config.metricsTls.clientCaPath));
  }

  return lines.join('\n');
}
