import type { Dispatcher } from 'undici';
import { createHttpClient } from '../../http/client.ts';
import type { Clock } from '../../http/clock.ts';
import { isPlainObject, readOptionalString } from '../shared/numbers.ts';

/**
 * Domain UUID resolution (DESIGN.md §3.3.1), in the documented order:
 *
 * 1. Explicit `FMC_DOMAIN_UUID` config value — always wins when set.
 * 2. The `DOMAIN_UUID` response header from `generatetoken`/`refreshtoken`
 *    (Appendix C confirms this header is present on every real auth
 *    response observed against the lab FMC).
 * 3. `GET /api/fmc_platform/v1/info/domain` as an enumeration fallback.
 *
 * Deliberate deviation from DESIGN.md's listed order: the doc's step 2 also
 * mentions "extract it from the claims inside the access token" as an
 * alternative to the header. This module does not implement JWT-claim
 * decoding — Appendix C's live verification found the `DOMAIN_UUID` header
 * reliably present on the same response that carries the access token, so
 * decoding the token's own claims would be strictly redundant work solving
 * a problem Appendix C shows does not occur in practice. If a future FMC
 * version or a reverse proxy strips `DOMAIN_UUID` while still returning
 * `X-auth-access-token`, this falls through to the `GET .../info/domain`
 * enumeration fallback (step 3) rather than attempting claim decoding.
 */

export interface ResolveDomainUuidOptions {
  configuredDomainUuid: string | undefined;
  domainUuidHeader: string | undefined;
  dispatcher: Dispatcher;
  host: string;
  accessToken: string;
  clock: Clock;
  requestTimeoutMs?: number;
  /** Attached to the fallback GET's `beforeAttempt` — this call still counts against FMC's 300/min GET budget (DESIGN.md §3.3.4) even though it is a rare, one-time-at-startup fallback. */
  beforeAttempt?: () => Promise<void>;
}

interface FmcDomainInfoItem {
  uuid?: string;
  name?: string;
}

function parseDomainInfoItems(body: string): FmcDomainInfoItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) {
    return [];
  }
  const items: FmcDomainInfoItem[] = [];
  for (const raw of parsed.items) {
    if (!isPlainObject(raw)) continue;
    const uuid = readOptionalString(raw, 'uuid');
    const name = readOptionalString(raw, 'name');
    items.push({
      ...(uuid.ok && uuid.value !== undefined ? { uuid: uuid.value } : {}),
      ...(name.ok && name.value !== undefined ? { name: name.value } : {}),
    });
  }
  return items;
}

/**
 * The enumeration-fallback GET call (step 3). Only reached when neither an
 * explicit config value nor the auth response header resolved a domain
 * UUID. Prefers an item literally named "Global" (the always-present root
 * domain per DESIGN.md §3.3.1); otherwise falls back to the first item.
 */
async function fetchDomainViaInfoEndpoint(
  options: ResolveDomainUuidOptions,
): Promise<string | undefined> {
  const client = createHttpClient({
    dispatcher: options.dispatcher,
    clock: options.clock,
    defaultTimeoutMs: options.requestTimeoutMs ?? 30_000,
  });
  try {
    const response = await client.get(`https://${options.host}/api/fmc_platform/v1/info/domain`, {
      endpoint: '/api/fmc_platform/v1/info/domain',
      headers: { 'X-auth-access-token': options.accessToken },
      ...(options.beforeAttempt !== undefined && { beforeAttempt: options.beforeAttempt }),
    });
    const items = parseDomainInfoItems(response.body);
    const global = items.find((item) => item.name === 'Global');
    return global?.uuid ?? items[0]?.uuid;
  } catch {
    return undefined;
  }
}

export async function resolveDomainUuid(
  options: ResolveDomainUuidOptions,
): Promise<string | undefined> {
  if (options.configuredDomainUuid !== undefined) {
    return options.configuredDomainUuid;
  }
  if (options.domainUuidHeader !== undefined) {
    return options.domainUuidHeader;
  }
  return fetchDomainViaInfoEndpoint(options);
}
