import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CpuStats, DeviceHealthSnapshot } from '../../src/domain/snapshot.ts';

/**
 * Compile-time proof that `exactOptionalPropertyTypes` (tsconfig.json)
 * really enforces DESIGN.md §4.8's sparse-group rule: an optional group
 * must be *omitted*, not explicitly set to `undefined`. If these
 * `@ts-expect-error` directives ever stop erroring, `npm run typecheck`
 * fails loudly (an unused `@ts-expect-error` is itself a type error),
 * which is the point — it means the compiler stopped enforcing the
 * invariant this whole layer depends on.
 */

test('exactOptionalPropertyTypes rejects an explicit undefined on an optional group', () => {
  // @ts-expect-error — `cpu` must be omitted, not set to `undefined`, under exactOptionalPropertyTypes.
  const snapshot: DeviceHealthSnapshot = {
    deviceUid: 'x',
    deviceName: 'y',
    cpu: undefined,
  };
  assert.ok(snapshot);
});

test('omitting an optional group entirely is valid', () => {
  const snapshot: DeviceHealthSnapshot = {
    deviceUid: 'x',
    deviceName: 'y',
  };
  assert.equal(snapshot.cpu, undefined);
});

test('a genuine numeric zero is assignable to an optional numeric field', () => {
  const cpu: CpuStats = { lina: 0, snort: 0, system: 0 };
  assert.equal(cpu.lina, 0);
});
