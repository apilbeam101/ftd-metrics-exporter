import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatConfigSummary } from '../../src/config/redact-summary.ts';
import { Secret } from '../../src/config/secret.ts';
import type { AppConfig } from '../../src/config/types.ts';

const REALISTIC_SCC_TOKEN =
  'eyJraWQiOiIwIiwidHlwIjoiSldUIiwiYWxnIjoiUlMyNTYifQ.eyJ2ZXIiOiIwIn0.bLcQGFK_UDfJoeklv9wvYM5jVbM4o2sbTqb49-wOw49';
const REALISTIC_FMC_PASSWORD = 'FMC1qaz@WSX';

function sccConfig(): AppConfig {
  return {
    backend: {
      kind: 'scc',
      baseUrl: 'https://api.eu.security.cisco.com/firewall',
      apiToken: new Secret(REALISTIC_SCC_TOKEN),
      fmcUid: '00000000-0000-0000-0000-000000000000',
      timeRange: '5m',
      inventoryPollIntervalSeconds: 300,
    },
    metricsPort: 10049,
    metricsBindAddress: '0.0.0.0',
    pollIntervalSeconds: 60,
    logLevel: 'info',
    logFormat: 'json',
    requestTimeoutSeconds: 30,
    enableDefaultMetrics: true,
  };
}

function fmcConfig(): AppConfig {
  return {
    backend: {
      kind: 'fmc',
      host: 'fmc.example.internal',
      username: 'ftd-exporter-svc',
      password: new Secret(REALISTIC_FMC_PASSWORD),
      tlsInsecureSkipVerify: false,
      maxConcurrentRequests: 5,
      discoveryIntervalSeconds: 900,
      metricFamilies: ['CPU', 'MEM'],
      timeRange: '5m',
    },
    metricsPort: 10049,
    metricsBindAddress: '0.0.0.0',
    pollIntervalSeconds: 60,
    logLevel: 'info',
    logFormat: 'json',
    requestTimeoutSeconds: 30,
    enableDefaultMetrics: true,
  };
}

// 19. Redaction of the summary.
test('redaction: SCC summary does not contain the SCC_API_TOKEN value', () => {
  const summary = formatConfigSummary(sccConfig());
  assert.ok(!summary.includes(REALISTIC_SCC_TOKEN));
  assert.ok(summary.includes('[REDACTED]'));
  assert.ok(summary.includes('SCC_API_TOKEN'));
});

test('redaction: FMC summary does not contain the FMC_PASSWORD value', () => {
  const summary = formatConfigSummary(fmcConfig());
  assert.ok(!summary.includes(REALISTIC_FMC_PASSWORD));
  assert.ok(summary.includes('[REDACTED]'));
  assert.ok(summary.includes('FMC_PASSWORD'));
});

test('redaction: non-secret fields are visible in the summary (it is not entirely blanked)', () => {
  const summary = formatConfigSummary(sccConfig());
  assert.ok(summary.includes('https://api.eu.security.cisco.com/firewall'));
  assert.ok(summary.includes('00000000-0000-0000-0000-000000000000'));
  assert.ok(summary.includes('10049'));
});

test('Secret.toString() and toJSON() never expose the raw value', () => {
  const secret = new Secret(REALISTIC_SCC_TOKEN);
  assert.equal(String(secret), '[REDACTED]');
  assert.equal(JSON.stringify({ token: secret }), '{"token":"[REDACTED]"}');
  assert.equal(`${secret}`, '[REDACTED]');
  assert.equal(secret.reveal(), REALISTIC_SCC_TOKEN);
});

test('Secret value does not leak via accidental template-string interpolation', () => {
  const secret = new Secret(REALISTIC_FMC_PASSWORD);
  const accidental = `password is ${secret}`;
  assert.ok(!accidental.includes(REALISTIC_FMC_PASSWORD));
});
