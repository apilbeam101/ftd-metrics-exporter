import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Agent } from 'undici';
import { createSccAdapter } from '../../src/backends/scc/adapter.ts';
import { Secret } from '../../src/config/secret.ts';
import { createRealClock } from '../../src/http/clock.ts';
import { createLogger } from '../../src/log/logger.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { startTestHttpServer } from './support/http-server.ts';

/**
 * DESIGN.md §4.6.2: Smart License status + device-certificates polling
 * wired into the SCC adapter. Live-verified (2026-08-14) endpoint paths and
 * quirks: license/certificates are reached through the `cdfmc` proxy, and
 * the certificates response's `id` is `uidOnFmc` (an inventory field), not
 * `uid`/`deviceUid` — so a full happy-path test needs inventory populated
 * first for the join to resolve at all.
 */

const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-scc-token.signature';
const DOMAIN_UUID = 'e276abec-e0f2-11e3-8169-6d9ed49b625f';

function quietLogger() {
  return createLogger({ level: 'debug', sink: () => {} });
}

function jsonOk(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface Routes {
  health?: (req: IncomingMessage, res: ServerResponse) => void;
  inventory?: (req: IncomingMessage, res: ServerResponse) => void;
  license?: (req: IncomingMessage, res: ServerResponse) => void;
  domainInfo?: (req: IncomingMessage, res: ServerResponse) => void;
  certificates?: (req: IncomingMessage, res: ServerResponse) => void;
}

function routedHandler(routes: Routes): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/v1/inventory/devices')) {
      (routes.inventory ?? ((_r, s) => jsonOk(s, { items: [] })))(req, res);
    } else if (url.startsWith('/v1/cdfmc/api/fmc_platform/v1/license/smartlicenses')) {
      (routes.license ?? ((_r, s) => jsonOk(s, { items: [] })))(req, res);
    } else if (url.startsWith('/v1/cdfmc/api/fmc_platform/v1/info/domain')) {
      (
        routes.domainInfo ??
        ((_r, s) => jsonOk(s, { items: [{ uuid: DOMAIN_UUID, name: 'Global' }] }))
      )(req, res);
    } else if (url.startsWith('/v1/cdfmc/api/fmc_config/v1/domain')) {
      (routes.certificates ?? ((_r, s) => jsonOk(s, { items: [] })))(req, res);
    } else {
      (routes.health ?? ((_r, s) => jsonOk(s, [])))(req, res);
    }
  };
}

function makeAdapter(
  server: { port: number },
  overrides: Partial<Parameters<typeof createSccAdapter>[0]> = {},
) {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  return createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    ...overrides,
  });
}

test('SCC adapter (license/certificates): getters return empty before the first fetchSnapshot() call', async () => {
  const adapter = createSccAdapter({
    baseUrl: 'https://example.invalid',
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createFakeClock(),
    logger: quietLogger(),
    licensePollIntervalSeconds: 3600,
    certificatePollIntervalSeconds: 3600,
  });
  assert.equal(adapter.getLicenseStatus(), undefined);
  assert.deepEqual(adapter.getDeviceCertificates(), []);
});

test('SCC adapter (license/certificates): omitting both poll intervals disables both features entirely — no extra requests', async () => {
  const server = await startTestHttpServer(routedHandler({}));
  const adapter = makeAdapter(server);
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(server.requests.length, 1, 'expected only the health/metrics request');
    assert.equal(adapter.getLicenseStatus(), undefined);
    assert.deepEqual(adapter.getDeviceCertificates(), []);
  } finally {
    await adapter.close();
    await server.close();
  }
});

