import { createBackend } from './backend-factory.ts';
import type { AppConfig } from './config/types.ts';
import { createRealClock } from './http/clock.ts';
import type { Logger } from './log/logger.ts';
import { Sanitizer, sanitize } from './util/sanitize.ts';

/**
 * `--dump-raw` (DESIGN.md §3.3.5, plan Stage 11 scope): performs one poll's
 * worth of upstream requests through the real adapter, and writes the raw
 * upstream JSON bodies to stdout — sanitized by default — so a contributor
 * can capture real FMC/SCC responses and hand them over as a test fixture
 * (`test/fixtures/README.md`) without ever sharing credentials.
 *
 * Deliberately reuses `createBackend` (the same construction path
 * `index.ts` uses for the real poll-cache-serve run) rather than a bespoke
 * one-shot HTTP call: the whole point is that a captured fixture reflects
 * exactly what the real adapter sends and receives (auth, discovery,
 * filter-building included), not a hand-rolled approximation of it.
 *
 * Writes nothing to disk (DESIGN.md §9.3) — stdout only, and the caller
 * (index.ts) is responsible for exiting after this resolves. Raw bodies
 * are still redaction-adjacent data (device names, IPs, topology), so this
 * module's own sanitization pass — not `src/log/redact.ts`, which is
 * scoped to structured log lines (allowlisted headers, error-shape
 * collapsing) and would neither recognize an upstream wire field like
 * `links.self` nor apply the UUID/IPv4 sweep this fixture-contribution
 * workflow specifically needs — is the one sanctioned path for what
 * reaches stdout here.
 *
 * An independent Stage 11 review found this mode's *response body* is
 * captured on every status code (via `onRawResponse`/`onFmcRawResponse`,
 * wired all the way down through `src/http/client.ts`), including a 4xx/5xx
 * error body — often the single most useful capture for a contributor
 * (Cisco's own `error.messages[].description`, a wrong-domain-UUID 404).
 * The three sanitization gaps that same review found (a credential-shaped
 * value under a field name the generic UUID/IPv4 sweep never touches, e.g.
 * `links.self` embedding an `access_token` query parameter or `user:pass@`
 * userinfo; the fail-open path for a non-JSON body passing through
 * untouched; and no runtime warning matching DESIGN.md §3.3.5's explicit
 * requirement) are what `redactCredentialShapedValues`/
 * `redactCredentialShapedText` below close.
 */

export interface DumpRawOptions {
  config: AppConfig;
  logger: Logger;
  /** Test hook: defaults to `process.stdout.write`. */
  write?: (chunk: string) => void;
  /** Opt-out of sanitization, per the plan's "with an opt-out" note — the operator is asserting the capture is already safe to share raw. Defaults to `false` (sanitize). */
  skipSanitize?: boolean;
}

interface CapturedResponse {
  backend: 'scc' | 'fmc';
  deviceId?: string;
  family?: string;
  statusCode: number;
  body: unknown;
}

/**
 * Key names (normalized: lowercased, `-`/`_` stripped) whose *entire value*
 * is replaced regardless of what it looks like — deliberately broader than
 * `src/log/redact.ts`'s log-line-scoped list (no `SAFE_METADATA_*`
 * exemptions here: DESIGN.md §3.3.5 explicitly prefers over-sanitizing an
 * arbitrary upstream field over under-sanitizing a real credential in an
 * artifact that leaves the operator's environment entirely).
 */
// Deliberately NOT including a bare "session" pattern: FMC's still-unverified
// RA VPN group (DESIGN.md §14.1, Appendix B) uses field names like
// `raVpnSessionHealthMetrics`/`activeRavpnSessionsAvg` — exactly the data
// --dump-raw exists to capture — which a bare "session" substring match
// would wholesale-redact. "cookie" already covers the realistic session-
// credential leak shape (an HTTP Set-Cookie/Cookie value).
const CREDENTIAL_KEY_PATTERNS = [
  'token',
  'password',
  'passwd',
  'pwd',
  'secret',
  'credential',
  'apikey',
  'bearer',
  'cookie',
  'community',
  'privatekey',
  'authorization',
] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function isCredentialShapedKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return CREDENTIAL_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

