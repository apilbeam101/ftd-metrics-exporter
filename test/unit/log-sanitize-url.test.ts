import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeUrl } from '../../src/log/sanitize-url.ts';

test('sanitizeUrl redacts query-string values while keeping keys', () => {
  const result = sanitizeUrl('/api/v1/devices?filter=device_uuid:abc;metric:CPU');
  assert.equal(result, '/api/v1/devices?filter=[REDACTED]');
});

test('sanitizeUrl redacts multiple query params independently, keeping every key', () => {
  const result = sanitizeUrl('/api?token=abc123&filter=device_uuid:xyz&page=2');
  assert.equal(result, '/api?token=[REDACTED]&filter=[REDACTED]&page=[REDACTED]');
});

test('sanitizeUrl leaves a URL with no query string untouched', () => {
  assert.equal(sanitizeUrl('/api/v1/devices'), '/api/v1/devices');
});

test('sanitizeUrl handles a full absolute URL', () => {
  const result = sanitizeUrl('https://fmc.example.com/api/v1/devices?filter=device_uuid:abc');
  assert.equal(result, 'https://fmc.example.com/api/v1/devices?filter=[REDACTED]');
});

test('sanitizeUrl redacts a non-empty fragment wholesale after the query string (review finding R8)', () => {
  const result = sanitizeUrl('/api?token=abc#section');
  assert.equal(result, '/api?token=[REDACTED]#[REDACTED]');
});

test('sanitizeUrl redacts a fragment even with no query string present (review finding R8)', () => {
  const result = sanitizeUrl('https://x/api#access_token=SECRETVALUE');
  assert.equal(result, 'https://x/api#[REDACTED]');
  assert.ok(!result.includes('SECRETVALUE'));
});

test('sanitizeUrl redacts a bare query param with no "=" wholesale, not left verbatim (review finding R8)', () => {
  const result = sanitizeUrl('/api?flag');
  assert.equal(result, '/api?[REDACTED]');
});

test('sanitizeUrl redacts a bare credential-shaped query value with no key (review finding R8)', () => {
  const result = sanitizeUrl('https://x/api?SECRETVALUE');
  assert.equal(result, 'https://x/api?[REDACTED]');
  assert.ok(!result.includes('SECRETVALUE'));
});

test('sanitizeUrl handles an empty query string', () => {
  assert.equal(sanitizeUrl('/api?'), '/api?');
});

test('sanitizeUrl redacts basic-auth userinfo embedded in an absolute URL (review finding R8)', () => {
  const result = sanitizeUrl('https://admin:SECRETPASSWORD@fmc.example.com/api');
  assert.equal(result, 'https://[REDACTED]@fmc.example.com/api');
  assert.ok(!result.includes('SECRETPASSWORD'));
});

test('sanitizeUrl redacts userinfo and query values together on the same URL', () => {
  const result = sanitizeUrl('https://admin:SECRET@fmc.example.com/api?token=abc');
  assert.equal(result, 'https://[REDACTED]@fmc.example.com/api?token=[REDACTED]');
});

test('sanitizeUrl does not mistake a bare hostname (no userinfo) for having an "@" to redact', () => {
  assert.equal(sanitizeUrl('https://fmc.example.com/api'), 'https://fmc.example.com/api');
});
