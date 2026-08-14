import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapDeviceCertificatesResponse } from '../../src/backends/shared/certificate-map.ts';

const DEVICE = { deviceUid: 'device-uid-1', deviceName: 'ftd-01' };
const lookup = (rawId: string) => (rawId === 'wire-id-1' ? DEVICE : undefined);

test('mapDeviceCertificatesResponse: the live FMC shape (2026-08-14) maps ca+identity for each enrolled certificate', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          type: 'DeviceCertificate',
          weakCryptoEnabled: true,
          enrolledCertificates: [
            {
              certificate: { name: 'Test_Certificate', id: 'x', type: 'CertEnrollment' },
              enrollmentType: 'MANUAL_ONLY_ID',
              deploymentStatus: 'SUCCESS',
              caCertificateStatus: 'NOT_APPLICABLE',
              caCertExpiryDate: '-',
              identityCertificateStatus: 'AVAILABLE',
              identityCertExpiryDate: '2028-01-13T14:15Z',
            },
            {
              certificate: { name: 'Self-Signed_RA', id: 'y', type: 'CertEnrollment' },
              enrollmentType: 'SELF_SIGNED_CERTFICATE',
              deploymentStatus: 'SUCCESS',
              caCertificateStatus: 'NOT_APPLICABLE',
              caCertExpiryDate: '-',
              identityCertificateStatus: 'AVAILABLE',
              identityCertExpiryDate: '2034-04-28T07:32Z',
            },
          ],
        },
      ],
    },
    lookup,
  );

  assert.deepEqual(result.parseErrors, []);
  assert.equal(
    result.snapshots.length,
    2,
    'two identity entries, zero ca entries (both NOT_APPLICABLE)',
  );
  assert.ok(result.snapshots.every((entry) => entry.certType === 'identity'));
  assert.deepEqual(result.snapshots.map((entry) => entry.certName).sort(), [
    'Self-Signed_RA',
    'Test_Certificate',
  ]);
  const testCert = result.snapshots.find((entry) => entry.certName === 'Test_Certificate');
  assert.equal(testCert?.deviceUid, 'device-uid-1');
  assert.equal(testCert?.deviceName, 'ftd-01');
  assert.equal(testCert?.status, 'AVAILABLE');
  assert.equal(testCert?.expiresAt.toISOString(), '2028-01-13T14:15:00.000Z');
});

test('mapDeviceCertificatesResponse: a certificate with both ca and identity AVAILABLE produces two entries', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          enrolledCertificates: [
            {
              certificate: { name: 'internal-ca-signed' },
              caCertificateStatus: 'AVAILABLE',
              caCertExpiryDate: '2027-12-16T11:46Z',
              identityCertificateStatus: 'AVAILABLE',
              identityCertExpiryDate: '2026-12-13T15:14Z',
            },
          ],
        },
      ],
    },
    lookup,
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.snapshots.length, 2);
  const ca = result.snapshots.find((entry) => entry.certType === 'ca');
  const identity = result.snapshots.find((entry) => entry.certType === 'identity');
  assert.equal(ca?.expiresAt.toISOString(), '2027-12-16T11:46:00.000Z');
  assert.equal(identity?.expiresAt.toISOString(), '2026-12-13T15:14:00.000Z');
});

test('mapDeviceCertificatesResponse: an unknown wire id (inventory/discovery has not resolved it yet) is skipped with a parse error, not fatal', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'not-yet-known',
          enrolledCertificates: [
            {
              certificate: { name: 'x' },
              identityCertificateStatus: 'AVAILABLE',
              identityCertExpiryDate: '2030-01-01T00:00Z',
            },
          ],
        },
      ],
    },
    lookup,
  );
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.parseErrors[0]?.group, 'certificate');
});

