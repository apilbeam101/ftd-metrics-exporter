import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { Secret } from './secret.ts';
import {
  type AppConfig,
  type BackendConfig,
  LOG_FORMAT_VALUES,
  LOG_LEVEL_VALUES,
  type LogFormat,
  type LogLevel,
  METRIC_FAMILY_VALUES,
  type MetricFamily,
  type MetricsTlsConfig,
  TIME_RANGE_VALUES,
  type TimeRange,
  TLS_MIN_VERSION_VALUES,
  type TlsMinVersion,
} from './types.ts';

/**
 * DESIGN.md §14.12 / plan Stage 4 Risks: "the legacy-hostname warning
 * depends on a hostname pattern Cisco could change. Keep the pattern in
 * one named constant." Matches `edge.<region>.cdo.cisco.com` case-
 * insensitively, region being any DNS label (`eu`, `us`, `apj`, ...).
 */
export const LEGACY_SCC_HOSTNAME_PATTERN = /^edge\.[a-z0-9-]+\.cdo\.cisco\.com$/i;

const SCC_ONLY_VARS = [
  'SCC_BASE_URL',
  'SCC_API_TOKEN',
  'SCC_FMC_UID',
  'SCC_TIME_RANGE',
  'SCC_INVENTORY_POLL_INTERVAL_SECONDS',
] as const;

const FMC_ONLY_VARS = [
  'FMC_HOST',
  'FMC_USERNAME',
  'FMC_PASSWORD',
  'FMC_DOMAIN_UUID',
  'FMC_CA_BUNDLE_PATH',
  'FMC_TLS_INSECURE_SKIP_VERIFY',
  'FMC_MAX_CONCURRENT_REQUESTS',
  'FMC_DISCOVERY_INTERVAL_SECONDS',
  'FMC_METRIC_FAMILIES',
  'FMC_TIME_RANGE',
] as const;

/**
 * A flat `string[]` cannot distinguish DESIGN.md §9.6's "loud, error-severity
 * warning" (FMC_TLS_INSECURE_SKIP_VERIFY=true) from an informational hint
 * (SCC_TIME_RANGE set while BACKEND_TYPE=fmc) — a caller would be forced to
 * string-match on content to pick a log level. Carrying severity structurally
 * means Stage 11's logger can pick the right level without parsing text.
 */
export interface ConfigWarning {
  severity: 'warn' | 'error';
  message: string;
}

export type ValidationResult =
  | { ok: true; config: AppConfig; warnings: ConfigWarning[] }
  | { ok: false; errors: string[]; warnings: ConfigWarning[] };

/**
 * `env` is always `Record<string, string | undefined>` at this boundary —
 * the same "validate `unknown`-shaped input, never trust it" discipline the
 * domain mappers apply to upstream JSON (see src/backends/shared/numbers.ts)
 * applies here to `process.env`.
 */
export function validate(env: Readonly<Record<string, string | undefined>>): ValidationResult {
  const errors: string[] = [];
  const warnings: ConfigWarning[] = [];

  const backendType = validateBackendType(env, errors);
  reportCrossBackendVars(env, backendType, warnings);

  const metricsPort = validatePositiveInt(env, 'METRICS_PORT', 10049, errors, {
    min: 1,
    max: 65535,
  });
  const metricsBindAddress = nonEmpty(env.METRICS_BIND_ADDRESS) ?? '0.0.0.0';
  const pollIntervalSeconds = validatePollInterval(env, backendType, errors);
  const logLevel = validateEnum(env, 'LOG_LEVEL', LOG_LEVEL_VALUES, 'info', errors) as LogLevel;
  const logFormat = validateEnum(env, 'LOG_FORMAT', LOG_FORMAT_VALUES, 'json', errors) as LogFormat;
  const requestTimeoutSeconds = validatePositiveInt(env, 'REQUEST_TIMEOUT_SECONDS', 30, errors, {
    min: 1,
    max: MAX_TIMER_SECONDS,
  });
  const enableDefaultMetrics = validateBoolean(env, 'ENABLE_DEFAULT_METRICS', true, errors);

  const backend = validateBackend(env, backendType, errors, warnings);
  const metricsTls = validateMetricsTls(env, errors);

  if (errors.length > 0 || backend === undefined) {
    return { ok: false, errors, warnings };
  }

  const config: AppConfig = {
    backend,
    metricsPort,
    metricsBindAddress,
    pollIntervalSeconds,
    logLevel,
    logFormat,
    requestTimeoutSeconds,
    enableDefaultMetrics,
    ...(metricsTls !== undefined ? { metricsTls } : {}),
  };

  return { ok: true, config, warnings };
}

