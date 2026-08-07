import type { Dispatcher } from 'undici';
import { request as undiciRequest } from 'undici';

/**
 * A narrow, private, auth-only transport for FMC's two `POST` endpoints
 * (DESIGN.md §3.3.2, §9.5; IMPLEMENTATION_PLAN.md Stage 8 scope).
 *
 * §9.5 exemption: "The exporter must never issue a non-GET request...
 * enforced in the HTTP client layer, which exposes only a `get()` method,
 * so a write is not merely discouraged but unrepresentable." FMC's auth
 * protocol genuinely requires `POST` — `generatetoken` and `refreshtoken`
 * have no GET equivalent — which "sits awkwardly" (IMPLEMENTATION_PLAN.md's
 * own phrase) with that rule. Rather than adding a general `post()` method
 * to `src/http/client.ts` (which would make a write representable for
 * every future call site, defeating the whole point of §9.5), this module
 * is a deliberately separate, minimal transport that can reach exactly the
 * two auth paths below and nothing else. The `path` parameter is typed as
 * a two-member string-literal union specifically so a third path is a
 * compile error, not just a runtime convention; `authTransportRequest`
 * additionally asserts this at runtime (belt-and-suspenders, since a
 * caller could still construct the union value dynamically) and always
 * issues `POST`. `src/http/client.ts` remains GET-only and this file is
 * the only place in the codebase that imports `undici`'s `request` for a
 * non-GET call.
 *
 * Does not go through `src/http/retry.ts`/`withRetry` — a login/refresh
 * call has different retry semantics than a data request (DESIGN.md
 * §2.5's "auth — recoverable" vs "auth — likely fatal" split is handled by
 * `FmcTokenManager` itself, which decides whether to retry a
 * `generatetoken` at all, not by a generic transient-error retry loop).
 */

export const AUTH_PATHS = [
  '/api/fmc_platform/v1/auth/generatetoken',
  '/api/fmc_platform/v1/auth/refreshtoken',
] as const;

export type AuthPath = (typeof AUTH_PATHS)[number];

export interface AuthTransportRequestOptions {
  dispatcher: Dispatcher;
  host: string;
  path: AuthPath;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface AuthTransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
}

function isAuthPath(path: string): path is AuthPath {
  return (AUTH_PATHS as readonly string[]).includes(path);
}

/**
 * Issues exactly one `POST` to `https://{host}{path}` with no body. Throws
 * synchronously (before any network I/O) if `path` is not one of
 * `AUTH_PATHS` — the runtime half of the "rejects any other path or
 * method" guarantee the plan's testing step 10 asks for. There is no
 * parameter through which a caller could request a different HTTP method;
 * that is the compile-time half.
 */
export async function authTransportRequest(
  options: AuthTransportRequestOptions,
): Promise<AuthTransportResponse> {
  if (!isAuthPath(options.path)) {
    throw new Error(
      `authTransportRequest: "${options.path}" is not a permitted FMC auth path (DESIGN.md §9.5 exemption boundary) — only ${AUTH_PATHS.join(', ')} are allowed`,
    );
  }

  const url = `https://${options.host}${options.path}`;
  const signal = AbortSignal.timeout(options.timeoutMs);
  const response = await undiciRequest(url, {
    method: 'POST',
    headers: options.headers,
    dispatcher: options.dispatcher,
    signal,
  });
  // Drain the body even though generatetoken/refreshtoken return no
  // content — an unconsumed undici response body keeps the connection
  // from being reused/released back to the pool.
  await response.body.text();

  return { statusCode: response.statusCode, headers: response.headers };
}
