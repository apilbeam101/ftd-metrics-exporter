import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Counter, Registry } from 'prom-client';
import type { DeviceCertificateEntry } from '../../src/domain/certificate-status.ts';
import { renderCertificateMetrics } from '../../src/metrics/certificate-collector.ts';
import { createCertificateMetrics } from '../../src/metrics/certificate-metrics.ts';

function harness() {
  const registry = new Registry();
  const metrics = createCertificateMetrics(registry);
  const unknownEnumTotal = new Counter({
    name: 'test_unknown_enum_total',
    help: 'test-only',
    labelNames: ['metric', 'value'],
    registers: [],
  });
  return { metrics, unknownEnumTotal };
}

test('renderCertificateMetrics: renders expiry + status_info for each entry', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const entries: DeviceCertificateEntry[] = [
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      certName: 'vpn.example.local',
      certType: 'identity',
      status: 'AVAILABLE',
      expiresAt: new Date('2028-01-13T14:15:00Z'),
    },
  ];
  const result = renderCertificateMetrics({ metrics, unknownEnumTotal }, entries);
  assert.equal(result.seriesCount, 2);

  const expiry = await metrics.expiryTimestampSeconds.get();
  assert.equal(expiry.values.length, 1);
  assert.deepEqual(expiry.values[0]?.labels, {
    device_uid: 'u1',
    device_name: 'ftd-01',
    cert_name: 'vpn.example.local',
    cert_type: 'identity',
  });
  assert.equal(expiry.values[0]?.value, new Date('2028-01-13T14:15:00Z').getTime() / 1000);

  const status = await metrics.statusInfo.get();
  assert.equal(status.values[0]?.labels.status, 'available');
});

test('renderCertificateMetrics: an unrecognized status renders "unknown" and increments the diagnostic counter', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderCertificateMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      certName: 'x',
      certType: 'ca',
      status: 'SOMETHING_NEW',
      expiresAt: new Date(),
    },
  ]);
  const status = await metrics.statusInfo.get();
  assert.equal(status.values[0]?.labels.status, 'unknown');
  const counter = await unknownEnumTotal.get();
  assert.equal(
    counter.values.find((v) => v.labels.metric === 'ftd_certificate_status_info')?.value,
    1,
  );
});

test('renderCertificateMetrics: two components of the same certificate (ca + identity) render as two independent series', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const entries: DeviceCertificateEntry[] = [
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      certName: 'internal-ca-signed',
      certType: 'ca',
      status: 'AVAILABLE',
      expiresAt: new Date('2027-12-16T11:46:00Z'),
    },
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      certName: 'internal-ca-signed',
      certType: 'identity',
      status: 'AVAILABLE',
      expiresAt: new Date('2026-12-13T15:14:00Z'),
    },
  ];
  const result = renderCertificateMetrics({ metrics, unknownEnumTotal }, entries);
  assert.equal(result.seriesCount, 4);
  const expiry = await metrics.expiryTimestampSeconds.get();
  assert.equal(expiry.values.length, 2);
});

test('renderCertificateMetrics: reset-then-repopulate — a certificate absent from a later render disappears', async () => {
  const { metrics, unknownEnumTotal } = harness();
  renderCertificateMetrics({ metrics, unknownEnumTotal }, [
    {
      deviceUid: 'u1',
      deviceName: 'ftd-01',
      certName: 'x',
      certType: 'identity',
      status: 'AVAILABLE',
      expiresAt: new Date(),
    },
  ]);
  renderCertificateMetrics({ metrics, unknownEnumTotal }, []);
  const expiry = await metrics.expiryTimestampSeconds.get();
  assert.equal(expiry.values.length, 0);
});

test('renderCertificateMetrics: empty input renders zero series, no error', async () => {
  const { metrics, unknownEnumTotal } = harness();
  const result = renderCertificateMetrics({ metrics, unknownEnumTotal }, []);
  assert.equal(result.seriesCount, 0);
});
