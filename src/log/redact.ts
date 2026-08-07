/**
 * The redaction serializer, applied at the logger boundary (DESIGN.md
 * §9.4) — this is the ONLY sanctioned place a secret gets stripped.
 * Relying on call sites to remember is, per the design doc, "a design
 * flaw, not a coding standard."
 *
 * Two independent mechanisms, deliberately scoped differently:
 *
 * 1. Key-name matching (case-insensitive, separator-insensitive
 *    substring): if an object key contains one of the listed patterns,
 *    the *entire value* under that key is replaced with `[REDACTED]`,
 *    regardless of what the value looks like — UNLESS the key also
 *    matches a known-safe metadata shape (see `SAFE_METADATA_*` below),
 *    in which case it is deliberately exempted so operability doesn't
 *    regress (`tokenRefreshesRemaining: 2` must stay visible even though
 *    the key contains "token" — see the implementation plan's Stage 5
 *    risk list: "over-redaction hiding the debugging value of logs").
 * 2. A narrow bearer-token-shaped VALUE pattern (`Bearer <token>`) as a
 *    second safety net, for the case where a raw token ends up inside a
 *    string value under a key that wasn't recognized as sensitive (e.g.
 *    a token accidentally interpolated into a free-text message).
 *
 * Deliberately NOT a third mechanism: generic substring matching of
 * "token"/"password"/etc. against arbitrary VALUES. That is exactly what
 * would mangle a device legitimately named `token-gateway-01` (the
 * false-positive risk called out in the implementation plan) — pattern
 * matching here only ever looks at key names or at the specific
 * `Bearer ...` shape, never at whether a value merely *contains* one of
 * these words.
 */

import { isNormalizableError, type NormalizedError, normalizeError } from './error-normalize.ts';
import { filterHeaders } from './header-allowlist.ts';
import { sanitizeUrl } from './sanitize-url.ts';

const URL_KEYS = new Set(['url', 'path']);

/**
 * Patterns are matched against a *normalized* key (lowercased, `-`/`_`
 * stripped) so that `x-api-key`, `api_key`, `X-API-KEY`, and `apiKey` all
 * match the single `apikey` pattern — review finding R2: substring
 * matching against the raw key missed every separator-bearing spelling
 * of a header/env-var name.
 */
const SENSITIVE_KEY_PATTERNS = [
  'sccapitoken',
  'fmcpassword',
  'authorization',
  'xauthaccesstoken',
  'xauthrefreshtoken',
  'password',
  'passwd',
  'pwd',
  'token',
  'secret',
  'apikey',
  'bearer',
  'cookie',
  'credentials',
  'privatekey',
] as const;

/**
 * A key matching a `SENSITIVE_KEY_PATTERNS` entry is nonetheless exempted
 * from redaction if it *also* ends with one of these metadata-shaped
 * suffixes, or starts with one of these presence-check prefixes — this
 * is what keeps `tokenRefreshCount`, `tokenRefreshesRemaining`,
 * `tokenExpiresAt`, `tokenAgeSeconds`, `hasToken`, `passwordAuthEnabled`,
 * `secretsProvider`, and `bearerScheme` visible (review finding R10)
 * while the bare `token`/`password`/`secret`/`bearer` keys that actually
 * carry the credential value stay fully redacted, since none of those
 * bare keys end with (or start with) an exemption.
 *
 * Deliberately NOT exempting a bare "auth" pattern in
 * `SENSITIVE_KEY_PATTERNS` above, even though it's a plausible real
 * credential-shaped key: "auth" is a substring of ordinary English words
 * ("author", "authentic", "authority") that are very plausibly real
 * field names, and adding it would reopen exactly the false-positive
 * class the plan's test 5 guards against. `authorization`,
 * `x-auth-access-token`, and `x-auth-refresh-token` (DESIGN.md §9.4's
 * explicit list) remain covered as their own composite patterns.
 */