test("SCC adapter (license/certificates): full happy path — license populates, and certificates join via inventory's uidOnFmc", async () => {
  const server = await startTestHttpServer(
    routedHandler({
      inventory: (_req, res) =>
        jsonOk(res, {
          items: [
            {
              name: 'ftd-01',
              uid: 'health-uid-1',
              deviceType: 'CDFMC_MANAGED_FTD',
              uidOnFmc: 'fmc-record-uuid-1',
            },
          ],
        }),
      license: (_req, res) =>
        jsonOk(res, {
          items: [
            {
              regStatus: 'REGISTERED',
              metadata: { authStatus: 'AUTHORIZED', evalUsed: false, evalExpiresInDays: 0 },
            },
          ],
        }),
      certificates: (_req, res) =>
        jsonOk(res, {
          items: [
            {
              id: 'fmc-record-uuid-1',
              enrolledCertificates: [
                {
                  certificate: { name: 'self-signed' },
                  identityCertificateStatus: 'AVAILABLE',
                  identityCertExpiryDate: '2034-07-16T14:23Z',
                  caCertificateStatus: 'NOT_APPLICABLE',
                  caCertExpiryDate: '-',
                },
              ],
            },
          ],
        }),
    }),
  );
  const adapter = makeAdapter(server, {
    inventoryPollIntervalSeconds: 300,
    licensePollIntervalSeconds: 3600,
    certificatePollIntervalSeconds: 3600,
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();

    const license = adapter.getLicenseStatus();
    assert.equal(license?.regStatus, 'REGISTERED');
    assert.equal(license?.authStatus, 'AUTHORIZED');

    const certs = adapter.getDeviceCertificates();
    assert.equal(certs.length, 1, 'only the identity component -- ca is NOT_APPLICABLE');
    assert.equal(
      certs[0]?.deviceUid,
      'health-uid-1',
      'joined via uidOnFmc, not the wire id itself',
    );
    assert.equal(certs[0]?.deviceName, 'ftd-01');
    assert.equal(certs[0]?.certType, 'identity');

    const domainInfoRequest = server.requests.find((r) =>
      r.url.startsWith('/v1/cdfmc/api/fmc_platform/v1/info/domain'),
    );
    assert.ok(domainInfoRequest, 'expected the one-time domain-UUID resolution request');
    const certsRequest = server.requests.find((r) =>
      r.url.startsWith(`/v1/cdfmc/api/fmc_config/v1/domain/${DOMAIN_UUID}/devices/certificates`),
    );
    assert.ok(certsRequest, 'expected the certificates request to use the resolved domain UUID');
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (license/certificates): a domain-info resolution failure disables certificates only — license still works', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      domainInfo: (_req, res) => {
        res.writeHead(500);
        res.end();
      },
      license: (_req, res) => jsonOk(res, { items: [{ regStatus: 'REGISTERED' }] }),
    }),
  );
  const adapter = makeAdapter(server, {
    licensePollIntervalSeconds: 3600,
    certificatePollIntervalSeconds: 3600,
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getLicenseStatus()?.regStatus, 'REGISTERED');
    assert.deepEqual(adapter.getDeviceCertificates(), []);
    const certsRequests = server.requests.filter((r) => r.url.includes('/devices/certificates'));
    assert.equal(certsRequests.length, 0, 'no certificates request should be attempted at all');
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (license/certificates): a failing license refresh does not fail fetchSnapshot(), keeps the previous value, and fires onLicenseError', async () => {
  let licenseShouldFail = false;
  const server = await startTestHttpServer(
    routedHandler({
      license: (_req, res) => {
        if (licenseShouldFail) {
          res.writeHead(500);
          res.end();
          return;
        }
        jsonOk(res, { items: [{ regStatus: 'REGISTERED' }] });
      },
    }),
  );
  let licenseErrors = 0;
  const clock = createFakeClock();
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock,
    logger: quietLogger(),
    minSpacingMs: 0,
    dispatcher,
    licensePollIntervalSeconds: 3600,
    onLicenseError: () => {
      licenseErrors++;
    },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getLicenseStatus()?.regStatus, 'REGISTERED');

    licenseShouldFail = true;
    clock.advance(3_600_000);
    await adapter.fetchSnapshot();
    assert.equal(licenseErrors, 1);
    assert.equal(
      adapter.getLicenseStatus()?.regStatus,
      'REGISTERED',
      'the previous good status must survive a failed refresh',
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (license/certificates): getters return empty after close()', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      license: (_req, res) => jsonOk(res, { items: [{ regStatus: 'REGISTERED' }] }),
    }),
  );
  const adapter = makeAdapter(server, { licensePollIntervalSeconds: 3600 });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getLicenseStatus()?.regStatus, 'REGISTERED');
  } finally {
    await adapter.close();
    await server.close();
  }
  assert.equal(adapter.getLicenseStatus(), undefined);
  assert.deepEqual(adapter.getDeviceCertificates(), []);
});

