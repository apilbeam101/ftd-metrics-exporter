import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findDisallowed, isAllowed } from '../../scripts/pack-allowlist.ts';

const REAL_ALLOWLIST = ['dist/', 'example.env', 'README.md', 'LICENSE'];

test('check-pack-allowlist: package.json is always allowed regardless of the files array', () => {
  assert.equal(isAllowed('package.json', []), true);
});

test('check-pack-allowlist: a root LICENSE is always allowed regardless of the files array', () => {
  assert.equal(isAllowed('LICENSE', []), true);
  assert.equal(isAllowed('LICENSE.md', []), true);
});

test('check-pack-allowlist: every real allowlist entry and its own contents pass', () => {
  assert.equal(isAllowed('dist/index.js', REAL_ALLOWLIST), true);
  assert.equal(isAllowed('dist/backends/scc/adapter.js', REAL_ALLOWLIST), true);
  assert.equal(isAllowed('example.env', REAL_ALLOWLIST), true);
  assert.equal(isAllowed('README.md', REAL_ALLOWLIST), true);
});

test('check-pack-allowlist: .env is rejected (the original denylist entry, still covered)', () => {
  assert.equal(isAllowed('.env', REAL_ALLOWLIST), false);
});

test('check-pack-allowlist: a stray *.pem/*.key at the repo root is rejected (the credential shape the old denylist missed)', () => {
  assert.equal(isAllowed('fmc-ca.pem', REAL_ALLOWLIST), false);
  assert.equal(isAllowed('metrics-tls.key', REAL_ALLOWLIST), false);
});

test('check-pack-allowlist: a widened files array that adds deploy/ is honored, not silently blocked', () => {
  const widened = [...REAL_ALLOWLIST, 'deploy/'];
  assert.equal(isAllowed('deploy/kubernetes/deployment.yaml', widened), true);
});

test('check-pack-allowlist: findDisallowed flags exactly the disallowed subset', () => {
  const files = ['package.json', 'dist/index.js', '.env', 'data/secret.json'];
  const disallowed = findDisallowed(files, REAL_ALLOWLIST);
  assert.deepEqual(disallowed, ['.env', 'data/secret.json']);
});
