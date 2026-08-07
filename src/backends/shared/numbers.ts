/**
 * Runtime-safe extraction of optional numeric/string fields from an
 * untyped upstream object. The schema types (scc/schema.ts, fmc/schema.ts)
 * describe the *expected* shape, but nothing guarantees an actual HTTP
 * response body matches it — these helpers are the boundary where that
 * gets checked.
 *
 * A field that is simply missing is `undefined` and perfectly normal
 * (nearly every field in these schemas is optional upstream). A field that
 * is *present but the wrong type* is a genuine parse problem — callers use
 * `ok: false` to decide whether to drop the whole containing group
 * (DESIGN.md §3.2.6's group-granularity skip, not field-granularity).
 *
 * `Number.isFinite` deliberately excludes `NaN`/`Infinity`: a genuine `0`
 * passes (DESIGN.md §4.8's truthiness-bug guard), but a field that somehow
 * deserializes to `NaN` is treated as invalid, not as a real zero.
 */

export type FieldRead<T> = { ok: true; value: T | undefined } | { ok: false };

export function readOptionalNumber(
  container: Record<string, unknown> | undefined,
  key: string,
): FieldRead<number> {
  if (container === undefined || !(key in container)) {
    return { ok: true, value: undefined };
  }
  const value = container[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { ok: true, value };
  }
  return { ok: false };
}

export function readOptionalString(
  container: Record<string, unknown> | undefined,
  key: string,
): FieldRead<string> {
  if (container === undefined || !(key in container)) {
    return { ok: true, value: undefined };
  }
  const value = container[key];
  if (typeof value === 'string') {
    return { ok: true, value };
  }
  return { ok: false };
}

export function readRequiredString(
  container: Record<string, unknown> | undefined,
  key: string,
): { ok: true; value: string } | { ok: false } {
  if (container === undefined) {
    return { ok: false };
  }
  const value = container[key];
  if (typeof value === 'string' && value.length > 0) {
    return { ok: true, value };
  }
  return { ok: false };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
