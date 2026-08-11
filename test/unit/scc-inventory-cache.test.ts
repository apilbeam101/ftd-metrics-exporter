import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSccDeviceInventory } from '../../src/backends/scc/inventory.ts';
import { createFakeClock } from './support/fake-clock.ts';

test('createSccDeviceInventory: refreshIfDue() fetches on the first call regardless of interval', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const inventory = createSccDeviceInventory({
    clock,
    intervalMs: 300_000,
    fetchDevices: async () => {
      calls++;
      return [{ deviceUid: 'u1', deviceName: 'ftd-01' }];
    },
  });
  assert.deepEqual(inventory.getCached(), []);
  await inventory.refreshIfDue();
  assert.equal(calls, 1);
  assert.equal(inventory.getCached().length, 1);
});

test('createSccDeviceInventory: a second refreshIfDue() before intervalMs has elapsed does not re-fetch', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const inventory = createSccDeviceInventory({
    clock,
    intervalMs: 300_000,
    fetchDevices: async () => {
      calls++;
      return [{ deviceUid: 'u1', deviceName: 'ftd-01' }];
    },
  });
  await inventory.refreshIfDue();
  clock.advance(1_000);
  await inventory.refreshIfDue();
  assert.equal(calls, 1, 'expected the second call to be a no-op cache read, not a re-fetch');
});

test('createSccDeviceInventory: refetches once intervalMs has elapsed since the last SUCCESSFUL refresh', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const inventory = createSccDeviceInventory({
    clock,
    intervalMs: 300_000,
    fetchDevices: async () => {
      calls++;
      return [{ deviceUid: 'u1', deviceName: 'ftd-01' }];
    },
  });
  await inventory.refreshIfDue();
  clock.advance(300_000);
  await inventory.refreshIfDue();
  assert.equal(calls, 2);
});

test('createSccDeviceInventory: a failed refresh keeps the previous list, does not throw, and calls onFailure', async () => {
  const clock = createFakeClock();
  let onFailureCalls = 0;
  let shouldFail = false;
  const inventory = createSccDeviceInventory({
    clock,
    intervalMs: 1_000,
    fetchDevices: async () => {
      if (shouldFail) throw new Error('network error');
      return [{ deviceUid: 'u1', deviceName: 'ftd-01' }];
    },
    onFailure: () => {
      onFailureCalls++;
    },
  });
  await inventory.refreshIfDue();
  assert.equal(inventory.getCached().length, 1);

  shouldFail = true;
  clock.advance(1_000);
  await assert.doesNotReject(() => inventory.refreshIfDue());
  assert.equal(onFailureCalls, 1);
  assert.equal(
    inventory.getCached().length,
    1,
    'the previous good list must survive a failed refresh',
  );
});

test('createSccDeviceInventory: a failed refresh does NOT count as due-satisfying — the next call retries, not waits a full interval', async () => {
  const clock = createFakeClock();
  let calls = 0;
  let shouldFail = true;
  const inventory = createSccDeviceInventory({
    clock,
    intervalMs: 300_000,
    fetchDevices: async () => {
      calls++;
      if (shouldFail) throw new Error('network error');
      return [{ deviceUid: 'u1', deviceName: 'ftd-01' }];
    },
    onFailure: () => {},
  });
  await inventory.refreshIfDue();
  assert.equal(calls, 1);
  shouldFail = false;
  clock.advance(1_000); // far short of the 300s interval
  await inventory.refreshIfDue();
  assert.equal(calls, 2, 'a prior failure must not be treated as a fresh success for due-checking');
  assert.equal(inventory.getCached().length, 1);
});

test('createSccDeviceInventory: concurrent refreshIfDue() calls single-flight to one fetchDevices() call', async () => {
  const clock = createFakeClock();
  let calls = 0;
  let resolveFetch: (() => void) | undefined;
  const inventory = createSccDeviceInventory({
    clock,
    intervalMs: 300_000,
    fetchDevices: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
      return [{ deviceUid: 'u1', deviceName: 'ftd-01' }];
    },
  });
  const first = inventory.refreshIfDue();
  const second = inventory.refreshIfDue();
  resolveFetch?.();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