/**
 * Treats a whitespace-only value the same as an empty one — a trailing
 * space after `=` in a `.env` file, or a stray newline in a Kubernetes
 * Secret, is not a meaningful hostname/username/password, and DESIGN.md
 * §8.5 requires required variables be "present and non-empty" (a run of
 * spaces is not meaningfully present).
 */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : value;
}

function validateBackendType(
  env: Readonly<Record<string, string | undefined>>,
  errors: string[],
): 'scc' | 'fmc' | undefined {
  const raw = nonEmpty(env.BACKEND_TYPE);
  if (raw === undefined) {
    errors.push('BACKEND_TYPE is required and must be exactly "scc" or "fmc", but is unset');
    return undefined;
  }
  if (raw !== 'scc' && raw !== 'fmc') {
    errors.push(`BACKEND_TYPE must be exactly "scc" or "fmc" (case-sensitive), got "${raw}"`);
    return undefined;
  }
  return raw;
}

/**
 * Variables that carry a documented default (DESIGN.md §8.2/§8.3) are
 * shipped pre-filled with that default in example.env even inside the
 * "wrong" backend's block (e.g. FMC_TIME_RANGE=5m sits in the FMC block
 * regardless of which backend is active) -- so an operator who copies
 * example.env and fills in only their chosen backend's required fields
 * still has every optional variable "set" to its own default. Warning
 * about those defaulted values being present is a false positive against
 * the exact path the documentation recommends; only variables with no
 * default (or a non-default value) are worth flagging as "wrong block".
 */
const FMC_ONLY_DEFAULTED_VARS = new Set<string>([
  'FMC_TLS_INSECURE_SKIP_VERIFY',
  'FMC_MAX_CONCURRENT_REQUESTS',
  'FMC_DISCOVERY_INTERVAL_SECONDS',
  'FMC_METRIC_FAMILIES',
  'FMC_TIME_RANGE',
]);
const SCC_ONLY_DEFAULTED_VARS = new Set<string>([
  'SCC_TIME_RANGE',
  'SCC_INVENTORY_POLL_INTERVAL_SECONDS',
]);

function reportCrossBackendVars(
  env: Readonly<Record<string, string | undefined>>,
  backendType: 'scc' | 'fmc' | undefined,
  warnings: ConfigWarning[],
): void {
  if (backendType === 'scc') {
    for (const name of FMC_ONLY_VARS) {
      if (FMC_ONLY_DEFAULTED_VARS.has(name)) continue;
      if (nonEmpty(env[name]) !== undefined) {
        warnings.push({
          severity: 'warn',
          message:
            `${name} is set but BACKEND_TYPE=scc, so it has no effect. This usually means the ` +
            'wrong block of example.env was edited; FMC_* variables only apply when BACKEND_TYPE=fmc.',
        });
      }
    }
  } else if (backendType === 'fmc') {
    for (const name of SCC_ONLY_VARS) {
      if (SCC_ONLY_DEFAULTED_VARS.has(name)) continue;
      if (nonEmpty(env[name]) !== undefined) {
        warnings.push({
          severity: 'warn',
          message:
            `${name} is set but BACKEND_TYPE=fmc, so it has no effect. This usually means the ` +
            'wrong block of example.env was edited; SCC_* variables only apply when BACKEND_TYPE=scc.',
        });
      }
    }
  }
}

interface IntRange {
  min?: number;
  max?: number;
}

/**
 * Node's `setTimeout`/`setInterval` silently clamp any delay that doesn't
 * fit in a signed 32-bit integer of milliseconds down to 1ms (with a
 * `TimeoutOverflowWarning`) rather than throwing -- so an unbounded
 * "seconds" duration variable can turn into a 1ms poll loop from a single
 * fat-fingered extra digit, which for the SCC backend defeats the entire
 * 2-requests-per-minute floor this module otherwise enforces. Every
 * duration-shaped variable gets this as its default upper bound.
 */
const MAX_TIMER_SECONDS = Math.floor(2147483647 / 1000);

function parseInteger(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

function validatePositiveInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  defaultValue: number,
  errors: string[],
  range?: IntRange,
): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return defaultValue;

  const parsed = parseInteger(raw);
  if (parsed === undefined) {
    errors.push(`${name} must be a positive integer, got "${raw}"`);
    return defaultValue;
  }
  const min = range?.min ?? 1;
  if (parsed < min || (range?.max !== undefined && parsed > range.max)) {
    const bound =
      range?.max !== undefined ? `between ${min} and ${range.max} (inclusive)` : `>= ${min}`;
    errors.push(`${name} must be an integer ${bound}, got ${parsed}`);
    return defaultValue;
  }
  return parsed;
}

