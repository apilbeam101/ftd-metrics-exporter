import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validate } from '../../src/config/validate.ts';

function parseExampleEnv(): Record<string, string> {
  const exampleEnvPath = fileURLToPath(new URL('../../example.env', import.meta.url));
  const lines = readFileSync(exampleEnvPath, 'utf8').split('\n');
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

function makeTempFile(name: string, contents = 'placeholder'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftd-config-test-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

function sccEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    BACKEND_TYPE: 'scc',
    SCC_BASE_URL: 'https://api.eu.security.cisco.com/firewall',
    SCC_API_TOKEN: 'a-realistic-looking-token-value-1234567890',
    SCC_FMC_UID: '00000000-0000-0000-0000-000000000000',
    ...overrides,
  };
}

function fmcEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    BACKEND_TYPE: 'fmc',
    FMC_HOST: 'fmc.example.internal',
    FMC_USERNAME: 'ftd-exporter-svc',
    FMC_PASSWORD: 'a-realistic-looking-password-Sup3rSecret!',
    ...overrides,
  };
}

// 1. Missing BACKEND_TYPE
test('missing BACKEND_TYPE -> non-zero-worthy error naming the variable', () => {
  const result = validate({});
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('BACKEND_TYPE')));
});

// 2. Wrong case rejected
test('BACKEND_TYPE=SCC (wrong case) is rejected, not normalized', () => {
  const result = validate(sccEnv({ BACKEND_TYPE: 'SCC' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('BACKEND_TYPE') && e.includes('SCC')));
});

// 3. scc with SCC_API_TOKEN missing
test('BACKEND_TYPE=scc with SCC_API_TOKEN missing -> error naming SCC_API_TOKEN', () => {
  const env = sccEnv();
  delete env.SCC_API_TOKEN;
  const result = validate(env);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('SCC_API_TOKEN')));
});

