import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from 'undici';
import { authTransportRequest } from '../../src/backends/fmc/auth-transport.ts';
import { createFmcTokenManager } from '../../src/backends/fmc/token-manager.ts';
import { Secret } from '../../src/config/secret.ts';
import { createLogger } from '../../src/log/logger.ts';
import { createFakeClock } from './support/fake-clock.ts';
import { startFmcMockServer } from './support/fmc-mock-server.ts';

function createTestDispatcher(): Agent {
  return new Agent({ connect: { rejectUnauthorized: false } });
}

/** Collects every raw log line so a test can assert token material never appears (plan testing step 9). */
function createCapturingLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => lines.push(line),
  });
  return { logger, lines };
}

test('FmcTokenManager: init/getToken() performs one generatetoken with a Basic auth header; tokens/domain extracted from headers; no body parsed', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    const token = await tm.getToken();
    assert.equal(token, 'access-1');
    assert.equal(server.generateTokenCallCount, 1);
    assert.equal(tm.getDomainUuidHeader(), '00000000-0000-4000-8000-000000000002');

    const authRequest = server.requests.find((r) => r.url.includes('generatetoken'));
    assert.ok(authRequest, 'expected a generatetoken request');
    const expectedAuth = `Basic ${Buffer.from('svc-account:hunter2').toString('base64')}`;
    assert.equal(authRequest?.headers.authorization, expectedAuth);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: proactive refresh fires at 80% of the 30-minute lifetime, carrying both token headers, before any request fails', async () => {
  const server = await startFmcMockServer();
  server.queueGenerateToken({ accessToken: 'login-access', refreshToken: 'login-refresh' });
  server.queueRefreshToken({ accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' });
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    await tm.getToken();
    assert.equal(server.refreshTokenCallCount, 0);

    clock.advance(24 * 60 * 1000);
    const refreshed = await tm.getToken();
    assert.equal(server.refreshTokenCallCount, 1);
    assert.equal(refreshed, 'refreshed-access');

    const refreshRequest = server.requests.find((r) => r.url.includes('refreshtoken'));
    assert.ok(refreshRequest);
    assert.equal(refreshRequest?.headers['x-auth-access-token'], 'login-access');
    assert.equal(refreshRequest?.headers['x-auth-refresh-token'], 'login-refresh');
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: after 3 refreshes, the 4th acquisition is a full generatetoken, not a refresh; reauths_total increments; refresh counter resets', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  let reauths = 0;
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
    onTokenReauth: () => {
      reauths++;
    },
  });
  try {
    await tm.getToken();
    for (let i = 0; i < 3; i++) {
      clock.advance(24 * 60 * 1000);
      await tm.getToken();
    }
    assert.equal(server.refreshTokenCallCount, 3);
    assert.equal(server.generateTokenCallCount, 1);
    assert.equal(reauths, 0);

    // 4th proactive acquisition: refreshCount is already at MAX_REFRESHES (3).
    clock.advance(24 * 60 * 1000);
    await tm.getToken();
    assert.equal(server.generateTokenCallCount, 2, 'the 4th acquisition must be a full login');
    assert.equal(server.refreshTokenCallCount, 3, 'not a 4th refresh');
    assert.equal(reauths, 1);

    // Counter reset: the next 3 proactive acquisitions should be refreshes again.
    clock.advance(24 * 60 * 1000);
    await tm.getToken();
    assert.equal(server.refreshTokenCallCount, 4);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: single-flight — 20 concurrent getToken() calls with no valid token produce exactly one generatetoken', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => tm.getToken()));
    assert.equal(server.generateTokenCallCount, 1);
    assert.ok(results.every((token) => token === results[0]));
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: single-flight — 20 concurrent getToken() calls during an in-flight proactive refresh produce exactly one refresh', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    await tm.getToken();
    clock.advance(24 * 60 * 1000);
    const results = await Promise.all(Array.from({ length: 20 }, () => tm.getToken()));
    assert.equal(server.refreshTokenCallCount, 1);
    assert.ok(results.every((token) => token === results[0]));
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: forceReauth() forces a full generatetoken and resets the refresh counter', async () => {
  const server = await startFmcMockServer();
  server.queueGenerateToken({ accessToken: 'first-login' });
  server.queueGenerateToken({ accessToken: 'second-login' });
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  let reauths = 0;
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
    onTokenReauth: () => {
      reauths++;
    },
  });
  try {
    const first = await tm.getToken();
    assert.equal(first, 'first-login');
    const fresh = await tm.forceReauth(first);
    assert.equal(server.generateTokenCallCount, 2);
    assert.equal(fresh, 'second-login');
    assert.equal(reauths, 1);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: a second consecutive forceReauth() after one already succeeded does not loop or double-count', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    const t0 = await tm.getToken();
    const t1 = await tm.forceReauth(t0);
    await tm.forceReauth(t1);
    assert.equal(server.generateTokenCallCount, 3);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: generatetoken returning 401 (bad credentials) throws an auth_fatal HttpError, no hot loop', async () => {
  const server = await startFmcMockServer();
  server.queueGenerateToken({ statusCode: 401 });
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('wrong-password'),
    clock,
    logger,
  });
  try {
    await assert.rejects(tm.getToken(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { class?: string }).class, 'auth_fatal');
      return true;
    });
    assert.equal(server.generateTokenCallCount, 1, 'must not retry a bad-credentials login');
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: once generatetoken itself fails with auth_fatal, every subsequent getToken()/forceReauth() fails fast with no further network request (review finding F1)', async () => {
  const server = await startFmcMockServer();
  server.queueGenerateToken({ statusCode: 401 });
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('wrong-password'),
    clock,
    logger,
  });
  try {
    await assert.rejects(tm.getToken());
    assert.equal(server.generateTokenCallCount, 1);

    // Further calls (simulating N independently-401ing device requests
    // each calling getToken()/forceReauth() well after the first login
    // attempt settled) must all fail fast without another generatetoken
    // POST — the mock server's queue is now empty, so if the manager
    // issued a real request it would get a 204 success (the server's
    // no-behavior-queued default), masking the bug. Any additional call
    // to generateTokenCallCount therefore proves a real request was sent.
    for (let i = 0; i < 9; i++) {
      await assert.rejects(tm.getToken(), (error: unknown) => {
        assert.equal((error as { class?: string }).class, 'auth_fatal');
        return true;
      });
    }
    await assert.rejects(tm.forceReauth('whatever-stale-token'));
    assert.equal(
      server.generateTokenCallCount,
      1,
      'must not issue another generatetoken once credentials are known bad',
    );
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: staggered forceReauth() calls holding the same already-superseded token do not each trigger a new login (review finding F2)', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    const staleToken = await tm.getToken();
    assert.equal(server.generateTokenCallCount, 1);

    // 5 forceReauth() calls, staggered so each is fully awaited (arrives
    // "just after the previous resolved") before the next starts, all
    // initially holding the SAME stale token. Only the first should ever
    // see the stale token as current and trigger a real login; every
    // subsequent call must observe the manager has already moved on and
    // just return the current token.
    let current = staleToken;
    for (let i = 0; i < 5; i++) {
      current = await tm.forceReauth(staleToken);
    }
    assert.equal(
      server.generateTokenCallCount,
      2,
      'exactly one additional login for 5 staggered calls holding the same stale token',
    );
    assert.ok(current);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: generatetoken response missing X-auth-access-token produces a clear named error', async () => {
  const server = await startFmcMockServer();
  server.queueGenerateToken({ omitAccessTokenHeader: true });
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    await assert.rejects(tm.getToken(), /X-auth-access-token/);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: a refresh that fails (non-204) falls back to a full generatetoken rather than leaving no recovery path', async () => {
  const server = await startFmcMockServer();
  server.queueRefreshToken({ statusCode: 401 });
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
  });
  try {
    await tm.getToken();
    clock.advance(24 * 60 * 1000);
    const token = await tm.getToken();
    assert.ok(token, 'must recover a usable token, not throw/hang');
    assert.equal(server.generateTokenCallCount, 2);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: token expiry callback tracks expiry across login and refresh', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock(1_000_000);
  const { logger } = createCapturingLogger();
  const expiries: number[] = [];
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('hunter2'),
    clock,
    logger,
    onTokenExpiryUpdate: (expiry) => expiries.push(expiry),
  });
  try {
    await tm.getToken();
    assert.equal(expiries.length, 1);
    const firstExpiry = expiries[0] as number;
    assert.equal(firstExpiry, Math.floor((1_000_000 + 30 * 60 * 1000) / 1000));

    clock.advance(24 * 60 * 1000);
    await tm.getToken();
    assert.equal(expiries.length, 2);
    assert.ok((expiries[1] as number) > firstExpiry);
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager: token material never appears in log output across success, failure, and missing-header cases', async () => {
  const server = await startFmcMockServer();
  server.queueGenerateToken({
    accessToken: 'SUPER-SECRET-ACCESS',
    refreshToken: 'SUPER-SECRET-REFRESH',
  });
  const dispatcher = createTestDispatcher();
  const clock = createFakeClock();
  const { logger, lines } = createCapturingLogger();
  const tm = createFmcTokenManager({
    dispatcher,
    host: server.host,
    username: 'svc-account',
    password: new Secret('SUPER-SECRET-PASSWORD'),
    clock,
    logger,
  });
  try {
    const initialToken = await tm.getToken();

    server.queueGenerateToken({ statusCode: 401 });
    await tm.forceReauth(initialToken).catch(() => {});

    logger.error('diagnostic', {
      accessToken: 'SUPER-SECRET-ACCESS',
      password: 'SUPER-SECRET-PASSWORD',
    });

    const combined = lines.join('\n');
    assert.ok(!combined.includes('SUPER-SECRET-ACCESS'));
    assert.ok(!combined.includes('SUPER-SECRET-REFRESH'));
    assert.ok(!combined.includes('SUPER-SECRET-PASSWORD'));
  } finally {
    await dispatcher.close();
    await server.close();
  }
});

test('FmcTokenManager auth transport: rejects any path other than the two permitted auth paths', async () => {
  const server = await startFmcMockServer();
  const dispatcher = createTestDispatcher();
  try {
    await assert.rejects(
      authTransportRequest({
        dispatcher,
        host: server.host,
        // @ts-expect-error deliberately not one of the two permitted AuthPath values
        path: '/api/fmc_config/v1/domain/x/devices/devicerecords',
        headers: {},
        timeoutMs: 5000,
      }),
      /not a permitted FMC auth path/,
    );
  } finally {
    await dispatcher.close();
    await server.close();
  }
});
