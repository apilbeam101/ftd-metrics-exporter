import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../../src/log/redact.ts';

test('redact replaces a value keyed by a nested "authorization" field', () => {
  const result = redact({ a: { b: { authorization: 'x' } } }) as {
    a: { b: { authorization: string } };
  };
  assert.equal(result.a.b.authorization, '[REDACTED]');
});

test('redact is case-insensitive for key names: Authorization, AUTHORIZATION, x-Auth-Access-Token', () => {
  const result = redact({
    Authorization: 'a',
    AUTHORIZATION: 'b',
    'x-Auth-Access-Token': 'c',
  }) as Record<string, string>;
  assert.equal(result.Authorization, '[REDACTED]');
  assert.equal(result.AUTHORIZATION, '[REDACTED]');
  assert.equal(result['x-Auth-Access-Token'], '[REDACTED]');
});

test('redact does not mangle a device legitimately named token-gateway-01', () => {
  const result = redact({ device_name: 'token-gateway-01' }) as { device_name: string };
  assert.equal(result.device_name, 'token-gateway-01');
});

test('redact does not mangle a device name field even when nested under an unrelated object', () => {
  const result = redact({ device: { name: 'password-manager-host', id: 'x' } }) as {
    device: { name: string };
  };
  assert.equal(result.device.name, 'password-manager-host');
});

test('redact handles a circular reference without throwing', () => {
  const obj: Record<string, unknown> = { a: 1 };
  obj.self = obj;
  const result = redact(obj) as { self: unknown };
  assert.equal(result.self, '[Circular]');
});

test('redact handles a circular array reference without throwing', () => {
  const arr: unknown[] = [1, 2];
  arr.push(arr);
  const result = redact(arr) as unknown[];
  assert.equal(result[2], '[Circular]');
});

test('redact handles BigInt, function, and Symbol values without throwing and without dropping the line', () => {
  const result = redact({
    big: 10n,
    fn: () => 'x',
    sym: Symbol('s'),
  }) as Record<string, unknown>;
  assert.equal(result.big, '10n');
  assert.equal(result.fn, '[Function]');
  assert.equal(typeof result.sym, 'string');
  assert.ok(JSON.stringify(result).length > 0);
});

test('redact is depth-limited and does not stack-overflow on a deeply nested object', () => {
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 1000; i++) {
    deep = { child: deep };
  }
  assert.doesNotThrow(() => redact(deep));
});

test('redact filters headers to the allowlist, dropping an unlisted header entirely (not redacted-and-present)', () => {
  const result = redact({
    headers: {
      authorization: 'Bearer secret',
      'user-agent': 'ftd-metrics-exporter/0.1.0',
      'x-new-auth-thing': 'super-secret-value',
    },
  }) as { headers: Record<string, unknown> };
  assert.equal(result.headers['user-agent'], 'ftd-metrics-exporter/0.1.0');
  assert.equal('authorization' in result.headers, false);
  assert.equal('x-new-auth-thing' in result.headers, false);
});

test('redact strips a bare Bearer-token-shaped value even under a non-sensitive key', () => {
  const result = redact({ message: 'failed with Bearer eyJhbGciOiJIUzI1NiJ9.abc.def' }) as {
    message: string;
  };
  assert.equal(result.message, 'failed with Bearer [REDACTED]');
});

test('redact preserves ordinary numbers, booleans, null, and dates', () => {
  const date = new Date('2026-01-01T00:00:00.000Z');
  const result = redact({ n: 5, b: true, nil: null, d: date }) as Record<string, unknown>;
  assert.equal(result.n, 5);
  assert.equal(result.b, true);
  assert.equal(result.nil, null);
  assert.equal(result.d, date.toISOString());
});

// --- Regression tests for adversarial review findings R1-R10 -----------

test('R1: an own-enumerable throwing getter does not crash redact() or drop the log line', () => {
  const withThrowingGetter: Record<string, unknown> = { devices: 48 };
  Object.defineProperty(withThrowingGetter, 'durationMs', {
    enumerable: true,
    get(): number {
      throw new TypeError("Cannot read properties of undefined (reading 'start')");
    },
  });
  assert.doesNotThrow(() => redact(withThrowingGetter));
  const output = redact(withThrowingGetter) as Record<string, unknown>;
  assert.equal(output.devices, 48);
  assert.equal(output.durationMs, '[Getter threw]');
});

test('R1: a throwing getter nested inside an array element does not crash redact()', () => {
  const item: Record<string, unknown> = {};
  Object.defineProperty(item, 'value', {
    enumerable: true,
    get(): never {
      throw new Error('boom');
    },
  });
  const result = redact([item]) as Record<string, unknown>[];
  assert.equal(result[0]?.value, '[Getter threw]');
});

test('R2: separator-bearing spellings of "apikey" are all redacted (x-api-key, api_key, API-KEY)', () => {
  const result = redact({
    'x-api-key': 'secret1',
    api_key: 'secret2',
    'API-KEY': 'secret3',
    apiKey: 'secret4',
  }) as Record<string, string>;
  assert.equal(result['x-api-key'], '[REDACTED]');
  assert.equal(result.api_key, '[REDACTED]');
  assert.equal(result['API-KEY'], '[REDACTED]');
  assert.equal(result.apiKey, '[REDACTED]');
});

test('R2: cookie, credentials, and privateKey key names are redacted', () => {
  const result = redact({
    cookie: 'session=abc',
    'set-cookie': 'session=abc',
    credentials: 'abc',
    privateKey: 'abc',
    private_key: 'abc',
  }) as Record<string, string>;
  assert.equal(result.cookie, '[REDACTED]');
  assert.equal(result['set-cookie'], '[REDACTED]');
  assert.equal(result.credentials, '[REDACTED]');
  assert.equal(result.privateKey, '[REDACTED]');
  assert.equal(result.private_key, '[REDACTED]');
});