test('mapDeviceCertificatesResponse: a component with status but the wrong-typed expiry sentinel ("-" says NOT_APPLICABLE without a matching status) is a parse error, not a guess', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          enrolledCertificates: [
            {
              certificate: { name: 'contradiction' },
              caCertificateStatus: 'AVAILABLE',
              caCertExpiryDate: '-',
            },
          ],
        },
      ],
    },
    lookup,
  );
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /sentinel/);
});

test('mapDeviceCertificatesResponse: NOT_APPLICABLE with an expiry other than "-" is a parse error, not silently dropped', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          enrolledCertificates: [
            {
              certificate: { name: 'contradiction' },
              caCertificateStatus: 'NOT_APPLICABLE',
              caCertExpiryDate: '2030-01-01T00:00Z',
            },
          ],
        },
      ],
    },
    lookup,
  );
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /NOT_APPLICABLE/);
});

test('mapDeviceCertificatesResponse: a genuinely absent component (neither status nor expiry present) is skipped silently, no parse error', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          enrolledCertificates: [
            {
              certificate: { name: 'ca-only' },
              caCertificateStatus: 'AVAILABLE',
              caCertExpiryDate: '2030-01-01T00:00Z',
            },
          ],
        },
      ],
    },
    lookup,
  );
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0]?.certType, 'ca');
});

test('mapDeviceCertificatesResponse: an unparseable (non-"-", non-timestamp) expiry is a parse error', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          enrolledCertificates: [
            {
              certificate: { name: 'garbage-date' },
              identityCertificateStatus: 'AVAILABLE',
              identityCertExpiryDate: 'not-a-date',
            },
          ],
        },
      ],
    },
    lookup,
  );
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.parseErrors.length, 1);
});

test('mapDeviceCertificatesResponse: a device with no enrolledCertificates field at all is skipped silently (absent, not malformed)', () => {
  const result = mapDeviceCertificatesResponse({ items: [{ id: 'wire-id-1' }] }, lookup);
  assert.deepEqual(result.parseErrors, []);
  assert.equal(result.snapshots.length, 0);
});

test('mapDeviceCertificatesResponse: a non-object payload is a parse error, not a crash', () => {
  const result = mapDeviceCertificatesResponse([1, 2, 3], lookup);
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.parseErrors.length, 1);
});

test('mapDeviceCertificatesResponse: a response with no "items" array is a parse error', () => {
  const result = mapDeviceCertificatesResponse({ count: 0 }, lookup);
  assert.equal(result.snapshots.length, 0);
  assert.equal(result.parseErrors.length, 1);
});

test('mapDeviceCertificatesResponse: two enrolled certificates sharing a (cert_name, cert_type) key are deduped with a diagnostic, not silently overwritten downstream (Opus review finding, 2026-08-14)', () => {
  // DESIGN.md §4.6.2 explicitly allows cert_name="" -- two unnamed
  // certificates on one device is the realistic collision case, not a
  // contrived one, and would otherwise render one Prometheus series that
  // last-write-wins between two different expiry dates with no diagnostic.
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          enrolledCertificates: [
            {
              identityCertificateStatus: 'AVAILABLE',
              identityCertExpiryDate: '2030-01-01T00:00Z',
            },
            {
              identityCertificateStatus: 'AVAILABLE',
              identityCertExpiryDate: '2040-01-01T00:00Z',
            },
          ],
        },
      ],
    },
    lookup,
  );
  assert.equal(result.snapshots.length, 1, 'only the first of the colliding pair is kept');
  assert.equal(result.snapshots[0]?.expiresAt.toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(result.parseErrors.length, 1);
  assert.match(result.parseErrors[0]?.message ?? '', /same .*label set/);
});

test('mapDeviceCertificatesResponse: a certificate with no name falls back to an empty string, not a crash', () => {
  const result = mapDeviceCertificatesResponse(
    {
      items: [
        {
          id: 'wire-id-1',
          enrolledCertificates: [
            { identityCertificateStatus: 'AVAILABLE', identityCertExpiryDate: '2030-01-01T00:00Z' },
          ],
        },
      ],
    },
    lookup,
  );
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.snapshots[0]?.certName, '');
});