const REDACTED = '[REDACTED]';
const BEARER_VALUE_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
/**
 * A key=value pair whose key names a credential, inside an arbitrary blob
 * of text (query string, Cookie header, HTML) — matches up to the next
 * `&`, `;`, whitespace, or quote. Deliberately a separate, wider list from
 * `CREDENTIAL_KEY_PATTERNS`: this pattern only ever runs against a body
 * that failed to parse as JSON (an HTML/plaintext error page), where there
 * is no risk of colliding with a real JSON field name like FMC's
 * `raVpnSessionHealthMetrics` — the false-positive `CREDENTIAL_KEY_PATTERNS`
 * itself must avoid (see its own comment). "session" is included here
 * because an HTML SSO interstitial's `session=<value>` is a realistic,
 * concrete leak shape that shows up in free text, not JSON structure.
 */
const CREDENTIAL_TEXT_KEY_PATTERNS = [...CREDENTIAL_KEY_PATTERNS, 'session'] as const;
const CREDENTIAL_TEXT_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_TEXT_KEY_PATTERNS.join('|')})([a-z0-9_-]*)\\s*[:=]\\s*[^&;\\s"']+`,
  'gi',
);
/** `scheme://user:pass@host` — the same userinfo shape `src/log/sanitize-url.ts` guards against, applied generically here rather than only to fields literally named `url`/`path`, since the field this actually shows up on in practice is `links.self`. */
const URL_USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]+@/i;
const LOOKS_LIKE_URL_PATTERN = /:\/\//;

/**
 * Redacts a credential-shaped *value* embedded in free text — the fallback
 * path for a body that failed to parse as JSON (an HTML SSO interstitial,
 * a plaintext error page), where there is no object structure to walk by
 * key name. `Bearer <token>` and `key=value`/`key:value` pairs whose key
 * names a credential (`session=...`, `token: ...`) are both covered.
 */
function redactCredentialShapedText(text: string): string {
  return text
    .replace(BEARER_VALUE_PATTERN, `Bearer ${REDACTED}`)
    .replace(
      CREDENTIAL_TEXT_PATTERN,
      (_match, key: string, suffix: string) => `${key}${suffix}=${REDACTED}`,
    );
}

/**
 * Redacts a URL string's userinfo and every query-string *value* (keys are
 * kept — a `filter=` or `offset=` parameter is useful debugging context and
 * carries no secret) — mirrors `src/log/sanitize-url.ts`'s approach but
 * applied to any string that looks URL-shaped, not just fields keyed
 * `url`/`path`, since the field that actually needs this in an upstream
 * response body is `links.self`.
 */