const SAFE_METADATA_SUFFIXES = [
  'count',
  'remaining',
  'expiresat',
  'ageseconds',
  'enabled',
  'scheme',
  'provider',
] as const;
const SAFE_METADATA_PREFIXES = ['has', 'is'] as const;

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 10;

const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function isExemptMetadataKey(normalizedKey: string): boolean {
  return (
    SAFE_METADATA_SUFFIXES.some((suffix) => normalizedKey.endsWith(suffix)) ||
    SAFE_METADATA_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (isExemptMetadataKey(normalized)) {
    return false;
  }
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function redactBearerValues(value: string): string {
  return value.replace(BEARER_VALUE_PATTERN, `Bearer ${REDACTED}`);
}

/**
 * `node:http`'s `req.rawHeaders` is a flat array of alternating
 * `[name, value, name, value, ...]` — header *names* here are array
 * values, not object keys, so `isSensitiveKey` never runs over them
 * (review finding R3: this let an unlisted header's value, e.g.
 * `x-api-key`, leak verbatim through the generic array-recursion path).
 * Applying the same allowlist semantics as `filterHeaders` (object form)
 * keeps both header shapes consistent: a name not on the allowlist is
 * dropped entirely, not redacted-and-present.
 */
function filterRawHeaderPairs(pairs: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const name = pairs[i];
    if (typeof name !== 'string') {
      continue;
    }
    if (filterHeaders({ [name]: pairs[i + 1] })[name.toLowerCase()] !== undefined) {
      out.push(name.toLowerCase(), pairs[i + 1]);
    }
  }
  return out;
}

/**
 * Converts an already-normalized error to a plain redacted object without
 * routing back through the generic object branch of `redactValue`: a
 * `NormalizedError`'s own fields (`method`, `url`, `statusCode`, `cause`)
 * are exactly the shape `isNormalizableError`'s hint-key list looks for,
 * so re-entering `redactValue` on it would call `normalizeError` again,
 * produce another structurally-identical `NormalizedError`, and recurse
 * forever without depth ever increasing — an infinite loop discovered by
 * this stage's own R7 regression test after the R7 fix was first written.
 */
function redactNormalizedError(
  normalized: NormalizedError,
  ancestors: Set<object>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { message: redactBearerValues(normalized.message) };
  if (normalized.method !== undefined) out.method = normalized.method;
  if (normalized.url !== undefined) out.url = redactBearerValues(normalized.url);
  if (normalized.statusCode !== undefined) out.statusCode = normalized.statusCode;
  if (normalized.cause !== undefined) {
    out.cause = redactNormalizedError(normalized.cause, ancestors, depth + 1);
  }
  return out;
}

function redactValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    return '[MaxDepthExceeded]';
  }

  if (value === null || value === undefined) {
    return value;
  }

  const type = typeof value;

  if (type === 'string') {
    return redactBearerValues(value as string);
  }
  if (type === 'number' || type === 'boolean') {
    return value;
  }
  if (type === 'bigint') {
    return `${(value as bigint).toString()}n`;
  }
  if (type === 'function') {
    return '[Function]';
  }
  if (type === 'symbol') {
    return (value as symbol).toString();
  }

  if (
    value instanceof Error ||
    (depth > 0 && type === 'object' && !Array.isArray(value) && isNormalizableError(value))
  ) {
    // Never serialize an error's arbitrary attached properties (DESIGN.md
    // §9.4's "most commonly missed leak path") — reduce to the narrow
    // normalized shape first, then redact that (harmless, but keeps this
    // function's guarantee absolute regardless of where an Error surfaces
    // in the tree: nested, in an array, or as a `cause`).
    // The `isNormalizableError` duck-type (shared with error-normalize.ts,
    // review finding R7) also catches a plain object that used to be an
    // Error but lost its prototype crossing a JSON/structuredClone
    // boundary — without this, `data`/`config`-style attached properties
    // on such an object would fall through to generic key-name redaction,
    // which only catches fields whose *name* looks sensitive.
    //
    // The duck-type check is gated to `depth > 0` deliberately: `redact()`'s
    // only production caller (logger.ts's `buildLine`) always passes the
    // *whole log line envelope* (`{time, level, ...bound, message, ...meta}`)
    // as the depth-0 root, and that envelope always carries a `message`
    // field by construction — so any meta key merely named `statusCode`,
    // `cause`, `status`, `request`, `response`, or `options` (e.g.
    // `logger.error('poll failed', { statusCode: 503, device_uid: 'x' })`)
    // previously made `isNormalizableError` match the *entire envelope*,
    // collapsing it to the narrow `{message, method?, url?, statusCode?,
    // cause?}` shape and silently discarding `time`, `level`, and every
    // bound field (`backend`, `device_uid`). A real error is never itself
    // the envelope; it always arrives nested under a key (`err`, `cause`)
    // or as an actual `Error` instance, which `instanceof Error` catches
    // unconditionally regardless of depth — so restricting the duck-type
    // branch to nested values closes this hole without weakening detection
    // of genuine nested/prototype-less errors.
    return redactNormalizedError(normalizeError(value), ancestors, depth);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (ArrayBuffer.isView(value)) {
    // A Buffer/TypedArray falls to the generic object branch below
    // otherwise, which walks it as an index-keyed object — every byte
    // becomes its own numeric property, so the original bytes (and any
    // secret they encode, e.g. a raw response body) are fully
    // recoverable from the "redacted" output (review finding R9).
    const byteLength = (value as { byteLength: number }).byteLength;
    const kind = value.constructor?.name ?? 'Buffer';
    return `[${kind} ${byteLength} bytes]`;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return '[Circular]';
    }
    ancestors.add(value);
    const out = value.map((item) => redactValue(item, ancestors, depth + 1));
    ancestors.delete(value);
    return out;
  }

  if (type === 'object') {
    const obj = value as Record<string, unknown>;
    if (ancestors.has(obj)) {
      return '[Circular]';
    }
    ancestors.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }

      let raw: unknown;
      try {
        raw = obj[key];
      } catch {
        // An own-enumerable throwing getter (review finding R1): losing
        // the whole log line to an unrelated getter bug is worse than a
        // placeholder — `redact()` must never throw.
        out[key] = '[Getter threw]';
        continue;
      }

      const lowerKey = key.toLowerCase();
      // Request headers are never logged wholesale (DESIGN.md §9.4): an
      // object or flat-pairs array under a `*headers`-suffixed key (not
      // just the literal name `headers` — review finding R4 covers
      // `responseHeaders`/`requestHeaders` too) is reduced to the
      // allowlist before the normal recursive redaction runs over what's
      // left, so an unlisted header is simply absent, not
      // present-and-redacted.
      if (lowerKey.endsWith('headers')) {
        if (isRecordValue(raw)) {
          out[key] = redactValue(filterHeaders(raw), ancestors, depth + 1);
          continue;
        }
        if (Array.isArray(raw)) {
          out[key] = redactValue(filterRawHeaderPairs(raw), ancestors, depth + 1);
          continue;
        }
      }
      // A URL/path string is sanitized at this same boundary (query-string
      // values redacted, keys kept) rather than trusting every call site to
      // have pre-sanitized it before handing it to the logger — the same
      // "boundary, not call site" rule §9.4 applies to headers and errors.
      if (URL_KEYS.has(lowerKey) && typeof raw === 'string') {
        out[key] = redactValue(sanitizeUrl(raw), ancestors, depth + 1);
        continue;
      }
      out[key] = redactValue(raw, ancestors, depth + 1);
    }
    ancestors.delete(obj);
    return out;
  }

  return String(value);
}

/** Deep-redacts `value`, returning a new JSON-serializable structure. Never throws. */
export function redact(value: unknown): unknown {
  return redactValue(value, new Set<object>(), 0);
}
