import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyNetworkError,
  classifyStatusCode,
  HttpError,
  isRetryable,
} from '../../src/http/errors.ts';

test('classifyStatusCode: 429 -> rate_limited, retryable, carries retryAfterMs', () => {
  const error = classifyStatusCode(429, 5000);
  assert.equal(error.class, 'rate_limited');
  assert.equal(error.reason, 'rate_limited');
  assert.equal(error.retryAfterMs, 5000);
  assert.ok(isRetryable(error));
});

test('classifyStatusCode: 429 with no Retry-After still classifies rate_limited', () => {
  const error = classifyStatusCode(429);
  assert.equal(error.class, 'rate_limited');
  assert.equal(error.retryAfterMs, undefined);
});

for (const statusCode of [400, 401, 403]) {
  test(`classifyStatusCode: ${statusCode} is not retryable`, () => {
    const error = classifyStatusCode(statusCode);
    assert.equal(isRetryable(error), false);
  });
}

test('classifyStatusCode: 401/403 classify as auth_fatal with reason=auth', () => {
  assert.equal(classifyStatusCode(401).class, 'auth_fatal');
  assert.equal(classifyStatusCode(401).reason, 'auth');
  assert.equal(classifyStatusCode(403).class, 'auth_fatal');
});

test('classifyStatusCode: 400 classifies as schema_parse, not auth (it is not an auth status)', () => {
  const error = classifyStatusCode(400);
  assert.equal(error.class, 'schema_parse');
  assert.equal(isRetryable(error), false);
});

for (const statusCode of [500, 502, 503]) {
  test(`classifyStatusCode: ${statusCode} -> transient, retryable, reason=http_5xx`, () => {
    const error = classifyStatusCode(statusCode);
    assert.equal(error.class, 'transient');
    assert.equal(error.reason, 'http_5xx');
    assert.ok(isRetryable(error));
  });
}

test('classifyNetworkError: AbortError -> transient, reason=timeout', () => {
  const abortError = new Error('The operation was aborted due to timeout');
  abortError.name = 'TimeoutError';
  const error = classifyNetworkError(abortError);
  assert.equal(error.class, 'transient');
  assert.equal(error.reason, 'timeout');
  assert.ok(isRetryable(error));
});

test('classifyNetworkError: ECONNREFUSED-shaped error -> transient, reason=network', () => {
  const networkError = new Error('connect ECONNREFUSED 127.0.0.1:1');
  const error = classifyNetworkError(networkError);
  assert.equal(error.class, 'transient');
  assert.equal(error.reason, 'network');
  assert.ok(isRetryable(error));
});

test('classifyNetworkError: a non-Error thrown value still produces a usable message', () => {
  const error = classifyNetworkError('socket hang up');
  assert.equal(error.message, 'socket hang up');
  assert.equal(error.reason, 'network');
});

test('classifyNetworkError: a thrown value with no usable String() coercion does not throw itself (Opus review F3)', () => {
  // Object.create(null) has no Object.prototype.toString/Symbol.toPrimitive
  // — String(Object.create(null)) throws "Cannot convert object to
  // primitive value." classifyNetworkError runs inside withRetry's and
  // poller.ts's own catch blocks with no further fallback above it, so it
  // must never throw itself no matter how hostile the thrown value is.
  const error = classifyNetworkError(Object.create(null));
  assert.equal(error.reason, 'network');
  assert.match(error.message, /unstringifiable value/);
});

test('classifyNetworkError: a thrown value with a throwing toString does not throw itself (Opus review F3)', () => {
  const hostile = { toString: null };
  const error = classifyNetworkError(hostile);
  assert.equal(error.reason, 'network');
  assert.match(error.message, /unstringifiable value/);
});

test('HttpError is a real Error subclass: instanceof Error, has a stack, does not stringify as [object Object] (Opus review F10)', () => {
  const error = classifyStatusCode(500);
  assert.ok(error instanceof Error);
  assert.ok(error instanceof HttpError);
  assert.equal(typeof error.stack, 'string');
  assert.notEqual(String(error), '[object Object]');
  assert.match(String(error), /upstream returned 500/);
});

test('classifyNetworkError is idempotent: an already-classified HttpError passes through unchanged, not re-collapsed to transient/network (Opus review F1)', () => {
  const original = classifyStatusCode(401);
  const reclassified = classifyNetworkError(original);
  assert.equal(reclassified, original, 'must return the same instance, not a new one');
  assert.equal(reclassified.class, 'auth_fatal');
  assert.equal(reclassified.reason, 'auth');
  assert.notEqual(reclassified.message, '[object Object]');
});

test('classifyNetworkError idempotence covers a rate_limited HttpError too, preserving retryAfterMs', () => {
  const original = classifyStatusCode(429, 5000);
  const reclassified = classifyNetworkError(original);
  assert.equal(reclassified, original);
  assert.equal(reclassified.retryAfterMs, 5000);
});

test('classifyStatusCode: a 3xx the client deliberately never follows classifies as schema_parse/unknown with a redirect-specific message (Opus review F5)', () => {
  const error = classifyStatusCode(302);
  assert.equal(error.class, 'schema_parse');
  assert.equal(error.reason, 'unknown');
  assert.match(error.message, /redirect/i);
  assert.equal(isRetryable(error), false);
});

test('classifyStatusCode: a 5xx also carries retryAfterMs through when the upstream sent Retry-After (Opus review F8)', () => {
  const error = classifyStatusCode(503, 2000);
  assert.equal(error.class, 'transient');
  assert.equal(error.retryAfterMs, 2000);
});
