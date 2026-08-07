import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSupportedNodeVersion, parseMajorVersion } from '../../src/node-version-check.ts';

test('parseMajorVersion extracts the major version number', () => {
  assert.equal(parseMajorVersion('v24.0.0'), 24);
  assert.equal(parseMajorVersion('v26.3.0'), 26);
});

test('parseMajorVersion throws on an unparseable string', () => {
  assert.throws(() => parseMajorVersion('not-a-version'));
});

test('assertSupportedNodeVersion accepts Node 24 and above', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('v24.0.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('v26.3.0'));
});

test('assertSupportedNodeVersion rejects Node below 24 with an actionable message', () => {
  assert.throws(() => assertSupportedNodeVersion('v22.1.0'), /requires Node\.js >= 24/);
});