function redactUrlShapedString(value: string): string {
  if (!LOOKS_LIKE_URL_PATTERN.test(value)) {
    return value;
  }
  const withoutUserinfo = value.replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`);
  const queryIndex = withoutUserinfo.indexOf('?');
  if (queryIndex === -1) {
    return withoutUserinfo;
  }
  const base = withoutUserinfo.slice(0, queryIndex);
  const query = withoutUserinfo.slice(queryIndex + 1);
  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? pair : `${pair.slice(0, eq)}=${REDACTED}`;
    })
    .join('&');
  return `${base}?${redactedQuery}`;
}

/**
 * Deep-walks a parsed JSON value, redacting every credential-shaped key's
 * value wholesale and every URL-shaped string's userinfo/query values —
 * applied *before* the UUID/IPv4 `Sanitizer` sweep in `dumpRaw` below, so a
 * value this pass replaces with `[REDACTED]` is never itself re-swept as
 * though it were a real identifier.
 */
function redactCredentialShapedValues(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactUrlShapedString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentialShapedValues(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isCredentialShapedKey(key) ? REDACTED : redactCredentialShapedValues(val);
    }
    return out;
  }
  return value;
}

/**
 * Runs one `fetchSnapshot()` cycle against a freshly constructed backend,
 * capturing every raw response body seen along the way via the adapters'
 * `onRawResponse`/`onFmcRawResponse` hooks (added in Stage 11 specifically
 * for this mode — the normal poll path never sets them). Fires on every
 * status code the client actually receives a response for (see
 * `src/http/client.ts`'s `onRawResponse`), not only 2xx — a 4xx/5xx error
 * body is frequently the most useful capture a contributor can offer.
 */
export async function dumpRaw(options: DumpRawOptions): Promise<void> {
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const captured: CapturedResponse[] = [];
  let sawUnparseableBody = false;

  function parseBody(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      sawUnparseableBody = true;
      return { unparseableRawBody: options.skipSanitize ? body : redactCredentialShapedText(body) };
    }
  }

  const backend = createBackend({
    config: options.config,
    clock: createRealClock(),
    logger: options.logger,
    pollIntervalSeconds: options.config.pollIntervalSeconds,
    hooks:
      options.config.backend.kind === 'scc'
        ? {
            onRawResponse: (statusCode: number, body: string) => {
              captured.push({ backend: 'scc', statusCode, body: parseBody(body) });
            },
          }
        : {
            onFmcRawResponse: (
              deviceId: string,
              family: string,
              statusCode: number,
              body: string,
            ) => {
              captured.push({
                backend: 'fmc',
                deviceId,
                family,
                statusCode,
                body: parseBody(body),
              });
            },
          },
  });

  // DESIGN.md §3.3.5's explicit requirement: this mode's output may still
  // contain device names and topology detail even after sanitization
  // (structural values like interface hardware ids are deliberately never
  // touched — see util/sanitize.ts) — a startup log line satisfies "the
  // docs must warn," matching how DESIGN.md §9.6 treats the equivalent
  // TLS-insecure warning as something that must be visible at the point of
  // use, not only in --help text a --dump-raw user may never read.
  options.logger.warn(
    'dump-raw: capturing raw upstream responses. Credential-shaped fields and identifiers ' +
      '(UUIDs, IPv4 addresses) are sanitized by default, but device names, hostnames, and ' +
      'topology detail are NOT — review the output before sharing it publicly.',
  );

  // `fetchSnapshot()` itself can still throw (the SCC adapter throws on a
  // total single-request failure, unlike FMC's per-device isolation) —
  // captured responses (a 404/500 error body is often the very thing a
  // contributor wants to share) must still reach `write()` below even
  // then, so the throw is swallowed here and rethrown only after the
  // output has been written; not swallowing it entirely, since a caller
  // (index.ts) still needs to know the capture cycle failed.
  let fetchError: unknown;
  try {
    await backend.init();
    await backend.fetchSnapshot();
  } catch (cause) {
    fetchError = cause;
  } finally {
    await backend.close();
  }

  if (sawUnparseableBody && !options.skipSanitize) {
    options.logger.warn(
      'dump-raw: at least one response body was not valid JSON — it received only pattern-based ' +
        '(not structural) credential redaction. Review it manually before sharing.',
    );
  }

  const sanitizer = new Sanitizer();
  const output = captured.map((entry) => {
    const credentialSafeBody = options.skipSanitize
      ? entry.body
      : redactCredentialShapedValues(entry.body);
    return {
      backend: entry.backend,
      ...(entry.deviceId !== undefined && {
        deviceId: options.skipSanitize ? entry.deviceId : sanitizer.sanitize(entry.deviceId),
      }),
      ...(entry.family !== undefined && { family: entry.family }),
      statusCode: entry.statusCode,
      body: options.skipSanitize ? credentialSafeBody : sanitizer.sanitize(credentialSafeBody),
    };
  });

  write(`${JSON.stringify(output, null, 2)}\n`);

  if (fetchError !== undefined) {
    throw fetchError;
  }
}

// Re-exported so a caller (or a test proving "output round-trips") can
// sanitize an already-captured value with the exact same logic without
// re-running a full dumpRaw() cycle.
export { sanitize };