test('SCC adapter (license/certificates): a malformed (non-JSON) license body is a failed refresh, not a successful empty one — the previous status survives and onLicenseError fires (Opus review finding, 2026-08-14)', async () => {
  let licenseBody = '{"items":[{"regStatus":"REGISTERED"}]}';
  const server = await startTestHttpServer(
    routedHandler({
      license: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(licenseBody);
      },
    }),
  );
  let licenseErrors = 0;
  const clock = createFakeClock();
  const adapter = makeAdapter(server, {
    licensePollIntervalSeconds: 3600,
    clock,
    onLicenseError: () => {
      licenseErrors++;
    },
  });
  try {
    await adapter.init();
    await adapter.fetchSnapshot();
    assert.equal(adapter.getLicenseStatus()?.regStatus, 'REGISTERED');

    licenseBody = '{ this is not valid json';
    clock.advance(3_600_000);
    await adapter.fetchSnapshot();

    assert.equal(licenseErrors, 1, 'a malformed body must count as a refresh failure');
    assert.equal(
      adapter.getLicenseStatus()?.regStatus,
      'REGISTERED',
      'the previous good status must survive a malformed refresh, not be wiped to undefined',
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (license/certificates): a certificates refresh where every record fails the uidOnFmc join is a failed refresh, not a successful empty one (Opus review finding, 2026-08-14)', async () => {
  const server = await startTestHttpServer(
    routedHandler({
      inventory: (_req, res) =>
        jsonOk(res, {
          items: [
            {
              name: 'ftd-01',
              uid: 'health-uid-1',
              deviceType: 'CDFMC_MANAGED_FTD',
              uidOnFmc: 'fmc-record-uuid-1',
            },
          ],
        }),
      certificates: (_req, res) =>
        jsonOk(res, {
          items: [
            {
              // Deliberately does NOT match the inventory's uidOnFmc above.
              id: 'some-other-fmc-record-uuid',
              enrolledCertificates: [
                {
                  identityCertificateStatus: 'AVAILABLE',
                  identityCertExpiryDate: '2030-01-01T00:00Z',
                },
              ],
            },
          ],
        }),
    }),
  );
  let certificateErrors = 0;
  const parseErrors: string[] = [];
  const adapter = makeAdapter(server, {
    inventoryPollIntervalSeconds: 300,
    certificatePollIntervalSeconds: 3600,
    onCertificateError: () => {
      certificateErrors++;
    },
    onParseError: (error) => {
      parseErrors.push(error.group);
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
    assert.ok(parseErrors.includes('certificate'), 'the join-miss must still be reported');
  } finally {
    await adapter.close();
    await server.close();
  }
});

test('SCC adapter (license/certificates): the one-time domain-UUID resolution request shares the spacing guard with every other SCC request (Opus review finding, 2026-08-14)', async () => {
  const server = await startTestHttpServer(routedHandler({}));
  const dispatcher = new Agent({ connect: { rejectUnauthorized: true } });
  const adapter = createSccAdapter({
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiToken: new Secret(SECRET_TOKEN),
    fmcUid: 'fmc-uid-1',
    timeRange: '5m',
    clock: createRealClock(),
    logger: quietLogger(),
    minSpacingMs: 100,
    dispatcher,
    certificatePollIntervalSeconds: 3600,
  });
  try {
    // init() issues exactly one request here (the domain-UUID resolution —
    // health/metrics is only fetched later, via fetchSnapshot()). If that
    // request reserved a slot on the shared guard, as it must, the
    // immediately-following fetchSnapshot() call's own health/metrics
    // request should be deferred by ~the remaining floor rather than firing
    // instantly — proving the two share one guard, not two independent
    // ones that would together exceed SCC's real 2 req/min limit in
    // production. Before the fix, this call had no `beforeAttempt` at all
    // and reserved nothing.
    await adapter.init();
    const start = Date.now();
    await adapter.fetchSnapshot();
    const elapsedMs = Date.now() - start;
    assert.ok(
      elapsedMs >= 60,
      `expected fetchSnapshot() to wait out most of the 100ms floor already consumed by init()'s domain-info request, only ${elapsedMs}ms elapsed`,
    );
  } finally {
    await adapter.close();
    await server.close();
  }
});
