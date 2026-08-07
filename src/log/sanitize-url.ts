/**
 * Query-string VALUE redaction, keeping keys intact (DESIGN.md §9.4):
 * credentials sometimes land in query params, and the FMC filter string
 * embeds device UUIDs — both cases benefit from keeping the key
 * (`filter=`, `token=`) visible for debugging while hiding the value.
 *
 * Hand-rolled rather than built on `URL`/`URLSearchParams`: FMC filter
 * values use `:`/`;` as internal separators that are not valid
 * percent-encoded query syntax, and round-tripping them through
 * `URLSearchParams` would both mangle the input and percent-encode the
 * `[REDACTED]` placeholder into unreadable noise. A plain split on the
 * first `?` and first `=` per pair is sufficient and predictable.
 */

const REDACTED = '[REDACTED]';

/**
 * A query pair with no `=` (review finding R8, third bullet) still gets
 * redacted wholesale rather than left verbatim: `?SECRET` has no key to
 * preserve, so there is nothing useful to keep and no reason to treat it
 * differently from `?token=SECRET`.
 */
function sanitizeQueryPart(query: string): string {
  if (query === '') {
    return query;
  }
  return query
    .split('&')
    .map((pair) => {
      if (pair === '') {
        return pair;
      }
      const eq = pair.indexOf('=');
      if (eq === -1) {
        return REDACTED;
      }
      return `${pair.slice(0, eq)}=${REDACTED}`;
    })
    .join('&');
}

/**
 * Redacts `user:pass@` userinfo immediately after a `scheme://`, if
 * present — review finding R8: a `FMC_BASE_URL` with embedded basic-auth
 * credentials (`https://admin:SECRET@fmc.example.com/api`) is a
 * realistic operator mistake that config validation does not reject, so
 * the logger boundary must not trust the URL to be credential-free.
 */
function sanitizeUserinfo(raw: string): string {
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]+@/i, `$1${REDACTED}@`);
}

/**
 * Redacts a fragment's contents wholesale, keeping only the leading `#`.
 * OAuth-style implicit flows historically returned tokens in the
 * fragment (`#access_token=...`), and unlike a query string a fragment
 * has no server-visible "key" worth preserving for debugging — treating
 * it as an opaque credential-shaped blob is the safer default (review
 * finding R8, second bullet).
 */
function sanitizeFragment(fragment: string): string {
  return fragment.length > 1 ? `#${REDACTED}` : fragment;
}

/**
 * Redacts credential-shaped positions in `raw`, which may be a bare
 * query string (`?a=1`), a path with a query string
 * (`/api/v1/devices?a=1`), or a full absolute URL (userinfo and all).
 * Query keys are kept, query values are redacted; userinfo and fragment
 * contents are redacted wholesale (see the helpers above for why).
 */
export function sanitizeUrl(raw: string): string {
  const withoutUserinfo = sanitizeUserinfo(raw);

  const queryIndex = withoutUserinfo.indexOf('?');
  if (queryIndex === -1) {
    const hashIndex = withoutUserinfo.indexOf('#');
    if (hashIndex === -1) {
      return withoutUserinfo;
    }
    return `${withoutUserinfo.slice(0, hashIndex)}${sanitizeFragment(withoutUserinfo.slice(hashIndex))}`;
  }

  const base = withoutUserinfo.slice(0, queryIndex);
  const rest = withoutUserinfo.slice(queryIndex + 1);
  const hashIndex = rest.indexOf('#');
  const queryPart = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : rest.slice(hashIndex);
  return `${base}?${sanitizeQueryPart(queryPart)}${sanitizeFragment(fragment)}`;
}
