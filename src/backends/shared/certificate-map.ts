import type {
  CertificateComponentType,
  DeviceCertificateEntry,
} from '../../domain/certificate-status.ts';
import type { MapResult, ParseError } from '../../domain/diagnostics.ts';
import { parseCertificateExpiry } from './certificate-time.ts';
import { isPlainObject, readOptionalString } from './numbers.ts';

/**
 * Resolves one certificate record's wire-level `id` to the canonical
 * `device_uid`/`device_name` label pair — the join differs per backend
 * (SCC: `uidOnFmc` -> inventory's `uid`/`name`; FMC: `id` is already the
 * device UUID, paired with discovery's device name), so the caller supplies
 * this rather than the mapper assuming `id` is directly usable. Returning
 * `undefined` means "no known device for this id yet" (e.g. inventory or
 * discovery has not completed its first refresh) — not malformed input, so
 * the caller decides whether to skip quietly or note it.
 */
export type CertificateDeviceLookup = (
  rawId: string,
) => { deviceUid: string; deviceName: string } | undefined;

const NOT_APPLICABLE = 'NOT_APPLICABLE';
const NOT_APPLICABLE_SENTINEL = '-';

interface ComponentField {
  type: CertificateComponentType;
  statusField: 'caCertificateStatus' | 'identityCertificateStatus';
  expiryField: 'caCertExpiryDate' | 'identityCertExpiryDate';
}

const COMPONENT_FIELDS: readonly ComponentField[] = [
  { type: 'ca', statusField: 'caCertificateStatus', expiryField: 'caCertExpiryDate' },
  {
    type: 'identity',
    statusField: 'identityCertificateStatus',
    expiryField: 'identityCertExpiryDate',
  },
];

/**
 * Pure mapper: `DeviceCertificatesResponse` (untyped JSON) ->
 * `DeviceCertificateEntry[]` (DESIGN.md §3.2.6 discipline, shared between
 * both backends). Per enrolled certificate, each of its CA/identity
 * components becomes its own entry when — and only when — that component's
 * status is present and not `NOT_APPLICABLE`; a `NOT_APPLICABLE` component
 * (confirmed live: paired with expiry `"-"`) is genuinely absent, not a
 * zero-value entry. A component whose status claims applicable but whose
 * expiry is the `"-"` sentinel (or vice versa) is a contradiction the live
 * data never produced — treated as a parse error, not guessed at.
 */
