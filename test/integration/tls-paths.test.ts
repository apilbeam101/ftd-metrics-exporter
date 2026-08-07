import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFmcAdapter } from '../../src/backends/fmc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { startFmcMockServer } from '../unit/support/fmc-mock-server.ts';
import { createTestApp, createTestMetrics } from './support/harness.ts';

/**
 * DESIGN.md §12.2 testing step 10, at process level, against the real FMC
 * adapter's `caBundlePath`/`tlsInsecureSkipVerify` options (not
 * `createAgent` directly, which `http-agent.test.ts` already covers): a CA
 * bundle enables success, its absence causes verification failure, and the
 * insecure flag bypasses verification entirely.
 */

function writeTemp(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftd-metrics-tls-paths-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

function cpuOnlyDevice(id: string) {
  return {
    links: {},
    items: [{ id, name: 'ftd1', isConnected: true }],
    paging: { offset: 0, limit: 1000, count: 1, pages: 1 },
  };
}

async function buildBackend(
  host: string,
  overrides: { caBundlePath?: string; tlsInsecureSkipVerify?: boolean },
) {
  return createFmcAdapter({
    host,
    username: 'svc',
    password: new Secret('a-realistic-looking-password'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 5,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: createRealClock(),
    logger: createLogger({ level: 'error', sink: () => {} }),
    tlsInsecureSkipVerify: overrides.tlsInsecureSkipVerify ?? false,
    ...(overrides.caBundlePath !== undefined && { caBundlePath: overrides.caBundlePath }),
  });
}

test('TLS: a matching CA bundle enables a successful full poll cycle against a self-signed FMC mock', async () => {
  const h = await startFmcMockServer();
  const id = '00000000-0000-4000-9000-000000000001';
  h.setDeviceRecordsPage(0, cpuOnlyDevice(id));
  const caPath = writeTemp('fmc-ca.pem', h.cert);

  const metrics = createTestMetrics(createRealClock());
  const backend = await buildBackend(h.host, { caBundlePath: caPath });
  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 60 });
  try {
    await app.waitForCycles(1);
    assert.equal(app.results[0]?.outcome, 'success');
  } finally {
    await app.stop();
    await h.close();
  }
});

test('TLS: no CA bundle and verification on -> init() rejects with a certificate-trust failure', async () => {
  const h = await startFmcMockServer();
  const backend = await buildBackend(h.host, {});
  try {
    // A bare assert.rejects() would also pass for an unrelated init()
    // failure (login, domain resolution, discovery) — matching the
    // rejection message against Node's own certificate-verification
    // wording is what actually distinguishes "TLS trust failed" from any
    // other reason init() could reject.
    await assert.rejects(
      backend.init(),
      /self[- ]signed certificate|unable to verify|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED_CERT/i,
    );
  } finally {
    await backend.close();
    await h.close();
  }
});

test('TLS: FMC_TLS_INSECURE_SKIP_VERIFY=true bypasses verification with no CA bundle and completes a poll cycle', async () => {
  const h = await startFmcMockServer();
  const id = '00000000-0000-4000-9000-000000000001';
  h.setDeviceRecordsPage(0, cpuOnlyDevice(id));

  const metrics = createTestMetrics(createRealClock());
  const backend = await buildBackend(h.host, { tlsInsecureSkipVerify: true });
  const app = await createTestApp({ backend, metrics, pollIntervalSeconds: 60 });
  try {
    await app.waitForCycles(1);
    assert.equal(app.results[0]?.outcome, 'success');
  } finally {
    await app.stop();
    await h.close();
  }
});
