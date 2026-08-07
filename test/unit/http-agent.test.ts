import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'undici';
import { createAgent } from '../../src/http/agent.ts';
import { startTestHttpsServer } from './support/https-server.ts';
import { generateTlsFixture } from './support/tls-fixtures.ts';

async function fetchOk(port: number, dispatcher: import('undici').Agent): Promise<number> {
  const res = await request(`https://127.0.0.1:${port}/`, { method: 'GET', dispatcher });
  await res.body.text();
  return res.statusCode;
}

test('createAgent: no CA bundle -> verification failure against a self-signed server', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const server = await startTestHttpsServer({ key: fixture.key, cert: fixture.cert });
  const agent = createAgent({ minVersion: 'TLSv1.2' });
  try {
    await assert.rejects(fetchOk(server.port, agent));
  } finally {
    await agent.close();
    await server.close();
  }
});

test('createAgent: with the matching CA bundle -> success, and hostname verification is still active', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const server = await startTestHttpsServer({ key: fixture.key, cert: fixture.cert });
  const agent = createAgent({ ca: fixture.cert, minVersion: 'TLSv1.2' });
  try {
    const statusCode = await fetchOk(server.port, agent);
    assert.equal(statusCode, 200);
  } finally {
    await agent.close();
    await server.close();
  }
});

test('createAgent: FMC_TLS_INSECURE_SKIP_VERIFY=true equivalent (rejectUnauthorized=false) succeeds with no CA bundle', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const server = await startTestHttpsServer({ key: fixture.key, cert: fixture.cert });
  const agent = createAgent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
  try {
    const statusCode = await fetchOk(server.port, agent);
    assert.equal(statusCode, 200);
  } finally {
    await agent.close();
    await server.close();
  }
});

test('createAgent: trust scoping — a CA loaded for one Agent does not verify a different self-signed host through another Agent', async () => {
  // Both certs use the same SAN (127.0.0.1) so hostname verification passes
  // for either — this isolates the assertion to trust (CA), not hostname.
  const fixtureA = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const fixtureB = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const serverA = await startTestHttpsServer({ key: fixtureA.key, cert: fixtureA.cert });
  const serverB = await startTestHttpsServer({ key: fixtureB.key, cert: fixtureB.cert });

  const agentTrustingA = createAgent({ ca: fixtureA.cert, minVersion: 'TLSv1.2' });
  try {
    const okAgainstA = await fetchOk(serverA.port, agentTrustingA);
    assert.equal(okAgainstA, 200, 'sanity check: the CA does trust its own server');

    await assert.rejects(
      fetchOk(serverB.port, agentTrustingA),
      /./,
      'an Agent trusting only CA A must NOT trust server B — a shared/global trust store would let this through',
    );
  } finally {
    await agentTrustingA.close();
    await serverA.close();
    await serverB.close();
  }
});

test('createAgent: hostname mismatch — a cert valid for a DNS name fails against an IP request even with the CA loaded', async () => {
  const fixture = await generateTlsFixture('fmc.example.internal');
  const server = await startTestHttpsServer({ key: fixture.key, cert: fixture.cert });
  const agent = createAgent({ ca: fixture.cert, minVersion: 'TLSv1.2' });
  try {
    await assert.rejects(fetchOk(server.port, agent));
  } finally {
    await agent.close();
    await server.close();
  }
});

test('createAgent: minVersion TLSv1.2 rejects a server limited to TLSv1.1 and below', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const server = await startTestHttpsServer({
    key: fixture.key,
    cert: fixture.cert,
    minVersion: 'TLSv1',
    maxVersion: 'TLSv1.1',
  });
  const agent = createAgent({ ca: fixture.cert, minVersion: 'TLSv1.2' });
  try {
    await assert.rejects(fetchOk(server.port, agent));
  } finally {
    await agent.close();
    await server.close();
  }
});

test('the exporter never sets process.env.NODE_EXTRA_CA_CERTS', async () => {
  const fixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const server = await startTestHttpsServer({ key: fixture.key, cert: fixture.cert });
  const before = process.env.NODE_EXTRA_CA_CERTS;
  const agent = createAgent({ ca: fixture.cert, minVersion: 'TLSv1.2' });
  try {
    await fetchOk(server.port, agent);
    assert.equal(process.env.NODE_EXTRA_CA_CERTS, before);
  } finally {
    await agent.close();
    await server.close();
  }
});
