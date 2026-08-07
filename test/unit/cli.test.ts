import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELP_TEXT, parseCli } from '../../src/cli.ts';

test('parseCli: --version selects version mode', () => {
  assert.equal(parseCli(['--version']).mode, 'version');
});

test('parseCli: --help selects help mode', () => {
  assert.equal(parseCli(['--help']).mode, 'help');
});

test('parseCli: --dump-raw selects dump-raw mode', () => {
  assert.equal(parseCli(['--dump-raw']).mode, 'dump-raw');
});

test('parseCli: no recognized flag selects run mode', () => {
  assert.equal(parseCli([]).mode, 'run');
  assert.equal(parseCli(['--env-file=/tmp/.env']).mode, 'run');
});

test('parseCli: --version takes priority over --dump-raw when both are somehow present', () => {
  assert.equal(parseCli(['--dump-raw', '--version']).mode, 'version');
});

test('parseCli: --env-file alongside --dump-raw still selects dump-raw', () => {
  assert.equal(parseCli(['--env-file=/tmp/.env', '--dump-raw']).mode, 'dump-raw');
});

test('HELP_TEXT lists every documented flag', () => {
  assert.ok(HELP_TEXT.includes('--env-file'));
  assert.ok(HELP_TEXT.includes('--dump-raw'));
  assert.ok(HELP_TEXT.includes('--version'));
  assert.ok(HELP_TEXT.includes('--help'));
});
