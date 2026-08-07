import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeError } from '../../src/log/error-normalize.ts';

const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-payload.signature';

/**
 * A realistic undici-shaped fetch/request error: the thrown error carries
 * the full request object (method, path/url, and headers including
 * Authorization) as an attached property, plus a `response` with a
 * `statusCode` and its own headers. This shape is exactly what DESIGN.md
 * §9.4 calls "the most commonly missed leak path."
 */
function buildUndiciShapedError(withCause: boolean): Error {
  const err = new Error('Request failed') as Error & Record<string, unknown>;
  err.request = {
    method: 'GET',
    path: '/api/v1/devices?filter=device_uuid:abc123',
    headers: {
      authorization: `Bearer ${SECRET_TOKEN}`,
      'user-agent': 'ftd-metrics-exporter/0.1.0',
    },
  };
  err.response = {
    statusCode: 401,
    headers: {
      'x-auth-access-token': SECRET_TOKEN,
    },
  };
  if (withCause) {
    const cause = new Error('socket hang up') as Error & Record<string, unknown>;
    cause.request = {
      method: 'GET',
      url: 'https://fmc.example.com/api/v1/devices?filter=device_uuid:abc123',
      headers: { authorization: `Bearer ${SECRET_TOKEN}` },
    };
    (err as Error & { cause?: unknown }).cause = cause;
  }
  return err;
}

test('normalizeError extracts only method, sanitized URL, status code, and message', () => {
  const normalized = normalizeError(buildUndiciShapedError(false));
  assert.equal(normalized.method, 'GET');
  assert.equal(normalized.url, '/api/v1/devices?filter=[REDACTED]');
  assert.equal(normalized.statusCode, 401);
  assert.equal(normalized.message, 'Request failed');
  assert.equal(Object.keys(normalized).sort().join(','), 'message,method,statusCode,url');
});

test('normalizeError never surfaces headers or the secret token, for a top-level error or its cause chain', () => {
  const normalized = normalizeError(buildUndiciShapedError(true));
  const serialized = JSON.stringify(normalized);
  assert.ok(!serialized.includes(SECRET_TOKEN), 'secret token leaked through error normalization');
  assert.ok(!serialized.toLowerCase().includes('authorization'));
  assert.ok(!serialized.toLowerCase().includes('x-auth-access-token'));
  assert.equal(normalized.cause?.message, 'socket hang up');
  assert.equal(normalized.cause?.url, 'https://fmc.example.com/api/v1/devices?filter=[REDACTED]');
});

test('normalizeError bounds a cyclical cause chain instead of recursing forever', () => {
  const a = new Error('a') as Error & { cause?: unknown };
  const b = new Error('b') as Error & { cause?: unknown };
  a.cause = b;
  b.cause = a;
  const normalized = normalizeError(a);
  assert.equal(normalized.message, 'a');
  assert.equal(normalized.cause?.message, 'b');
});

test('normalizeError handles a plain non-Error value without throwing', () => {
  assert.deepEqual(normalizeError('just a string'), { message: 'just a string' });
  assert.deepEqual(normalizeError(42), { message: 'Unknown error' });
  assert.deepEqual(normalizeError(null), { message: 'Unknown error' });
});

test('normalizeError falls back gracefully when no request/response metadata is attached', () => {
  const normalized = normalizeError(new Error('plain failure'));
  assert.equal(normalized.message, 'plain failure');
  assert.equal(normalized.method, undefined);
  assert.equal(normalized.url, undefined);
  assert.equal(normalized.statusCode, undefined);
});

// --- R11 regression: document current behavior against REAL undici error
// shapes, not the hand-rolled err.request/err.options fiction used above.
// Verified against node_modules/undici@8.9.0's actual thrown error classes
// (node_modules/undici/lib/core/errors.js) and a live connection-refused
// probe — neither carries `request`/`options`/`url`/`path` at the top
// level, so extractMethod/extractUrl legitimately return undefined for
// both. This is a real gap (no method/URL on these error logs) but it is
// a Stage 6 call-site concern (attaching {method, url} alongside the
// error when the HTTP client layer logs it), not something
// normalizeError can fix by guessing at a shape undici doesn't produce.

test('R11: a real undici connection-refused error (ECONNREFUSED) normalizes to message only, with statusCode/url/method absent', () => {
  const connRefused = new Error('connect ECONNREFUSED 127.0.0.1:1') as Error &
    Record<string, unknown>;
  connRefused.errno = -4078;
  connRefused.code = 'ECONNREFUSED';
  connRefused.syscall = 'connect';
  connRefused.address = '127.0.0.1';
  connRefused.port = 1;

  const normalized = normalizeError(connRefused);
  assert.equal(normalized.message, 'connect ECONNREFUSED 127.0.0.1:1');
  assert.equal(normalized.method, undefined);
  assert.equal(normalized.url, undefined);
  assert.equal(normalized.statusCode, undefined);
});

test('R11: a real undici ResponseError shape (statusCode/headers/body, no request/options) extracts statusCode but no method/url', () => {
  const responseError = new Error('Response error') as Error & Record<string, unknown>;
  responseError.name = 'ResponseError';
  responseError.code = 'UND_ERR_RESPONSE';
  responseError.statusCode = 401;
  responseError.body = { error: 'unauthorized' };
  responseError.headers = {
    authorization: `Bearer ${SECRET_TOKEN}`,
    'content-type': 'application/json',
  };

  const normalized = normalizeError(responseError);
  const serialized = JSON.stringify(normalized);
  assert.ok(
    !serialized.includes(SECRET_TOKEN),
    'headers/body must never leak through normalizeError',
  );
  assert.equal(normalized.statusCode, 401);
  assert.equal(normalized.method, undefined);
  assert.equal(normalized.url, undefined);
});
