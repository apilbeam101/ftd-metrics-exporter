import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findOffenders } from '../../scripts/license-compound.ts';

test('check-license-compound: a plain permissive license passes', () => {
  const offenders = findOffenders({ 'clean-pkg@1.0.0': { licenses: 'MIT' } });
  assert.deepEqual(offenders, []);
});

test('check-license-compound: an SPDX OR expression passes', () => {
  const offenders = findOffenders({ 'dual-pkg@1.0.0': { licenses: 'MIT OR Apache-2.0' } });
  assert.deepEqual(offenders, []);
});

test('check-license-compound: an SPDX AND expression is caught (the --onlyAllow gap this backstops)', () => {
  const offenders = findOffenders({ 'copyleft-dep@1.0.0': { licenses: '(MIT AND GPL-3.0)' } });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0]?.name, 'copyleft-dep@1.0.0');
});

test('check-license-compound: an UNKNOWN license is caught', () => {
  const offenders = findOffenders({ 'mystery-pkg@1.0.0': { licenses: 'UNKNOWN' } });
  assert.equal(offenders.length, 1);
});

test('check-license-compound: a blank license is caught', () => {
  const offenders = findOffenders({ 'blank-pkg@1.0.0': { licenses: '' } });
  assert.equal(offenders.length, 1);
});

test('check-license-compound: an array-valued licenses field is joined and checked', () => {
  const offenders = findOffenders({ 'array-pkg@1.0.0': { licenses: ['MIT', 'AND', 'GPL-3.0'] } });
  assert.equal(offenders.length, 1);
});
