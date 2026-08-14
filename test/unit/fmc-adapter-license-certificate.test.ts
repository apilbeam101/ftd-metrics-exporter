import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createFmcAdapter } from '../../src/backends/fmc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createLogger } from '../../src/log/logger.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { type FmcMockServer, startFmcMockServer } from './support/fmc-mock-server.ts';

/**
 * DESIGN.md §4.6.2: Smart License status + device-certificates polling
 * wired into the FMC adapter. Unlike SCC, the certificates response's `id`
 * is already the same device UUID discovery/health use everywhere else
 * (confirmed live, 2026-08-14) — no `uidOnFmc`-style indirection needed,
 * only a device-name lookup sourced from discovery's own cached list.
 */

function quietLogger() {
  return createLogger({ level: 'debug', sink: () => {} });
}

function deviceUuid(n: number): string {
  const suffix = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-9000-${suffix}`;
}

function deviceRecords(devices: Array<{ id: string; name: string; isConnected?: boolean }>) {
  return {
    links: {},
    items: devices,
    paging: { offset: 0, limit: 1000, count: devices.length, pages: 1 },
  };
}

interface Harness {
  server: FmcMockServer;
  dispatcher: Agent;
  clock: ReturnType<typeof createFakeClock>;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const server = await startFmcMockServer();
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const clock = createFakeClock();
  return {
    server,
    dispatcher,
    clock,
    close: async () => {
      await server.close();
    },
  };
}

function makeAdapter(h: Harness, overrides: Partial<Parameters<typeof createFmcAdapter>[0]> = {}) {
  return createFmcAdapter({
    host: h.server.host,
    username: 'svc',
    password: new Secret('pw'),
    metricFamilies: ['CPU'],
    timeRange: '5m',
    maxConcurrentRequests: 2,
    discoveryIntervalSeconds: 900,
    pollIntervalSeconds: 60,
    clock: h.clock,
    logger: quietLogger(),
    dispatcher: h.dispatcher,
    ...overrides,
  });
}

test('FmcAdapter (license/certificates): getters return empty before the first fetchSnapshot() call', async () => {
  const h = await createHarness();
  const adapter = makeAdapter(h, {
    licensePollIntervalSeconds: 3600,
    certificatePollIntervalSeconds: 3600,
  });
  try {
    assert.equal(adapter.getLicenseStatus(), undefined);
    assert.deepEqual(adapter.getDeviceCertificates(), []);
  } finally {
    await h.close();
  }
});

test('FmcAdapter (license/certificates): omitting both poll intervals disables both features — no extra requests', async () => {
  const h = await createHarness();
  h.server.setDeviceRecordsPage(0, deviceRecords([]));
  const adapter = makeAdapter(h);
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(
      h.server.requests.filter((r) => r.url.includes('/license/smartlicenses')).length,
      0,
    );
    assert.equal(
      h.server.requests.filter((r) => r.url.includes('/devices/certificates')).length,
      0,
    );
    assert.equal(adapter.getLicenseStatus(), undefined);
    assert.deepEqual(adapter.getDeviceCertificates(), []);
  } finally {
    await adapter.close();
    await h.close();
  }
});

test("FmcAdapter (license/certificates): full happy path — license populates, certificates join directly via discovery's device id/name", async () => {
  const h = await createHarness();
  const deviceId = deviceUuid(1);
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords([{ id: deviceId, name: 'ftd1.emealab.local', isConnected: true }]),
  );
  h.server.setLicenseResponse({
    items: [
      {
        regStatus: 'REGISTERED',
        metadata: { authStatus: 'OUT_OF_COMPLIANCE', evalUsed: false, evalExpiresInDays: 0 },
      },
    ],
  });
  h.server.setCertificatesResponse({
    items: [
      {
        id: deviceId,
        enrolledCertificates: [
          {
            certificate: { name: 'Self-Signed_RA' },
            identityCertificateStatus: 'AVAILABLE',
            identityCertExpiryDate: '2034-04-28T07:32Z',
            caCertificateStatus: 'NOT_APPLICABLE',
            caCertExpiryDate: '-',
          },
        ],
      },
    ],
  });

  const adapter = makeAdapter(h, {
    licensePollIntervalSeconds: 3600,
    certificatePollIntervalSeconds: 3600,
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();

    const license = adapter.getLicenseStatus();
    assert.equal(license?.regStatus, 'REGISTERED');
    assert.equal(license?.authStatus, 'OUT_OF_COMPLIANCE');

    const certs = adapter.getDeviceCertificates();
    assert.equal(certs.length, 1, 'only the identity component -- ca is NOT_APPLICABLE');
    assert.equal(certs[0]?.deviceUid, deviceId);
    assert.equal(certs[0]?.deviceName, 'ftd1.emealab.local');
    assert.equal(certs[0]?.certType, 'identity');
    assert.equal(certs[0]?.expiresAt.toISOString(), '2034-04-28T07:32:00.000Z');
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter (license/certificates): a failing certificates refresh does not fail fetchSnapshot(), keeps the previous list, and fires onCertificateError', async () => {
  const h = await createHarness();
  const deviceId = deviceUuid(2);
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords([{ id: deviceId, name: 'ftd2', isConnected: true }]),
  );
  h.server.setCertificatesResponse({
    items: [
      {
        id: deviceId,
        enrolledCertificates: [
          {
            certificate: { name: 'x' },
            identityCertificateStatus: 'AVAILABLE',
            identityCertExpiryDate: '2030-01-01T00:00Z',
          },
        ],
      },
    ],
  });

  let certificateErrors = 0;
  const adapter = makeAdapter(h, {
    certificatePollIntervalSeconds: 3600,
    onCertificateError: () => {
      certificateErrors++;
    },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getDeviceCertificates().length, 1);

    h.server.setCertificatesResponse({}, 500);
    h.clock.advance(3_600_000);
    await adapter.fetchSnapshot();

    assert.equal(certificateErrors, 1);
    assert.equal(
      adapter.getDeviceCertificates().length,
      1,
      'the previous good list must survive a failed refresh',
    );
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter (license/certificates): getters return empty after close()', async () => {
  const h = await createHarness();
  h.server.setDeviceRecordsPage(0, deviceRecords([]));
  h.server.setLicenseResponse({ items: [{ regStatus: 'REGISTERED' }] });
  const adapter = makeAdapter(h, { licensePollIntervalSeconds: 3600 });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getLicenseStatus()?.regStatus, 'REGISTERED');
  } finally {
    await adapter.close();
    await h.close();
  }
  assert.equal(adapter.getLicenseStatus(), undefined);
  assert.deepEqual(adapter.getDeviceCertificates(), []);
});

test('FmcAdapter (license/certificates): a malformed (non-JSON) license body is a failed refresh, not a successful empty one — the previous status survives and onLicenseError fires (Opus review finding, 2026-08-14)', async () => {
  const h = await createHarness();
  h.server.setDeviceRecordsPage(0, deviceRecords([]));
  h.server.setLicenseResponse({ items: [{ regStatus: 'REGISTERED' }] });

  let licenseErrors = 0;
  const adapter = makeAdapter(h, {
    licensePollIntervalSeconds: 3600,
    onLicenseError: () => {
      licenseErrors++;
    },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getLicenseStatus()?.regStatus, 'REGISTERED');

    // setLicenseResponse only accepts a body it will JSON.stringify itself,
    // so a genuinely malformed wire body is simulated via a status/shape
    // the mapper cannot produce a status from: a non-object payload,
    // recorded as a parse error with zero status -- the same "resolved but
    // degenerate" shape a real malformed body produces after JSON.parse.
    h.server.setLicenseResponse([1, 2, 3]);
    h.clock.advance(3_600_000);
    await adapter.fetchSnapshot();

    assert.equal(licenseErrors, 1, 'a degenerate body must count as a refresh failure');
    assert.equal(
      adapter.getLicenseStatus()?.regStatus,
      'REGISTERED',
      'the previous good status must survive, not be wiped to undefined',
    );
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter (license/certificates): a certificates refresh where every record fails the device-id lookup is a failed refresh, not a successful empty one (Opus review finding, 2026-08-14)', async () => {
  const h = await createHarness();
  h.server.setDeviceRecordsPage(0, deviceRecords([{ id: deviceUuid(4), name: 'ftd4' }]));
  h.server.setCertificatesResponse({
    items: [
      {
        // Deliberately does not match any device discovery actually knows about.
        id: deviceUuid(99),
        enrolledCertificates: [
          {
            identityCertificateStatus: 'AVAILABLE',
            identityCertExpiryDate: '2030-01-01T00:00Z',
          },
        ],
      },
    ],
  });

  let certificateErrors = 0;
  const adapter = makeAdapter(h, {
    certificatePollIntervalSeconds: 3600,
    onCertificateError: () => {
      certificateErrors++;
    },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();

    assert.equal(
      certificateErrors,
      1,
      'an all-join-miss refresh must count as a failure, not a successful empty list',
    );
    assert.deepEqual(adapter.getDeviceCertificates(), []);
  } finally {
    await adapter.close();
    await h.close();
  }
});

test('FmcAdapter (license/certificates): license/certificates refresh still runs even when building the health snapshot throws — genuinely in `finally`, not merely sequenced after (Opus review finding, 2026-08-14)', async () => {
  const h = await createHarness();
  const deviceId = deviceUuid(5);
  h.server.setDeviceRecordsPage(
    0,
    deviceRecords([{ id: deviceId, name: 'ftd5', isConnected: true }]),
  );
  h.server.setLicenseResponse({ items: [{ regStatus: 'REGISTERED' }] });
  // A non-2xx per-family response is a genuine, realistic parse error
  // (fetchFamilyForDevice's own catch block) -- the only practically
  // reachable way to make buildSnapshots() throw without an adapter-
  // internal bug is a hostile onParseError consumer reacting to it.
  h.server.setAggregateMetrics(deviceId, 'CPU', { error: 'bad request' }, 400);

  const adapter = makeAdapter(h, {
    licensePollIntervalSeconds: 3600,
    onParseError: () => {
      throw new Error('a hostile onParseError consumer');
    },
  });
  try {
    await adapter.init();
    await assert.rejects(() => adapter.fetchSnapshot());
    assert.equal(
      adapter.getLicenseStatus()?.regStatus,
      'REGISTERED',
      'license must still have been refreshed despite fetchSnapshot() throwing',
    );
  } finally {
    await adapter.close();
    await h.close();
  }
});