// 4. scc with FMC_HOST also set -> warning, still starts
test('BACKEND_TYPE=scc with FMC_HOST also set -> warning, still starts', () => {
  const result = validate(sccEnv({ FMC_HOST: 'some-fmc.example.internal' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.warnings.some((w) => w.message.includes('FMC_HOST')));
});

// 5. SCC_BASE_URL=http://... -> error mentioning HTTPS
test('SCC_BASE_URL=http://... -> error mentioning HTTPS is mandatory', () => {
  const result = validate(sccEnv({ SCC_BASE_URL: 'http://api.eu.security.cisco.com/firewall' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('SCC_BASE_URL') && /https/i.test(e)));
});

// 6. SCC_BASE_URL=not-a-url -> error
test('SCC_BASE_URL=not-a-url -> error', () => {
  const result = validate(sccEnv({ SCC_BASE_URL: 'not-a-url' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('SCC_BASE_URL')));
});

// 7. POLL_INTERVAL_SECONDS floor is backend-specific
test('POLL_INTERVAL_SECONDS=15 with BACKEND_TYPE=scc -> error citing the 2-req/min limit', () => {
  const result = validate(sccEnv({ POLL_INTERVAL_SECONDS: '15' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(
    result.errors.some(
      (e) => e.includes('POLL_INTERVAL_SECONDS') && /30/.test(e) && /scc/i.test(e),
    ),
  );
});

test('POLL_INTERVAL_SECONDS=15 with BACKEND_TYPE=fmc -> accepted (floor is backend-specific)', () => {
  const result = validate(fmcEnv({ POLL_INTERVAL_SECONDS: '15' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.config.pollIntervalSeconds, 15);
});

// 8. POLL_INTERVAL_SECONDS invalid values
test('POLL_INTERVAL_SECONDS=0 -> error', () => {
  const result = validate(fmcEnv({ POLL_INTERVAL_SECONDS: '0' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('POLL_INTERVAL_SECONDS')));
});

test('POLL_INTERVAL_SECONDS=-5 -> error', () => {
  const result = validate(fmcEnv({ POLL_INTERVAL_SECONDS: '-5' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('POLL_INTERVAL_SECONDS')));
});

test('POLL_INTERVAL_SECONDS=abc -> error', () => {
  const result = validate(fmcEnv({ POLL_INTERVAL_SECONDS: 'abc' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('POLL_INTERVAL_SECONDS')));
});

test('POLL_INTERVAL_SECONDS=60.5 -> error', () => {
  const result = validate(fmcEnv({ POLL_INTERVAL_SECONDS: '60.5' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('POLL_INTERVAL_SECONDS')));
});

// 9. SCC_TIME_RANGE invalid
test('SCC_TIME_RANGE=10m -> error listing the four valid values', () => {
  const result = validate(sccEnv({ SCC_TIME_RANGE: '10m' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  const err = result.errors.find((e) => e.includes('SCC_TIME_RANGE'));
  assert.ok(err);
  assert.ok(err.includes('5m'));
  assert.ok(err.includes('15m'));
  assert.ok(err.includes('30m'));
  assert.ok(err.includes('1h'));
});

// 10. FMC_MAX_CONCURRENT_REQUESTS range
test('FMC_MAX_CONCURRENT_REQUESTS=0 -> error', () => {
  const result = validate(fmcEnv({ FMC_MAX_CONCURRENT_REQUESTS: '0' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_MAX_CONCURRENT_REQUESTS')));
});

test('FMC_MAX_CONCURRENT_REQUESTS=11 -> error', () => {
  const result = validate(fmcEnv({ FMC_MAX_CONCURRENT_REQUESTS: '11' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_MAX_CONCURRENT_REQUESTS')));
});

test('FMC_MAX_CONCURRENT_REQUESTS=10 -> accepted', () => {
  const result = validate(fmcEnv({ FMC_MAX_CONCURRENT_REQUESTS: '10' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.backend.kind === 'fmc');
  if (result.config.backend.kind === 'fmc') {
    assert.equal(result.config.backend.maxConcurrentRequests, 10);
  }
});

// 11. FMC_CA_BUNDLE_PATH nonexistent
test('FMC_CA_BUNDLE_PATH=/nonexistent -> startup error, not a first-poll failure', () => {
  const result = validate(fmcEnv({ FMC_CA_BUNDLE_PATH: '/definitely/does/not/exist/ca.pem' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_CA_BUNDLE_PATH')));
});

// 12. METRICS_TLS_CERT_PATH without KEY_PATH
test('METRICS_TLS_CERT_PATH without METRICS_TLS_KEY_PATH -> error', () => {
  const certPath = makeTempFile('tls.crt');
  const result = validate(sccEnv({ METRICS_TLS_CERT_PATH: certPath }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(
    result.errors.some(
      (e) => e.includes('METRICS_TLS_CERT_PATH') && e.includes('METRICS_TLS_KEY_PATH'),
    ),
  );
});

// 13. The most consequential security rule.
test('security: FMC_TLS_INSECURE_SKIP_VERIFY=true together with FMC_CA_BUNDLE_PATH -> error', () => {
  const caPath = makeTempFile('ca.pem');
  const result = validate(
    fmcEnv({ FMC_TLS_INSECURE_SKIP_VERIFY: 'true', FMC_CA_BUNDLE_PATH: caPath }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(
    result.errors.some(
      (e) => e.includes('FMC_TLS_INSECURE_SKIP_VERIFY') && e.includes('FMC_CA_BUNDLE_PATH'),
    ),
  );
});

// 14. FMC_TLS_INSECURE_SKIP_VERIFY alone -> accepted with loud warning
test('FMC_TLS_INSECURE_SKIP_VERIFY=true alone -> accepted, loud error-severity-worthy warning emitted', () => {
  const result = validate(fmcEnv({ FMC_TLS_INSECURE_SKIP_VERIFY: 'true' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.backend.kind === 'fmc');
  if (result.config.backend.kind === 'fmc') {
    assert.equal(result.config.backend.tlsInsecureSkipVerify, true);
  }
  assert.ok(result.warnings.some((w) => w.message.includes('INSECURE')));
  assert.ok(result.warnings.some((w) => /interception/i.test(w.message)));
  assert.ok(result.warnings.some((w) => w.severity === 'error'));
});

// 15. FMC_METRIC_FAMILIES parsing
test('FMC_METRIC_FAMILIES=CPU,MEM -> parsed to two families', () => {
  const result = validate(fmcEnv({ FMC_METRIC_FAMILIES: 'CPU,MEM' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.backend.kind === 'fmc');
  if (result.config.backend.kind === 'fmc') {
    assert.deepEqual(result.config.backend.metricFamilies, ['CPU', 'MEM']);
  }
});

test('FMC_METRIC_FAMILIES=CPU,BOGUS -> error naming the invalid family', () => {
  const result = validate(fmcEnv({ FMC_METRIC_FAMILIES: 'CPU,BOGUS' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_METRIC_FAMILIES') && e.includes('BOGUS')));
});

test('FMC_METRIC_FAMILIES handles whitespace and casing', () => {
  const result = validate(fmcEnv({ FMC_METRIC_FAMILIES: ' cpu , Mem ,interface ' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.backend.kind === 'fmc');
  if (result.config.backend.kind === 'fmc') {
    assert.deepEqual(result.config.backend.metricFamilies, ['CPU', 'MEM', 'INTERFACE']);
  }
});

// 16. Legacy hostname
test('legacy hostname https://edge.eu.cdo.cisco.com/api/rest -> warning, still starts', () => {
  const result = validate(sccEnv({ SCC_BASE_URL: 'https://edge.eu.cdo.cisco.com/api/rest' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.config.backend.kind, 'scc');
  if (result.config.backend.kind === 'scc') {
    // base URL is an opaque prefix -- preserved verbatim, not rewritten.
    assert.equal(result.config.backend.baseUrl, 'https://edge.eu.cdo.cisco.com/api/rest');
  }
  assert.ok(result.warnings.some((w) => w.message.includes('edge.eu.cdo.cisco.com')));
  assert.ok(result.warnings.some((w) => /deprecated/i.test(w.message)));
});

test('current-form hostname does not trigger the legacy warning', () => {
  const result = validate(sccEnv());
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(!result.warnings.some((w) => /deprecated/i.test(w.message)));
});

// Review F7: SCC_BASE_URL whitespace/newlines must not reach the stored config value.
test('SCC_BASE_URL with a trailing newline is normalized to a well-formed URL with no embedded whitespace', () => {
  const result = validate(
    sccEnv({ SCC_BASE_URL: 'https://api.eu.security.cisco.com/firewall/\n' }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.config.backend.kind, 'scc');
  if (result.config.backend.kind === 'scc') {
    assert.equal(result.config.backend.baseUrl, 'https://api.eu.security.cisco.com/firewall/');
    assert.ok(!/\s/.test(result.config.backend.baseUrl));
    assert.ok(!result.config.backend.baseUrl.slice('https://'.length).includes('//'));
  }
});

test('SCC_BASE_URL with leading/trailing whitespace is normalized, no double-slash or whitespace in the stored value', () => {
  const result = validate(
    sccEnv({ SCC_BASE_URL: '  https://api.eu.security.cisco.com/firewall  ' }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.config.backend.kind, 'scc');
  if (result.config.backend.kind === 'scc') {
    assert.equal(result.config.backend.baseUrl, 'https://api.eu.security.cisco.com/firewall');
    assert.ok(!/\s/.test(result.config.backend.baseUrl));
  }
});

// 18. Defaults
test('defaults: with only required variables set, every default matches DESIGN.md §8', () => {
  const result = validate(sccEnv());
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.config.metricsPort, 10049);
  assert.equal(result.config.metricsBindAddress, '0.0.0.0');
  assert.equal(result.config.pollIntervalSeconds, 60);
  assert.equal(result.config.logLevel, 'info');
  assert.equal(result.config.logFormat, 'json');
  assert.equal(result.config.requestTimeoutSeconds, 30);
  assert.equal(result.config.enableDefaultMetrics, true);
  assert.ok(result.config.backend.kind === 'scc');
  if (result.config.backend.kind === 'scc') {
    assert.equal(result.config.backend.timeRange, '5m');
  }
});

test('defaults: FMC backend defaults match DESIGN.md §8.3', () => {
  const result = validate(fmcEnv());
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.backend.kind === 'fmc');
  if (result.config.backend.kind === 'fmc') {
    assert.equal(result.config.backend.maxConcurrentRequests, 5);
    assert.equal(result.config.backend.discoveryIntervalSeconds, 900);
    assert.equal(result.config.backend.tlsInsecureSkipVerify, false);
    assert.deepEqual(result.config.backend.metricFamilies, [
      'CPU',
      'MEM',
      'INTERFACE',
      'DISK_STATS',
      'CHASSIS_STATS',
    ]);
    assert.equal(result.config.backend.timeRange, '5m');
  }
});

// 20. Multiple simultaneous errors
test('multiple simultaneous errors are all reported, not just the first', () => {
  const result = validate(
    sccEnv({
      SCC_BASE_URL: 'http://not-https.example.com',
      POLL_INTERVAL_SECONDS: '5',
      SCC_TIME_RANGE: 'bogus',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.length >= 3, `expected >= 3 errors, got ${result.errors.length}`);
  assert.ok(result.errors.some((e) => e.includes('SCC_BASE_URL')));
  assert.ok(result.errors.some((e) => e.includes('POLL_INTERVAL_SECONDS')));
  assert.ok(result.errors.some((e) => e.includes('SCC_TIME_RANGE')));
});

// 21. Windows path handling
test('Windows: FMC_CA_BUNDLE_PATH=C:\\...\\ca.pem resolves and reads correctly', () => {
  const caPath = makeTempFile(
    'ca.pem',
    '-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n',
  );
  assert.match(
    caPath,
    /^[A-Za-z]:\\/,
    'temp path should be a Windows-style absolute path in this env',
  );
  const result = validate(fmcEnv({ FMC_CA_BUNDLE_PATH: caPath }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.backend.kind === 'fmc');
  if (result.config.backend.kind === 'fmc') {
    assert.equal(result.config.backend.caBundlePath, caPath);
  }
});

// Additional coverage beyond the plan's numbered list, but exercising rules
// explicitly called out in DESIGN.md §8.5 / the plan's scope bullets.

test('BACKEND_TYPE=fmc with SCC_API_TOKEN also set -> warning, still starts', () => {
  const result = validate(fmcEnv({ SCC_API_TOKEN: 'some-scc-token-value' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.warnings.some((w) => w.message.includes('SCC_API_TOKEN')));
});

test('METRICS_TLS_KEY_PATH without METRICS_TLS_CERT_PATH -> error', () => {
  const keyPath = makeTempFile('tls.key');
  const result = validate(sccEnv({ METRICS_TLS_KEY_PATH: keyPath }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(
    result.errors.some(
      (e) => e.includes('METRICS_TLS_CERT_PATH') && e.includes('METRICS_TLS_KEY_PATH'),
    ),
  );
});

test('METRICS_TLS_CERT_PATH and METRICS_TLS_KEY_PATH set together and readable -> accepted', () => {
  const certPath = makeTempFile('tls.crt');
  const keyPath = makeTempFile('tls.key');
  const result = validate(
    sccEnv({ METRICS_TLS_CERT_PATH: certPath, METRICS_TLS_KEY_PATH: keyPath }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.metricsTls !== undefined);
  assert.equal(result.config.metricsTls?.certPath, certPath);
  assert.equal(result.config.metricsTls?.keyPath, keyPath);
  assert.equal(result.config.metricsTls?.minVersion, 'TLSv1.2');
});

test('METRICS_TLS_MIN_VERSION must be TLSv1.2 or TLSv1.3 only', () => {
  const certPath = makeTempFile('tls.crt');
  const keyPath = makeTempFile('tls.key');
  const result = validate(
    sccEnv({
      METRICS_TLS_CERT_PATH: certPath,
      METRICS_TLS_KEY_PATH: keyPath,
      METRICS_TLS_MIN_VERSION: 'TLSv1.0',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('METRICS_TLS_MIN_VERSION')));
});

test('METRICS_TLS_CLIENT_CA_PATH unreadable -> error even without cert/key set', () => {
  const result = validate(sccEnv({ METRICS_TLS_CLIENT_CA_PATH: '/no/such/client-ca.pem' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('METRICS_TLS_CLIENT_CA_PATH')));
});

test('LOG_LEVEL and LOG_FORMAT invalid values are rejected with valid options listed', () => {
  const result = validate(sccEnv({ LOG_LEVEL: 'verbose', LOG_FORMAT: 'xml' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('LOG_LEVEL') && e.includes('debug')));
  assert.ok(result.errors.some((e) => e.includes('LOG_FORMAT') && e.includes('text')));
});

test('ENABLE_DEFAULT_METRICS accepts only true/false', () => {
  const result = validate(sccEnv({ ENABLE_DEFAULT_METRICS: 'yes' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('ENABLE_DEFAULT_METRICS')));
});

test('ENABLE_DEFAULT_METRICS=false is honored', () => {
  const result = validate(sccEnv({ ENABLE_DEFAULT_METRICS: 'false' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.config.enableDefaultMetrics, false);
});

test('SCC_TIME_RANGE reaches the returned config verbatim for each valid value', () => {
  for (const value of ['5m', '15m', '30m', '1h']) {
    const result = validate(sccEnv({ SCC_TIME_RANGE: value }));
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.ok(result.config.backend.kind === 'scc');
    if (result.config.backend.kind === 'scc') {
      assert.equal(result.config.backend.timeRange, value);
    }
  }
});

// --- Regression tests from the Stage 4 adversarial review ---

// A1: unbounded durations become a 1ms Node timer, defeating the SCC floor.
test('regression (A1): POLL_INTERVAL_SECONDS beyond Node timer range is rejected, not silently clamped downstream', () => {
  const result = validate(fmcEnv({ POLL_INTERVAL_SECONDS: '9007199254740993' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('POLL_INTERVAL_SECONDS')));
});

test('regression (A1): POLL_INTERVAL_SECONDS=2147484 (just above the Node timer ceiling) is rejected', () => {
  const result = validate(fmcEnv({ POLL_INTERVAL_SECONDS: '2147484' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('POLL_INTERVAL_SECONDS')));
});

test('regression (A1): REQUEST_TIMEOUT_SECONDS and FMC_DISCOVERY_INTERVAL_SECONDS are also bounded', () => {
  const result = validate(
    fmcEnv({
      REQUEST_TIMEOUT_SECONDS: '99999999999999999999',
      FMC_DISCOVERY_INTERVAL_SECONDS: '1e20',
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('REQUEST_TIMEOUT_SECONDS')));
  assert.ok(result.errors.some((e) => e.includes('FMC_DISCOVERY_INTERVAL_SECONDS')));
});

// A2: example.env's own defaulted values must not trigger the "wrong block" warning.
test('regression (A2): example.env, filled in for SCC only, produces zero cross-backend warnings', () => {
  const env = parseExampleEnv();
  env.BACKEND_TYPE = 'scc';
  env.SCC_BASE_URL = 'https://api.eu.security.cisco.com/firewall';
  env.SCC_API_TOKEN = 'placeholder-token';
  env.SCC_FMC_UID = '00000000-0000-0000-0000-000000000000';

  const result = validate(env);
  assert.equal(result.ok, true);
  assert.ok(result.ok, result.ok ? '' : JSON.stringify((result as { errors: string[] }).errors));
  assert.deepEqual(result.warnings, []);
});

test('regression (A2): example.env, filled in for FMC only, produces zero cross-backend warnings', () => {
  const env = parseExampleEnv();
  env.BACKEND_TYPE = 'fmc';
  env.FMC_HOST = 'fmc.example.internal';
  env.FMC_USERNAME = 'ftd-exporter-svc';
  env.FMC_PASSWORD = 'placeholder-password';

  const result = validate(env);
  assert.equal(result.ok, true);
  assert.ok(result.ok, result.ok ? '' : JSON.stringify((result as { errors: string[] }).errors));
  assert.deepEqual(result.warnings, []);
});

// A3: METRICS_TLS_CLIENT_CA_PATH set alone must not silently disable mTLS.
test('regression (A3): METRICS_TLS_CLIENT_CA_PATH set without cert/key is an error, not a silent no-op', () => {
  const clientCaPath = makeTempFile('client-ca.pem');
  const result = validate(sccEnv({ METRICS_TLS_CLIENT_CA_PATH: clientCaPath }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(
    result.errors.some(
      (e) =>
        e.includes('METRICS_TLS_CLIENT_CA_PATH') &&
        e.includes('METRICS_TLS_CERT_PATH') &&
        e.includes('METRICS_TLS_KEY_PATH'),
    ),
  );
});

// A4: every path check must reject a directory, not just a missing/unreadable path.
test('regression (A4): FMC_CA_BUNDLE_PATH pointing at a directory is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftd-config-dir-check-'));
  const result = validate(fmcEnv({ FMC_CA_BUNDLE_PATH: dir }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_CA_BUNDLE_PATH')));
});

test('regression (A4): METRICS_TLS_CERT_PATH/KEY_PATH pointing at directories are rejected', () => {
  const certDir = mkdtempSync(join(tmpdir(), 'ftd-config-cert-dir-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'ftd-config-key-dir-'));
  const result = validate(sccEnv({ METRICS_TLS_CERT_PATH: certDir, METRICS_TLS_KEY_PATH: keyDir }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('METRICS_TLS_CERT_PATH')));
  assert.ok(result.errors.some((e) => e.includes('METRICS_TLS_KEY_PATH')));
});

// A5: FMC_METRIC_FAMILIES resolving to an empty set must be an error.
test('regression (A5): FMC_METRIC_FAMILIES="," (all-empty tokens) is an error, not an empty poll set', () => {
  const result = validate(fmcEnv({ FMC_METRIC_FAMILIES: ',' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_METRIC_FAMILIES')));
});

test('regression (A5+A6): FMC_METRIC_FAMILIES="   " (whitespace only) is treated as unset, defaulting to all five families', () => {
  // Per the A6 fix, a whitespace-only value is indistinguishable from an
  // unset variable (nonEmpty trims before testing), so this falls back to
  // the documented default rather than producing an empty-set error --
  // consistent behavior with every other required/optional string field.
  const result = validate(fmcEnv({ FMC_METRIC_FAMILIES: '   ' }));
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.ok(result.config.backend.kind === 'fmc');
  if (result.config.backend.kind === 'fmc') {
    assert.deepEqual(result.config.backend.metricFamilies, [
      'CPU',
      'MEM',
      'INTERFACE',
      'DISK_STATS',
      'CHASSIS_STATS',
    ]);
  }
});

// A6: whitespace-only required strings must not pass the presence check.
test('regression (A6): FMC_HOST consisting only of whitespace is treated as unset', () => {
  const result = validate(fmcEnv({ FMC_HOST: '   ' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_HOST')));
});

test('regression (A6): FMC_USERNAME and FMC_PASSWORD consisting only of whitespace are treated as unset', () => {
  const result = validate(fmcEnv({ FMC_USERNAME: '  ', FMC_PASSWORD: ' ' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('FMC_USERNAME')));
  assert.ok(result.errors.some((e) => e.includes('FMC_PASSWORD')));
});

// A7 is covered in test/unit/config-deep-freeze.test.ts.

// B1: the insecure-TLS warning must carry structured severity, not just text.
test('regression (B1): warnings carry a structured severity, and cross-backend hints are "warn" not "error"', () => {
  const insecure = validate(fmcEnv({ FMC_TLS_INSECURE_SKIP_VERIFY: 'true' }));
  assert.ok(insecure.ok);
  assert.ok(insecure.ok && insecure.warnings.every((w) => w.severity === 'error'));

  const crossBackend = validate(sccEnv({ FMC_HOST: 'some-fmc.example.internal' }));
  assert.ok(crossBackend.ok);
  assert.ok(crossBackend.ok && crossBackend.warnings.every((w) => w.severity === 'warn'));
});