function validatePollInterval(
  env: Readonly<Record<string, string | undefined>>,
  backendType: 'scc' | 'fmc' | undefined,
  errors: string[],
): number {
  const raw = nonEmpty(env.POLL_INTERVAL_SECONDS);
  if (raw === undefined) return 60;

  const parsed = parseInteger(raw);
  if (parsed === undefined) {
    errors.push(`POLL_INTERVAL_SECONDS must be a positive integer, got "${raw}"`);
    return 60;
  }
  if (parsed <= 0) {
    errors.push(`POLL_INTERVAL_SECONDS must be a positive integer (>= 1), got ${parsed}`);
    return 60;
  }
  if (parsed > MAX_TIMER_SECONDS) {
    errors.push(
      `POLL_INTERVAL_SECONDS must be <= ${MAX_TIMER_SECONDS} (Node's timer API cannot represent a ` +
        `longer delay and silently clamps to 1ms instead of erroring), got ${parsed}`,
    );
    return 60;
  }
  if (backendType === 'scc' && parsed < 30) {
    errors.push(
      `POLL_INTERVAL_SECONDS must be >= 30 on the SCC backend (DESIGN.md §3.2.4 — the ` +
        `upstream endpoint's hard 2 requests/minute limit), got ${parsed}`,
    );
    return 60;
  }
  return parsed;
}

function validateEnum<T extends string>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  allowed: readonly T[],
  defaultValue: T,
  errors: string[],
): T {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return defaultValue;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  errors.push(`${name} must be one of: ${allowed.join(', ')}. Got "${raw}"`);
  return defaultValue;
}

function validateBoolean(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  defaultValue: boolean,
  errors: string[],
): boolean {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return defaultValue;
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  errors.push(`${name} must be "true" or "false", got "${raw}"`);
  return defaultValue;
}

function checkReadablePath(path: string, name: string, errors: string[]): void {
  try {
    accessSync(path, fsConstants.R_OK);
    if (!statSync(path).isFile()) {
      errors.push(
        `${name} must point to a file, but "${path}" is not a regular file (e.g. a directory)`,
      );
    }
  } catch {
    errors.push(`${name} must point to a file that exists and is readable, got "${path}"`);
  }
}

function validateTimeRange(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  errors: string[],
): TimeRange {
  return validateEnum(env, name, TIME_RANGE_VALUES, '5m', errors);
}

function validateBackend(
  env: Readonly<Record<string, string | undefined>>,
  backendType: 'scc' | 'fmc' | undefined,
  errors: string[],
  warnings: ConfigWarning[],
): BackendConfig | undefined {
  if (backendType === undefined) {
    return undefined;
  }
  if (backendType === 'scc') {
    return validateSccBackend(env, errors, warnings);
  }
  return validateFmcBackend(env, errors, warnings);
}

