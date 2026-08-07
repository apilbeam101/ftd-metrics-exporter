import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mapInterfaceEntry,
  SCC_INTERFACE_STATUS_FIELDS,
} from '../../src/backends/shared/interfaces.ts';

const DEVICE_UID = 'device-1';

test('a single bad numeric field is skipped, not fatal to the whole interface entry', () => {
  // Regression guard: an interface is a labelled list element like a
  // chassis fan or an S2S tunnel (DESIGN.md §3.2.6) — one bad counter must
  // not make the other 9 counters and both statuses disappear along with
  // it, or Prometheus would mark every ftd_interface_* series for this
  // interface stale, indistinguishable from the interface being removed.
  const raw = {
    interface: 'Ethernet1/1',
    interfaceName: 'outside',
    linkStatus: 'DOWN',
    operationalStatus: 'DOWN',
    inputBytesAvg: 12345,
    bufferOverrunsAvg: 'oops',
  };
  const result = mapInterfaceEntry(raw, DEVICE_UID, SCC_INTERFACE_STATUS_FIELDS);
  assert.ok(result.interface);
  assert.equal(result.interface.inputBytesAvg, 12345);
  assert.equal(result.interface.linkStatus, 'DOWN');
  assert.equal(result.interface.operationalStatus, 'DOWN');
  assert.equal(result.interface.bufferOverrunsAvg, undefined);
  assert.equal(result.parseErrors.length, 1);
});

test('a missing hardware id is entry-fatal — there is no label key without it', () => {
  const raw = { interfaceName: 'outside', linkStatus: 'UP' };
  const result = mapInterfaceEntry(raw, DEVICE_UID, SCC_INTERFACE_STATUS_FIELDS);
  assert.equal(result.interface, undefined);
  assert.equal(result.parseErrors.length, 1);
});

test('a non-string interfaceName is recorded and the entry falls back to the hardware id, not dropped', () => {
  const raw = { interface: 'Ethernet1/1', interfaceName: 12345, linkStatus: 'UP' };
  const result = mapInterfaceEntry(raw, DEVICE_UID, SCC_INTERFACE_STATUS_FIELDS);
  assert.ok(result.interface);
  assert.equal(result.interface.interfaceName, 'Ethernet1/1');
  assert.equal(result.parseErrors.length, 1);
});

test('linkStatus/operationalStatus are undefined (not a sentinel string) when absent upstream', () => {
  const raw = { interface: 'Ethernet1/1', interfaceName: 'outside' };
  const result = mapInterfaceEntry(raw, DEVICE_UID, SCC_INTERFACE_STATUS_FIELDS);
  assert.ok(result.interface);
  assert.equal(result.interface.linkStatus, undefined);
  assert.equal(result.interface.operationalStatus, undefined);
  assert.deepEqual(result.parseErrors, []);
});
