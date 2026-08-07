import type { Dispatcher } from 'undici';
import type { Secret } from '../../config/secret.ts';
import type { Clock } from '../../http/clock.ts';
import { classifyStatusCode, HttpError } from '../../http/errors.ts';
import type { Logger } from '../../log/logger.ts';
import { authTransportRequest } from './auth-transport.ts';

/**
 * The FMC token lifecycle state machine (DESIGN.md §3.3.2). See the
 * implementation plan's Stage 8 risk note for the three race hazards this
 * is designed against:
 *
 * (a) a refresh completing while other requests hold the *old* token, each
 *     401ing and each independently calling `forceReauth()` — mitigated by
 *     routing `forceReauth()` through the same single-flight gate as
 *     `getToken()`'s own proactive refresh, so N concurrent 401s still
 *     produce exactly one `generatetoken`.
 * (b) two concurrent refreshes double-incrementing the refresh counter —
 *     mitigated the same way: `refreshCount` is only ever mutated inside
 *     `doRefreshToken`/`doGenerateToken`, which only ever run inside the
 *     single-flight critical section (`acquireSingleFlight`), never
 *     directly from `getToken()`.
 * (c) a failed refresh leaving the manager with neither token and no
 *     recovery path — mitigated by `doRefreshToken` falling back to a full
 *     `doGenerateToken` on any non-204 refresh response, rather than
 *     leaving `state.accessToken`/`state.refreshToken` cleared with
 *     nothing to retry them.
 *
 * `acquireSingleFlight` reserves its slot (`inFlight = promise`)
 * synchronously, in the same tick as the check that decided to acquire —
 * the same "reserve before any await" discipline as `createSpacingGuard`
 * (spacing.ts) — so N callers invoked back-to-back with no intervening
 * await (e.g. `Promise.all(calls.map(() => tm.getToken()))`) all observe
 * the first caller's in-flight promise rather than each starting their
 * own request.
 *
 * Two additional hazards found by Opus review of the Stage 8 adapter's
 * fan-out (not just this module in isolation):
 *
 * (d) **hot-loop on genuinely bad credentials.** The single-flight gate
 *     above only collapses callers that overlap in the same tick/critical
 *     section. When N device requests fail with 401 *staggered over time*
 *     (spread out by the concurrency limiter), each one calls
 *     `forceReauth()` well after the previous `forceReauth()` attempt has
 *     already settled — so single-flight has nothing to join, and each
 *     independently issues its own `generatetoken` POST. If credentials
 *     are actually bad, every one of those POSTs 401s, which is a hot loop
 *     against DESIGN.md §2.5's explicit "auth — likely fatal → keep
 *     running, do NOT hot-loop." Fixed with `credentialsFailure`: the
 *     first `generatetoken` call that itself comes back 401/403 latches a
 *     stored `HttpError`, and every subsequent `getToken()`/`forceReauth()`
 *     rejects immediately with that same error, with no further network
 *     call, until the token manager is recreated (this is deliberately
 *     permanent for the process lifetime of this manager instance — no
 *     in-process recovery path, per the plan's "keep it simple" guidance).
 * (e) **login storm from staggered mid-session 401s that are not actually
 *     bad credentials.** Even with a healthy account, N staggered
 *     `forceReauth()` calls that each still hold the token that was
 *     *already* superseded by an earlier caller's successful reauth would,
 *     without care, each trigger their own redundant `generatetoken`. Fixed
 *     by having `forceReauth(staleToken)` take the token the caller was
 *     using when it got its 401: if `state.accessToken` has already moved
 *     on from `staleToken` (i.e. a newer login already completed), the call
 *     just returns the current token with no network request at all; a
 *     real `generatetoken` only fires when the caller's stale token is
 *     still the manager's current one.
 */

const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const PROACTIVE_REFRESH_FRACTION = 0.8;
const PROACTIVE_REFRESH_MS = TOKEN_LIFETIME_MS * PROACTIVE_REFRESH_FRACTION;
const MAX_REFRESHES = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface FmcTokenManagerOptions {
  dispatcher: Dispatcher;
  host: string;
  username: string;
  password: Secret;
  clock: Clock;
  logger: Logger;
  requestTimeoutMs?: number;
  onTokenRefresh?: () => void;
  onTokenReauth?: () => void;
  /** Unix seconds. Fired every time a new access token's expiry is established (initial login, refresh, or forced re-auth). */
  onTokenExpiryUpdate?: (expiryUnixSeconds: number) => void;
}

