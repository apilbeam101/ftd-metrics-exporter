import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyBinaryEnum,
  classifyHaNodeStatus,
  classifyTunnelState,
} from '../../src/metrics/enum-render.ts';

test('classifyBinaryEnum: UP -> recognized 1, DOWN -> recognized 0, absent -> absent, anything else -> unrecognized', () => {
  assert.deepEqual(classifyBinaryEnum('UP'), { kind: 'recognized', value: 1 });
  assert.deepEqual(classifyBinaryEnum('DOWN'), { kind: 'recognized', value: 0 });
  assert.deepEqual(classifyBinaryEnum(undefined), { kind: 'absent' });
  assert.deepEqual(classifyBinaryEnum('FLAPPING'), { kind: 'unrecognized', rawValue: 'FLAPPING' });
  assert.deepEqual(classifyBinaryEnum('up'), { kind: 'unrecognized', rawValue: 'up' });
});

test('classifyHaNodeStatus: every documented value maps to its lowercase label with no unrecognized flag', () => {
  for (const [raw, expected] of [
    ['NORMAL', 'normal'],
    ['ERROR', 'error'],
    ['WARNING', 'warning'],
    ['DISABLED', 'disabled'],
    ['UNKNOWN', 'unknown'],
  ] as const) {
    const result = classifyHaNodeStatus(raw);
    assert.equal(result.activeLabel, expected);
    assert.equal(result.unrecognizedRawValue, undefined);
  }
});

test('classifyHaNodeStatus: a novel value maps to "unknown" and flags unrecognizedRawValue', () => {
  const result = classifyHaNodeStatus('SOMETHING_NEW');
  assert.equal(result.activeLabel, 'unknown');
  assert.equal(result.unrecognizedRawValue, 'SOMETHING_NEW');
});

test('classifyTunnelState: TUNNEL_UP/TUNNEL_DOWN/UNKNOWN map correctly with no unrecognized flag', () => {
  assert.deepEqual(classifyTunnelState('TUNNEL_UP'), { activeLabel: 'up' });
  assert.deepEqual(classifyTunnelState('TUNNEL_DOWN'), { activeLabel: 'down' });
  assert.deepEqual(classifyTunnelState('UNKNOWN'), { activeLabel: 'unknown' });
});

test('classifyTunnelState: a novel value maps to "unknown" and flags unrecognizedRawValue', () => {
  const result = classifyTunnelState('TUNNEL_FLAPPING');
  assert.equal(result.activeLabel, 'unknown');
  assert.equal(result.unrecognizedRawValue, 'TUNNEL_FLAPPING');
});
