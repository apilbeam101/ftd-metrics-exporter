import type { Secret } from './secret.ts';

/**
 * Discriminated union on `kind` (DESIGN.md §2.3, plan Stage 4 scope): once a
 * caller has checked `config.backend.kind === 'fmc'`, every FMC-only field
 * (host, username, password, ...) is statically non-optional — "required
 * for the selected backend" becomes a compile-time property of the adapter
 * code, not a runtime hope.
 */
export type BackendType = 'scc' | 'fmc';

export type TimeRange = '5m' | '15m' | '30m' | '1h';
export const TIME_RANGE_VALUES: readonly TimeRange[] = ['5m', '15m', '30m', '1h'];

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export const LOG_LEVEL_VALUES: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

export type LogFormat = 'json' | 'text';
export const LOG_FORMAT_VALUES: readonly LogFormat[] = ['json', 'text'];

/** DESIGN.md §8.3 — comma-separated subset of these five families. */
export type MetricFamily = 'CPU' | 'MEM' | 'INTERFACE' | 'DISK_STATS' | 'CHASSIS_STATS';
export const METRIC_FAMILY_VALUES: readonly MetricFamily[] = [
  'CPU',
  'MEM',
  'INTERFACE',
  'DISK_STATS',
  'CHASSIS_STATS',
];

export type TlsMinVersion = 'TLSv1.2' | 'TLSv1.3';
export const TLS_MIN_VERSION_VALUES: readonly TlsMinVersion[] = ['TLSv1.2', 'TLSv1.3'];

export interface SccBackendConfig {
  kind: 'scc';
  /** Opaque prefix (DESIGN.md §3.2.1) — never parsed or reconstructed, only appended to. */
  baseUrl: string;
  apiToken: Secret;
  fmcUid: string;
  timeRange: TimeRange;
  /** DESIGN.md §4.6.1: device-inventory poll cadence, independent of the health-metrics poll. */
  inventoryPollIntervalSeconds: number;
}

export interface FmcBackendConfig {
  kind: 'fmc';
  host: string;
  username: string;
  password: Secret;
  domainUuid?: string;
  caBundlePath?: string;
  tlsInsecureSkipVerify: boolean;
  maxConcurrentRequests: number;
  discoveryIntervalSeconds: number;
  metricFamilies: MetricFamily[];
  timeRange: TimeRange;
}

export type BackendConfig = SccBackendConfig | FmcBackendConfig;

export interface MetricsTlsConfig {
  certPath: string;
  keyPath: string;
  minVersion: TlsMinVersion;
  clientCaPath?: string;
}

export interface AppConfig {
  backend: BackendConfig;
  metricsPort: number;
  metricsBindAddress: string;
  pollIntervalSeconds: number;
  logLevel: LogLevel;
  logFormat: LogFormat;
  requestTimeoutSeconds: number;
  enableDefaultMetrics: boolean;
  metricsTls?: MetricsTlsConfig;
}