export interface FmcTokenManager {
  /** Resolves to a valid access token, transparently logging in, proactively refreshing, or forcing a full re-auth as needed. */
  getToken(): Promise<string>;
  /** The `DOMAIN_UUID` response header captured from the most recent `generatetoken`/`refreshtoken` call, if any (DESIGN.md §3.3.1). */
  getDomainUuidHeader(): string | undefined;
  /**
   * Discards the current token pair and forces a full `generatetoken`,
   * sharing the same single-flight gate as `getToken()`'s proactive
   * refresh. The DESIGN.md §3.3.2 "on an unexpected 401, force re-auth and
   * retry the failed request once" behavior: the adapter calls this once
   * per unexpected 401 on a device request, then retries that one request
   * with the fresh token. The adapter — not this method — is responsible
   * for not looping on a second consecutive 401.
   *
   * `staleToken` must be the access token the caller was using when it
   * received the 401 that triggered this call (review finding F2). If the
   * manager's current token has already moved on from `staleToken` — i.e.
   * some other caller's reauth already completed — this call returns the
   * current token immediately with no network request, rather than
   * launching a redundant `generatetoken`. A real login only happens when
   * `staleToken` is still the manager's current token.
   */
  forceReauth(staleToken: string): Promise<string>;
  /** Drops tokens from memory. Idempotent. Does not close the shared `dispatcher` (the adapter owns that). */
  close(): void;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface TokenState {
  accessToken: string | undefined;
  refreshToken: string | undefined;
  domainUuidHeader: string | undefined;
  refreshCount: number;
  /** Monotonic (`clock.now()`) instant at which the next proactive refresh should fire. */
  proactiveRefreshAt: number | undefined;
  hasEverAuthenticated: boolean;
}

export function createFmcTokenManager(options: FmcTokenManagerOptions): FmcTokenManager {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const state: TokenState = {
    accessToken: undefined,
    refreshToken: undefined,
    domainUuidHeader: undefined,
    refreshCount: 0,
    proactiveRefreshAt: undefined,
    hasEverAuthenticated: false,
  };
  let inFlight: Promise<string> | undefined;
  let closed = false;
  /** Latched once a `generatetoken` (login, not a mid-session device 401) itself returns 401/403 — see the module doc comment's hazard (d). Permanent for this manager instance until `close()`; there is no automatic recovery. */
  let credentialsFailure: HttpError | undefined;

  function basicAuthHeader(): string {
    return `Basic ${Buffer.from(`${options.username}:${options.password.reveal()}`).toString('base64')}`;
  }

  function applySuccessfulAuth(headers: Record<string, string | string[] | undefined>): string {
    const accessToken = firstHeaderValue(headers['x-auth-access-token']);
    if (accessToken === undefined) {
      throw new HttpError({
        class: 'auth_fatal',
        reason: 'auth',
        message:
          'FMC auth response (204) is missing the X-auth-access-token header — check for a ' +
          'reverse proxy or load balancer stripping response headers between the exporter and FMC',
      });
    }
    const refreshToken = firstHeaderValue(headers['x-auth-refresh-token']);
    const domainUuid = firstHeaderValue(headers.domain_uuid ?? headers.DOMAIN_UUID);

    state.accessToken = accessToken;
    state.refreshToken = refreshToken;
    if (domainUuid !== undefined) {
      state.domainUuidHeader = domainUuid;
    }

    const expiryWallMs = options.clock.wallNow() + TOKEN_LIFETIME_MS;
    state.proactiveRefreshAt = options.clock.now() + PROACTIVE_REFRESH_MS;
    options.onTokenExpiryUpdate?.(Math.floor(expiryWallMs / 1000));

    return accessToken;
  }

  async function doGenerateToken(isReauth: boolean): Promise<string> {
    const response = await authTransportRequest({
      dispatcher: options.dispatcher,
      host: options.host,
      path: '/api/fmc_platform/v1/auth/generatetoken',
      headers: { authorization: basicAuthHeader() },
      timeoutMs: requestTimeoutMs,
    });

    if (response.statusCode !== 204) {
      const error = classifyStatusCode(response.statusCode);
      options.logger.error(
        'FMC generatetoken failed — verify FMC_USERNAME/FMC_PASSWORD are correct for a ' +
          'dedicated API-only service account (DESIGN.md §3.3.2: a human admin account used ' +
          'simultaneously via the UI and the API will intermittently 401 here). The exporter ' +
          'will keep running but this poll produced no FMC data.',
        { statusCode: response.statusCode, reason: error.reason },
      );
      // Review finding F1: a *login* attempt itself (not a mid-session
      // device-request 401) failing with auth_fatal means credentials are
      // known-bad — latch that so every subsequent getToken()/forceReauth()
      // fails fast without another generatetoken POST, rather than letting
      // N independently-401ing device requests each trigger their own.
      if (error.class === 'auth_fatal') {
        credentialsFailure = error;
      }
      throw error;
    }

    const accessToken = applySuccessfulAuth(response.headers);
    state.refreshCount = 0;
    state.hasEverAuthenticated = true;
    if (isReauth) {
      options.onTokenReauth?.();
    }
    return accessToken;
  }

  async function doRefreshToken(): Promise<string> {
    const accessToken = state.accessToken;
    const refreshToken = state.refreshToken;
    if (accessToken === undefined || refreshToken === undefined) {
      // No refresh token to present — nothing to refresh with. Fall back
      // to a full login rather than throwing (risk hazard (c): never leave
      // the manager with no recovery path).
      return doGenerateToken(true);
    }

    const response = await authTransportRequest({
      dispatcher: options.dispatcher,
      host: options.host,
      path: '/api/fmc_platform/v1/auth/refreshtoken',
      headers: {
        'X-auth-access-token': accessToken,
        'X-auth-refresh-token': refreshToken,
      },
      timeoutMs: requestTimeoutMs,
    });

    if (response.statusCode !== 204) {
      // Risk hazard (c): a failed refresh must not leave the manager
      // holding a refresh token that is now known-bad with no path
      // forward. Discard state and fall back to a full re-auth rather
      // than throwing — the alternative is a manager that can never
      // recover without a process restart.
      state.accessToken = undefined;
      state.refreshToken = undefined;
      return doGenerateToken(true);
    }

    const newAccessToken = applySuccessfulAuth(response.headers);
    state.refreshCount += 1;
    options.onTokenRefresh?.();
    return newAccessToken;
  }

  function acquireSingleFlight(factory: () => Promise<string>): Promise<string> {
    if (inFlight !== undefined) {
      return inFlight;
    }
    const promise = factory().finally(() => {
      if (inFlight === promise) {
        inFlight = undefined;
      }
    });
    inFlight = promise;
    return promise;
  }

  return {
    async getToken(): Promise<string> {
      if (closed) {
        throw new Error('FmcTokenManager.getToken() called after close()');
      }
      if (credentialsFailure !== undefined) {
        throw credentialsFailure;
      }
      if (state.accessToken === undefined) {
        return acquireSingleFlight(() => doGenerateToken(state.hasEverAuthenticated));
      }
      const now = options.clock.now();
      if (state.proactiveRefreshAt !== undefined && now >= state.proactiveRefreshAt) {
        return acquireSingleFlight(() =>
          state.refreshCount < MAX_REFRESHES ? doRefreshToken() : doGenerateToken(true),
        );
      }
      return state.accessToken;
    },

    getDomainUuidHeader(): string | undefined {
      return state.domainUuidHeader;
    },

    async forceReauth(staleToken: string): Promise<string> {
      if (closed) {
        throw new Error('FmcTokenManager.forceReauth() called after close()');
      }
      if (credentialsFailure !== undefined) {
        throw credentialsFailure;
      }
      // A login/refresh already in flight must be joined, not raced —
      // checking `state.accessToken` here would be unsafe, since the
      // in-flight factory below clears it synchronously before its first
      // await (review finding F2's ordering hazard).
      if (inFlight !== undefined) {
        return inFlight;
      }
      // The caller's token has already been superseded by a login that
      // completed since it captured `staleToken` — hand back the current
      // token with no network request at all, rather than triggering a
      // redundant `generatetoken` (review finding F2).
      if (state.accessToken !== undefined && state.accessToken !== staleToken) {
        return state.accessToken;
      }
      // Cleared inside the factory, not before the single-flight check —
      // if a refresh/login is already in flight, this call must join it
      // rather than clearing state out from under it (that in-flight
      // operation already captured whatever token values it needed
      // before its first await).
      return acquireSingleFlight(() => {
        state.accessToken = undefined;
        state.refreshToken = undefined;
        return doGenerateToken(true);
      });
    },

    close(): void {
      closed = true;
      state.accessToken = undefined;
      state.refreshToken = undefined;
    },
  };
}