test('R3: a flat rawHeaders-shaped array (node:http style [name, value, ...]) is allowlist-filtered', () => {
  const rawHeaders = [
    'host',
    '127.0.0.1:51991',
    'x-api-key',
    'SUPERSECRETTOKENVALUE',
    'authorization',
    'Bearer eyJsecret',
    'user-agent',
    'ftd-metrics-exporter/0.1.0',
  ];
  const result = redact({ headers: rawHeaders }) as { headers: unknown[] };
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('SUPERSECRETTOKENVALUE'));
  assert.ok(!serialized.includes('eyJsecret'));
  assert.ok(serialized.includes('user-agent'));
  assert.ok(serialized.includes('ftd-metrics-exporter/0.1.0'));
  assert.ok(!serialized.toLowerCase().includes('x-api-key'));
});

test('R4: headers nested under responseHeaders/requestHeaders (not the literal name "headers") are allowlist-filtered', () => {
  const result = redact({
    responseHeaders: {
      'x-api-key': 'SECRET',
      'x-new-auth-thing': 'SECRET',
      'content-type': 'application/json',
    },
    requestHeaders: { authorization: 'Bearer SECRET', accept: 'application/json' },
  }) as {
    responseHeaders: Record<string, unknown>;
    requestHeaders: Record<string, unknown>;
  };
  assert.equal(result.responseHeaders['content-type'], 'application/json');
  assert.equal('x-api-key' in result.responseHeaders, false);
  assert.equal('x-new-auth-thing' in result.responseHeaders, false);
  assert.equal(result.requestHeaders.accept, 'application/json');
  assert.equal('authorization' in result.requestHeaders, false);
});

test('R7: a plain object shaped like an Error (prototype lost across a JSON boundary) is normalized, not walked generically', () => {
  // `Error#message` is non-enumerable, so a bare `JSON.stringify(new
  // Error(...))` drops it entirely — this reproduces what many HTTP
  // client / RPC layers actually produce when they serialize an error
  // for transport: an explicit `message` field alongside the error's
  // other attached properties, with the `Error` prototype gone.
  const prototypeLess: Record<string, unknown> = {
    message: 'Request failed',
    response: { statusCode: 401, body: { access_token: 'SUPERSECRETTOKENVALUE' } },
    data: { refresh: 'SUPERSECRETTOKENVALUE' },
    config: { auth: 'SUPERSECRETTOKENVALUE' },
  };
  assert.equal(Object.getPrototypeOf(prototypeLess), Object.prototype);

  const result = redact({ err: prototypeLess }) as { err: Record<string, unknown> };
  const serialized = JSON.stringify(result);
  assert.ok(
    !serialized.includes('SUPERSECRETTOKENVALUE'),
    'secret leaked via data/config on a prototype-less error',
  );
  assert.equal(result.err.statusCode, 401);
  assert.equal(result.err.message, 'Request failed');
  assert.equal('data' in result.err, false);
  assert.equal('config' in result.err, false);
});

test('R9: a Buffer value renders as a byte-count placeholder instead of an index-keyed byte array', () => {
  const secret = '{"access_token":"SUPERSECRETTOKENVALUE"}';
  const buf = Buffer.from(secret, 'utf8');
  const result = redact({ responseBody: buf }) as { responseBody: unknown };
  assert.equal(result.responseBody, `[Buffer ${buf.byteLength} bytes]`);
  assert.ok(!JSON.stringify(result).includes('SUPERSECRETTOKENVALUE'));
});

test('R9: a Uint8Array value renders as a byte-count placeholder', () => {
  const arr = new Uint8Array([1, 2, 3, 4, 5]);
  const result = redact({ chunk: arr }) as { chunk: unknown };
  assert.equal(result.chunk, '[Uint8Array 5 bytes]');
});

test('R10: token/password/secret telemetry with a safe metadata shape stays visible', () => {
  const result = redact({
    tokenRefreshCount: 2,
    tokenRefreshesRemaining: 1,
    tokenExpiresAt: '2026-08-03T12:00:00.000Z',
    tokenAgeSeconds: 1200,
    token_count: 3,
    hasToken: true,
    passwordAuthEnabled: true,
    secretsProvider: 'env',
    bearerScheme: 'Bearer',
  }) as Record<string, unknown>;
  assert.equal(result.tokenRefreshCount, 2);
  assert.equal(result.tokenRefreshesRemaining, 1);
  assert.equal(result.tokenExpiresAt, '2026-08-03T12:00:00.000Z');
  assert.equal(result.tokenAgeSeconds, 1200);
  assert.equal(result.token_count, 3);
  assert.equal(result.hasToken, true);
  assert.equal(result.passwordAuthEnabled, true);
  assert.equal(result.secretsProvider, 'env');
  assert.equal(result.bearerScheme, 'Bearer');
});

test('R10: the exemption does not weaken redaction of the actual credential-bearing keys', () => {
  const result = redact({
    token: 'super-secret-value',
    password: 'super-secret-value',
    SCC_API_TOKEN: 'super-secret-value',
    FMC_PASSWORD: 'super-secret-value',
  }) as Record<string, unknown>;
  assert.equal(result.token, '[REDACTED]');
  assert.equal(result.password, '[REDACTED]');
  assert.equal(result.SCC_API_TOKEN, '[REDACTED]');
  assert.equal(result.FMC_PASSWORD, '[REDACTED]');
});