function validateSccBackend(
  env: Readonly<Record<string, string | undefined>>,
  errors: string[],
  warnings: ConfigWarning[],
): BackendConfig | undefined {
  const timeRange = validateTimeRange(env, 'SCC_TIME_RANGE', errors);
  const inventoryPollIntervalSeconds = validatePositiveInt(
    env,
    'SCC_INVENTORY_POLL_INTERVAL_SECONDS',
    300,
    errors,
    { min: 1, max: MAX_TIMER_SECONDS },
  );

  const baseUrlRaw = nonEmpty(env.SCC_BASE_URL);
  let baseUrlOk = false;
  let baseUrlNormalized: string | undefined;
  if (baseUrlRaw === undefined) {
    errors.push('SCC_BASE_URL is required when BACKEND_TYPE=scc, but is unset');
  } else {
    let parsed: URL | undefined;
    try {
      // `new URL()` strips leading/trailing whitespace and internal
      // tab/newline characters per the WHATWG URL spec — using
      // `parsed.href` (rather than the untrusted `baseUrlRaw`) as the
      // stored value is what keeps a trailing newline or pasted
      // whitespace out of the request path built by
      // `src/backends/scc/adapter.ts`'s `trimTrailingSlash`, which only
      // strips a literal trailing `/` and has no whitespace awareness of
      // its own.
      parsed = new URL(baseUrlRaw);
    } catch {
      errors.push(`SCC_BASE_URL must be a valid URL, got "${baseUrlRaw}"`);
    }
    if (parsed !== undefined) {
      if (parsed.protocol !== 'https:') {
        errors.push(
          `SCC_BASE_URL must use HTTPS; http: URLs are rejected for all upstream connections ` +
            `(DESIGN.md §9.1). Got "${baseUrlRaw}"`,
        );
      } else {
        baseUrlOk = true;
        baseUrlNormalized = parsed.href;
      }
      if (LEGACY_SCC_HOSTNAME_PATTERN.test(parsed.hostname)) {
        warnings.push({
          severity: 'warn',
          message:
            `SCC_BASE_URL uses the legacy "${parsed.hostname}" hostname. This still works, but is ` +
            'deprecated — Cisco is migrating to the api.<region>.security.cisco.com form ' +
            '(DESIGN.md §3.2.1/§14.12). Consider updating.',
        });
      }
    }
  }

  const apiTokenRaw = nonEmpty(env.SCC_API_TOKEN);
  if (apiTokenRaw === undefined) {
    errors.push('SCC_API_TOKEN is required when BACKEND_TYPE=scc, but is unset');
  }

  const fmcUidRaw = nonEmpty(env.SCC_FMC_UID);
  if (fmcUidRaw === undefined) {
    errors.push('SCC_FMC_UID is required when BACKEND_TYPE=scc, but is unset');
  }

  if (
    !baseUrlOk ||
    baseUrlNormalized === undefined ||
    apiTokenRaw === undefined ||
    fmcUidRaw === undefined
  ) {
    return undefined;
  }

  return {
    kind: 'scc',
    baseUrl: baseUrlNormalized,
    apiToken: new Secret(apiTokenRaw),
    fmcUid: fmcUidRaw,
    timeRange,
    inventoryPollIntervalSeconds,
  };
}

function validateMetricFamilies(
  env: Readonly<Record<string, string | undefined>>,
  errors: string[],
): MetricFamily[] {
  const raw = nonEmpty(env.FMC_METRIC_FAMILIES);
  if (raw === undefined) return [...METRIC_FAMILY_VALUES];

  const families: MetricFamily[] = [];
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    const upper = token.toUpperCase();
    if ((METRIC_FAMILY_VALUES as readonly string[]).includes(upper)) {
      families.push(upper as MetricFamily);
    } else {
      errors.push(
        `FMC_METRIC_FAMILIES contains invalid family "${token}". Valid families: ` +
          `${METRIC_FAMILY_VALUES.join(', ')}`,
      );
    }
  }

  if (families.length === 0 && tokens.length === 0) {
    errors.push(
      `FMC_METRIC_FAMILIES is set to "${raw}", which contains no family names. A device with no ` +
        `enabled metric family would never be polled. Valid families: ${METRIC_FAMILY_VALUES.join(', ')}`,
    );
  }
  return families;
}

