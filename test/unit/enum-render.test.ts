import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyBinaryEnum,
  classifyHaNodeStatus,
  classifyInterfaceType,
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

test('classifyInterfaceType: every known value passes through unchanged with no unrecognized flag', () => {
  for (const raw of ['Ethernet', 'Management', 'SubInterface', 'GigabitEthernet']) {
    assert.deepEqual(classifyInterfaceType(raw), { label: raw });
  }
});

test('classifyInterfaceType: a novel value passes through UNCHANGED (never "unknown") but flags unrecognizedRawValue', () => {
  // The one classifier in this module that deliberately does NOT coerce an
  // unrecognized value to a fallback label — interface_type is purely
  // informational and its rendered value is the versioned public API
  // (DESIGN.md §13/§4.3). Coercing to "unknown" here would be a breaking
  // rendered-value change for whoever currently sees this raw value.
  const result = classifyInterfaceType('VirtualPortChannel');
  assert.deepEqual(result, {
    label: 'VirtualPortChannel',
    unrecognizedRawValue: 'VirtualPortChannel',
  });
});