export function mapDeviceCertificatesResponse(
  payload: unknown,
  lookupDevice: CertificateDeviceLookup,
): MapResult<DeviceCertificateEntry> {
  const snapshots: DeviceCertificateEntry[] = [];
  const parseErrors: ParseError[] = [];

  if (!isPlainObject(payload)) {
    parseErrors.push({ group: 'certificate', message: 'certificates response is not an object' });
    return { snapshots, parseErrors };
  }

  const items = payload.items;
  if (!Array.isArray(items)) {
    parseErrors.push({
      group: 'certificate',
      message: 'certificates response has no "items" array',
    });
    return { snapshots, parseErrors };
  }

  for (const rawRecord of items) {
    if (!isPlainObject(rawRecord)) {
      parseErrors.push({ group: 'certificate', message: 'certificate record is not an object' });
      continue;
    }

    const id = readOptionalString(rawRecord, 'id');
    if (!id.ok || id.value === undefined) {
      parseErrors.push({ group: 'certificate', message: 'certificate record missing "id"' });
      continue;
    }

    const device = lookupDevice(id.value);
    if (device === undefined) {
      parseErrors.push({
        group: 'certificate',
        message: `no known device for certificate record id "${id.value}" (device inventory/discovery may not have completed its first refresh yet)`,
      });
      continue;
    }

    const enrolledCertificates = rawRecord.enrolledCertificates;
    if (enrolledCertificates === undefined) {
      continue;
    }
    if (!Array.isArray(enrolledCertificates)) {
      parseErrors.push({
        deviceUid: device.deviceUid,
        group: 'certificate',
        message: `certificate record for ${device.deviceName} has a non-array "enrolledCertificates"`,
      });
      continue;
    }

    // Two enrolled certificates sharing a (certName, certType) key render to
    // the exact same Prometheus label set — DESIGN.md §4.6.2 explicitly
    // allows `cert_name` to be an empty string, making two unnamed
    // certificates on one device the *likely* collision, not a contrived
    // one. Without this check, the second `.set()` call in the collector
    // silently overwrites the first, dropping a real expiry with no
    // diagnostic (Opus review finding, 2026-08-14).
    const seenKeys = new Set<string>();

    for (const rawCert of enrolledCertificates) {
      if (!isPlainObject(rawCert)) {
        parseErrors.push({
          deviceUid: device.deviceUid,
          group: 'certificate',
          message: `enrolledCertificates entry on ${device.deviceName} is not an object`,
        });
        continue;
      }

      const certificateContainer = isPlainObject(rawCert.certificate)
        ? rawCert.certificate
        : undefined;
      const certName = readOptionalString(certificateContainer, 'name');
      const resolvedCertName = certName.ok && certName.value !== undefined ? certName.value : '';

      for (const component of COMPONENT_FIELDS) {
        const status = readOptionalString(rawCert, component.statusField);
        const expiry = readOptionalString(rawCert, component.expiryField);
        if (!status.ok || !expiry.ok) {
          parseErrors.push({
            deviceUid: device.deviceUid,
            group: 'certificate',
            message: `${component.statusField}/${component.expiryField} on ${device.deviceName} is not a string`,
          });
          continue;
        }
        if (status.value === undefined && expiry.value === undefined) {
          // Genuinely absent component (schema-optional field), not NOT_APPLICABLE.
          continue;
        }
        if (status.value === NOT_APPLICABLE) {
          if (expiry.value !== undefined && expiry.value !== NOT_APPLICABLE_SENTINEL) {
            parseErrors.push({
              deviceUid: device.deviceUid,
              group: 'certificate',
              message: `${component.statusField} on ${device.deviceName} is NOT_APPLICABLE but ${component.expiryField} is "${expiry.value}", not the expected "-" sentinel`,
            });
          }
          continue;
        }
        if (status.value === undefined || expiry.value === undefined) {
          parseErrors.push({
            deviceUid: device.deviceUid,
            group: 'certificate',
            message: `${component.statusField}/${component.expiryField} on ${device.deviceName} are inconsistently present (one set, one missing)`,
          });
          continue;
        }
        if (expiry.value === NOT_APPLICABLE_SENTINEL) {
          parseErrors.push({
            deviceUid: device.deviceUid,
            group: 'certificate',
            message: `${component.expiryField} on ${device.deviceName} is the "-" sentinel but ${component.statusField} is "${status.value}", not NOT_APPLICABLE`,
          });
          continue;
        }

        const expiresAt = parseCertificateExpiry(expiry.value);
        if (expiresAt === undefined) {
          parseErrors.push({
            deviceUid: device.deviceUid,
            group: 'certificate',
            message: `${component.expiryField} "${expiry.value}" on ${device.deviceName} is not a recognized timestamp format`,
          });
          continue;
        }

        const key = `${component.type}:${resolvedCertName}`;
        if (seenKeys.has(key)) {
          parseErrors.push({
            deviceUid: device.deviceUid,
            group: 'certificate',
            message: `${device.deviceName} has more than one enrolled certificate rendering to the same (cert_name="${resolvedCertName}", cert_type="${component.type}") label set — only the first is kept, later ones dropped to avoid a silent overwrite`,
          });
          continue;
        }
        seenKeys.add(key);

        snapshots.push({
          deviceUid: device.deviceUid,
          deviceName: device.deviceName,
          certName: resolvedCertName,
          certType: component.type,
          status: status.value,
          expiresAt,
        });
      }
    }
  }

  return { snapshots, parseErrors };
}
