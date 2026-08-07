import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lowercaseEnumLabel, tunnelStateLabel } from '../../src/domain/enums.ts';

test('lowercaseEnumLabel lowercases a straightforward enum', () => {
  assert.equal(lowercaseEnumLabel('UP'), 'up');
  assert.equal(lowercaseEnumLabel('NORMAL'), 'normal');
});

test('tunnelStateLabel maps TUNNEL_UP/TUNNEL_DOWN to up/down, not a lowercased prefix', () => {
  assert.equal(tunnelStateLabel('TUNNEL_UP'), 'up');
  assert.equal(tunnelStateLabel('TUNNEL_DOWN'), 'down');
  assert.equal(tunnelStateLabel('UNKNOWN'), 'unknown');
});

test('tunnelStateLabel maps an unrecognized value to unknown', () => {
  assert.equal(tunnelStateLabel('SOMETHING_NEW'), 'unknown');
});