function validateFmcBackend(
  env: Readonly<Record<string, string | undefined>>,
  errors: string[],
  warnings: ConfigWarning[],
): BackendConfig | undefined {
  const timeRange = validateTimeRange(env, 'FMC_TIME_RANGE', errors);
  const maxConcurrentRequests = validatePositiveInt(env, 'FMC_MAX_CONCURRENT_REQUESTS', 5, errors, {
    min: 1,
    max: 10,
  });
  const discoveryIntervalSeconds = validatePositiveInt(
    env,
    'FMC_DISCOVERY_INTERVAL_SECONDS',
    900,
    errors,
    { min: 1, max: MAX_TIMER_SECONDS },
  );
  const metricFamilies = validateMetricFamilies(env, errors);

  const hostRaw = nonEmpty(env.FMC_HOST);
  if (hostRaw === undefined) {
    errors.push('FMC_HOST is required when BACKEND_TYPE=fmc, but is unset');
  }
  const usernameRaw = nonEmpty(env.FMC_USERNAME);
  if (usernameRaw === undefined) {
    errors.push('FMC_USERNAME is required when BACKEND_TYPE=fmc, but is unset');
  }
  const passwordRaw = nonEmpty(env.FMC_PASSWORD);
  if (passwordRaw === undefined) {
    errors.push('FMC_PASSWORD is required when BACKEND_TYPE=fmc, but is unset');
  }

  const domainUuid = nonEmpty(env.FMC_DOMAIN_UUID);
  const caBundlePath = nonEmpty(env.FMC_CA_BUNDLE_PATH);
  if (caBundlePath !== undefined) {
    checkReadablePath(caBundlePath, 'FMC_CA_BUNDLE_PATH', errors);
  }

  const tlsInsecureSkipVerify = validateBoolean(env, 'FMC_TLS_INSECURE_SKIP_VERIFY', false, errors);

  if (tlsInsecureSkipVerify && caBundlePath !== undefined) {
    errors.push(
      'FMC_TLS_INSECURE_SKIP_VERIFY=true together with FMC_CA_BUNDLE_PATH set is a configuration ' +
        'error (DESIGN.md §8.5/§9.6): this combination means the operator believes certificate ' +
        'trust is configured while verification is actually disabled — the most dangerous possible ' +
        'misconfiguration. Set FMC_TLS_INSECURE_SKIP_VERIFY=false and rely on FMC_CA_BUNDLE_PATH, or ' +
        'remove FMC_CA_BUNDLE_PATH if the insecure escape hatch is genuinely intended.',
    );
  } else if (tlsInsecureSkipVerify) {
    warnings.push({
      severity: 'error',
      message:
        '===========================================================================\n' +
        'INSECURE: FMC_TLS_INSECURE_SKIP_VERIFY=true — certificate verification for\n' +
        'the FMC backend is DISABLED. FMC credentials and all metrics data are\n' +
        'exposed to undetectable interception (a man-in-the-middle attacker can\n' +
        'read the service-account password and every metric value). This is a\n' +
        'lab/test-only escape hatch and must never be set in production. Prefer\n' +
        'FMC_CA_BUNDLE_PATH (DESIGN.md §9.6).\n' +
        '===========================================================================',
    });
  }

  if (hostRaw === undefined || usernameRaw === undefined || passwordRaw === undefined) {
    return undefined;
  }

  return {
    kind: 'fmc',
    host: hostRaw as string,
    username: usernameRaw as string,
    password: new Secret(passwordRaw as string),
    ...(domainUuid !== undefined ? { domainUuid } : {}),
    ...(caBundlePath !== undefined ? { caBundlePath } : {}),
    tlsInsecureSkipVerify,
    maxConcurrentRequests,
    discoveryIntervalSeconds,
    metricFamilies,
    timeRange,
  };
}

function validateMetricsTls(
  env: Readonly<Record<string, string | undefined>>,
  errors: string[],
): MetricsTlsConfig | undefined {
  const certPath = nonEmpty(env.METRICS_TLS_CERT_PATH);
  const keyPath = nonEmpty(env.METRICS_TLS_KEY_PATH);
  const clientCaPath = nonEmpty(env.METRICS_TLS_CLIENT_CA_PATH);
  const minVersion = validateEnum(
    env,
    'METRICS_TLS_MIN_VERSION',
    TLS_MIN_VERSION_VALUES,
    'TLSv1.2',
    errors,
  ) as TlsMinVersion;

  if (certPath === undefined && keyPath === undefined) {
    if (clientCaPath !== undefined) {
      // Setting only the client CA implies the operator believes mutual TLS
      // is now enabled -- silently accepting it and returning `undefined`
      // (no TLS at all) would downgrade the strongest access control
      // DESIGN.md §9.2 offers for /metrics with no error and no warning.
      // METRICS_TLS_CLIENT_CA_PATH only has an effect once the listener
      // itself is on TLS, so require cert+key alongside it.
      checkReadablePath(clientCaPath, 'METRICS_TLS_CLIENT_CA_PATH', errors);
      errors.push(
        'METRICS_TLS_CLIENT_CA_PATH requires METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH to ' +
          'also be set -- mutual TLS has no effect unless the /metrics listener itself is running ' +
          'with TLS enabled. Set all three, or unset METRICS_TLS_CLIENT_CA_PATH.',
      );
    }
    return undefined;
  }
  if (certPath === undefined || keyPath === undefined) {
    errors.push(
      'METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH must be set together or not at all. Got ' +
        `METRICS_TLS_CERT_PATH="${certPath ?? ''}" and METRICS_TLS_KEY_PATH="${keyPath ?? ''}"`,
    );
    return undefined;
  }

  checkReadablePath(certPath, 'METRICS_TLS_CERT_PATH', errors);
  checkReadablePath(keyPath, 'METRICS_TLS_KEY_PATH', errors);
  if (clientCaPath !== undefined) {
    checkReadablePath(clientCaPath, 'METRICS_TLS_CLIENT_CA_PATH', errors);
  }

  return {
    certPath,
    keyPath,
    minVersion,
    ...(clientCaPath !== undefined ? { clientCaPath } : {}),
  };
}
