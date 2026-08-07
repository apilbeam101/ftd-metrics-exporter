import type { ParseError } from '../../domain/diagnostics.ts';
import type { InterfaceStats } from '../../domain/snapshot.ts';
import {
  isPlainObject,
  readOptionalNumber,
  readOptionalString,
  readRequiredString,
} from './numbers.ts';

/**
 * The two backends diverge on interface status field names — SCC uses
 * `linkStatus`/`operationalStatus`, FMC uses `currentLinkStatus`/
 * `currentOperationalStatus` (DESIGN.md §14.1, Appendix C). This mapper is
 * parameterized by which pair to read so the divergence lives in exactly
 * one place, named explicitly at each call site, rather than one backend's
 * mapper silently falling through to the other's field names — DESIGN.md
 * §14.1: "a naive adapter reusing SCC's field names verbatim against FMC
 * would silently produce empty series."
 */
export interface InterfaceStatusFieldNames {
  linkStatus: string;
  operationalStatus: string;
}

export const SCC_INTERFACE_STATUS_FIELDS: InterfaceStatusFieldNames = {
  linkStatus: 'linkStatus',
  operationalStatus: 'operationalStatus',
};

export const FMC_INTERFACE_STATUS_FIELDS: InterfaceStatusFieldNames = {
  linkStatus: 'currentLinkStatus',
  operationalStatus: 'currentOperationalStatus',
};

const NUMERIC_FIELDS: ReadonlyArray<[keyof InterfaceStats, string]> = [
  ['inputBytesAvg', 'inputBytesAvg'],
  ['outputBytesAvg', 'outputBytesAvg'],
  ['inputPacketSizeAvg', 'inputPacketSizeAvg'],
  ['outputPacketSizeAvg', 'outputPacketSizeAvg'],
  ['inputErrorsAvg', 'inputErrorsAvg'],
  ['outputErrorsAvg', 'outputErrorsAvg'],
  ['dropPacketsAvg', 'dropPacketsAvg'],
  ['bufferOverrunsAvg', 'bufferOverrunsAvg'],
  ['bufferUnderrunsAvg', 'bufferUnderrunsAvg'],
  ['l2DecodeDropsAvg', 'l2DecodeDropsAvg'],
];

export interface MapInterfaceResult {
  interface?: InterfaceStats;
  parseErrors: ParseError[];
}

/**
 * Maps one raw interface entry into the domain `InterfaceStats` shape.
 *
 * Granularity: only a missing/invalid hardware `interface` id is entry-fatal
 * (there is no label key without it). Every other malformed field —
 * `interfaceName`, `interfaceType`, `duplexMode`, a status field, or one of
 * the ten numeric counters — is recorded as a parse error and *skipped*,
 * not treated as fatal for the whole entry. An interface is a labelled list
 * element exactly like a chassis fan or an S2S tunnel (see
 * shared/groups.ts's `mapChassis`/`mapS2sTunnels`, which keep good elements
 * when one field on one element is bad); dropping the whole entry over one
 * bad counter would make DESIGN.md §3.2.6's "interface disappeared" and
 * "one field glitched" indistinguishable, which is exactly the ambiguity
 * §3.2.6 exists to avoid.
 *
 * `interfaceName` is always populated on the returned value even though
 * it's optional upstream: falls back to the hardware `interface` id per
 * DESIGN.md §4.3, since the human label is "confirmed frequently absent on
 * unnamed/unused interfaces."
 *
 * `linkStatus`/`operationalStatus` are left `undefined` when absent upstream
 * rather than defaulted to a sentinel string — DESIGN.md §3.2.6 keeps the
 * raw upstream value (or its absence) on the domain object; recognizing an
 * unrecognized *value* (as opposed to a missing key) and emitting
 * `ftd_exporter_unknown_enum_total` is the Stage 3 renderer's job, not this
 * pure mapper's, since only the renderer knows rendered metric names.
 */
export function mapInterfaceEntry(
  raw: unknown,
  deviceUid: string,
  statusFields: InterfaceStatusFieldNames,
): MapInterfaceResult {
  const parseErrors: ParseError[] = [];

  if (!isPlainObject(raw)) {
    parseErrors.push({
      deviceUid,
      group: 'interface',
      message: 'interface entry is not an object',
    });
    return { parseErrors };
  }

  const hardwareId = readRequiredString(raw, 'interface');
  if (!hardwareId.ok) {
    parseErrors.push({
      deviceUid,
      group: 'interface',
      message: 'interface entry missing required "interface" (hardware id) field',
    });
    return { parseErrors };
  }

  const iface: InterfaceStats = {
    interface: hardwareId.value,
    interfaceName: hardwareId.value,
  };

  const interfaceName = readOptionalString(raw, 'interfaceName');
  if (!interfaceName.ok) {
    parseErrors.push({
      deviceUid,
      group: 'interface',
      message: `interfaceName on ${hardwareId.value} is not a string`,
    });
  } else if (interfaceName.value !== undefined) {
    iface.interfaceName = interfaceName.value;
  }

  const interfaceType = readOptionalString(raw, 'interfaceType');
  if (!interfaceType.ok) {
    parseErrors.push({
      deviceUid,
      group: 'interface',
      message: `interfaceType on ${hardwareId.value} is not a string`,
    });
  } else if (interfaceType.value !== undefined) {
    iface.interfaceType = interfaceType.value;
  }

  const duplexMode = readOptionalString(raw, 'duplexMode');
  if (!duplexMode.ok) {
    parseErrors.push({
      deviceUid,
      group: 'interface',
      message: `duplexMode on ${hardwareId.value} is not a string`,
    });
  } else if (duplexMode.value !== undefined) {
    iface.duplexMode = duplexMode.value;
  }

  const linkStatus = readOptionalString(raw, statusFields.linkStatus);
  if (!linkStatus.ok) {
    parseErrors.push({
      deviceUid,
      group: 'interface',
      message: `${statusFields.linkStatus} on ${hardwareId.value} is not a string`,
    });
  } else if (linkStatus.value !== undefined) {
    iface.linkStatus = linkStatus.value;
  }

  const operationalStatus = readOptionalString(raw, statusFields.operationalStatus);
  if (!operationalStatus.ok) {
    parseErrors.push({
      deviceUid,
      group: 'interface',
      message: `${statusFields.operationalStatus} on ${hardwareId.value} is not a string`,
    });
  } else if (operationalStatus.value !== undefined) {
    iface.operationalStatus = operationalStatus.value;
  }

  for (const [domainKey, upstreamKey] of NUMERIC_FIELDS) {
    const read = readOptionalNumber(raw, upstreamKey);
    if (!read.ok) {
      parseErrors.push({
        deviceUid,
        group: 'interface',
        message: `interface entry ${hardwareId.value} field "${upstreamKey}" is not a finite number`,
      });
      continue;
    }
    if (read.value !== undefined) {
      (iface as unknown as Record<string, number>)[domainKey] = read.value;
    }
  }

  return { interface: iface, parseErrors };
}
