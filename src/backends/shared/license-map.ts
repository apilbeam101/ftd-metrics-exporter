import type { ParseError } from '../../domain/diagnostics.ts';
import type { LicenseStatus } from '../../domain/license-status.ts';
import { parseLicenseTimestamp } from './license-time.ts';
import {
  isPlainObject,
  readOptionalNumber,
  readOptionalString,
  readRequiredString,
} from './numbers.ts';

/**
 * Pure mapper: `SmartLicenseResponse` (untyped JSON) -> `LicenseStatus`
 * (DESIGN.md §3.2.6 discipline, shared between both backends since the wire
 * shape is confirmed identical). Fleet/domain-scoped — only the first item
 * is rendered; a genuinely empty `items[]` is "no license record" (not an
 * error, `status: undefined`), matching this project's absent-not-error
 * convention for conditional data.
 */
export interface LicenseMapResult {
  status: LicenseStatus | undefined;
  parseErrors: ParseError[];
}

export function mapLicenseResponse(payload: unknown): LicenseMapResult {
  const parseErrors: ParseError[] = [];

  if (!isPlainObject(payload)) {
    parseErrors.push({ group: 'license', message: 'license response is not an object' });
    return { status: undefined, parseErrors };
  }

  const items = payload.items;
  if (!Array.isArray(items)) {
    parseErrors.push({ group: 'license', message: 'license response has no "items" array' });
    return { status: undefined, parseErrors };
  }
  if (items.length === 0) {
    return { status: undefined, parseErrors };
  }
  // Fleet/domain-scoped: exactly one record is expected (every live capture
  // on both backends returned `count: 1`). More than one is unexpected —
  // flagged as a diagnostic rather than silently rendering `items[0]` and
  // discarding the rest with no signal at all (Opus review finding,
  // 2026-08-14; mirrors fmc/map.ts's `paging.count > 1` fail-closed rule for
  // the analogous "asked for one thing, got several" case elsewhere in this
  // codebase — kept fail-open here since this endpoint's response shape,
  // unlike that one, is not scoped to a single-device query, so a genuine
  // multi-account tenant returning more than one record is not ruled out).
  if (items.length > 1) {
    parseErrors.push({
      group: 'license',
      message: `license response has ${items.length} items, expected exactly 1 — rendering only the first`,
    });
  }

  const first = items[0];
  if (!isPlainObject(first)) {
    parseErrors.push({ group: 'license', message: 'license item is not an object' });
    return { status: undefined, parseErrors };
  }

  // `readRequiredString`, not `readOptionalString` — an empty-string
  // `regStatus` must not silently pass through: `nonEmpty()`-style, absence
  // and blank-string get the same "missing" treatment rather than one
  // rendering `reg_status="unknown"` with a misleading empty
  // `ftd_exporter_unknown_enum_total{value=""}` (Opus review finding,
  // 2026-08-14 — the same present-but-empty-vs-absent gap `collector.ts`'s
  // `nonEmpty()` fallback already closes for `interface_name`).
  const regStatus = readRequiredString(first, 'regStatus');
  if (!regStatus.ok) {
    parseErrors.push({ group: 'license', message: 'license item is missing regStatus' });
    return { status: undefined, parseErrors };
  }

  const status: LicenseStatus = { regStatus: regStatus.value };
  const metadata = isPlainObject(first.metadata) ? first.metadata : undefined;

  const authStatus = readOptionalString(metadata, 'authStatus');
  if (!authStatus.ok) {
    parseErrors.push({ group: 'license', message: 'license metadata.authStatus is not a string' });
  } else if (authStatus.value !== undefined) {
    status.authStatus = authStatus.value;
  }

  const evalUsedRaw = metadata?.evalUsed;
  if (evalUsedRaw !== undefined) {
    if (typeof evalUsedRaw === 'boolean') {
      status.evalUsed = evalUsedRaw;
    } else {
      parseErrors.push({ group: 'license', message: 'license metadata.evalUsed is not a boolean' });
    }
  }

  const evalExpiresInDays = readOptionalNumber(metadata, 'evalExpiresInDays');
  if (!evalExpiresInDays.ok) {
    parseErrors.push({
      group: 'license',
      message: 'license metadata.evalExpiresInDays is not a number',
    });
  } else if (evalExpiresInDays.value !== undefined) {
    status.evalExpiresInDays = evalExpiresInDays.value;
  }

  for (const [field, target] of [
    ['lastSynchronizedTime', 'lastSynchronizedTime'],
    ['lastRenewedTime', 'lastRenewedTime'],
  ] as const) {
    const raw = readOptionalString(metadata, field);
    if (!raw.ok) {
      parseErrors.push({ group: 'license', message: `license metadata.${field} is not a string` });
      continue;
    }
    if (raw.value === undefined) {
      continue;
    }
    const parsed = parseLicenseTimestamp(raw.value);
    if (parsed === undefined) {
      parseErrors.push({
        group: 'license',
        message: `license metadata.${field} "${raw.value}" is not a recognized timestamp format`,
      });
      continue;
    }
    status[target] = parsed;
  }

  return { status, parseErrors };
}
