import type { Dispatcher } from 'undici';
import { createHttpClient } from '../../http/client.ts';
import type { Clock } from '../../http/clock.ts';
import { isPlainObject, readOptionalString } from '../shared/numbers.ts';

/**
 * FMC device discovery (DESIGN.md §3.3.3): `GET .../devices/devicerecords`
 * with explicit client-side `offset`/`limit` pagination — FMC returns **no
 * paging headers**, so the only reliable end-of-list signal is a page
 * shorter than a full page (plan testing step 13: an exactly-full-sized
 * final page must not be treated as "more to come"; the loop must issue
 * one further request and see an empty page).
 *
 * "Full page" is judged against the response body's own `paging.limit`
 * when present, not blindly against the `limit` this client requested
 * (`PAGE_LIMIT`) — the synthetic `paginated-40-devices-*.json` fixtures
 * (test/fixtures/fmc/) model a server that caps its own page size at 25
 * regardless of the requested `limit`, matching DESIGN.md §3.3.3's stated
 * *default* page size. If this client trusted its own requested
 * `PAGE_LIMIT` (1000) as the short-page threshold, a server capping
 * responses at 25 would make every page "look short" relative to 1000,
 * and the loop would stop after page one — silently truncating at 25,
 * exactly the naive-implementation bug DESIGN.md §3.3.3 and §12.2 warn
 * about, just relocated from "forgot to paginate" to "trusted the wrong
 * page-size signal." The offset is likewise advanced by the number of
 * items actually returned, not by the requested `PAGE_LIMIT`, for the
 * same reason.
 *
 * Opus review of this stage found four more hazards in this same
 * termination logic:
 *
 * - (F3) `reportedLimit` of `0` (a server that echoes back a nonsensical
 *   `paging.limit: 0`) made the short-page check `0 < 0` false, so the
 *   loop never terminated via a short page and instead spun through
 *   `maxPages`. `reportedLimit` is now trusted only when it is a positive
 *   number; a non-positive value falls back to `PAGE_LIMIT`. As
 *   defense-in-depth, a page with zero raw items is *always* treated as
 *   short/terminal regardless of what `reportedLimit` says — an empty page
 *   can never have more devices after it, and trusting a bogus limit here
 *   would otherwise re-request the same offset forever.
 * - (F4) a server that echoes back the *requested* `limit` (e.g. 1000)
 *   rather than the page size it actually honors (e.g. 25) makes every
 *   non-final page look "short" relative to that echoed limit, silently
 *   truncating discovery at page one. `paging.count` (the server's own
 *   total-result count) is now compared against the running total of raw
 *   items seen; if a page looks short by the `reportedLimit` heuristic but
 *   the running total hasn't reached `paging.count` yet, pagination
 *   continues anyway (offset advances by the actual item count received,
 *   which is always safe regardless of what any `limit` field claims). If
 *   the loop still terminates without reaching `paging.count` (e.g. an
 *   empty page arrives with devices still missing per the server's own
 *   count), that is a genuine anomaly and is surfaced via `onWarning`
 *   rather than silently returned as a complete list.
 * - (F6) one malformed item (missing/wrong-typed `id`) used to throw and
 *   abort the *entire* page/list, discarding every valid device alongside
 *   it. Malformed items are now skipped individually (with an `onWarning`
 *   diagnostic), mirroring the group-skip-not-list-abort pattern used by
 *   the SCC/FMC response mappers elsewhere in this codebase.
 * - (F7) an item with `name: ""` produced a device with an empty
 *   `deviceName` label reaching the renderer. A present-but-empty (or
 *   whitespace-only) name now falls back to the device's `id`, which is
 *   always a well-formed non-empty UUID.
 */

const PAGE_LIMIT = 1000;
/** Sanity cap on total pages (plan scope) — aborts rather than looping forever against a misbehaving server that always returns a full page. At PAGE_LIMIT=1000 this bounds discovery at 1,000,000 devices. */
const DEFAULT_MAX_PAGES = 1000;

export interface FmcDiscoveredDevice {
  id: string;
  name: string;
  isConnected?: boolean;
}

export interface FetchDeviceRecordsOptions {
  dispatcher: Dispatcher;
  host: string;
  domainUuid: string;
  accessToken: string;
  clock: Clock;
  requestTimeoutMs?: number;
  maxPages?: number;
  /** Attached to each page GET's `beforeAttempt` — discovery pages still count against FMC's 300/min GET budget (DESIGN.md §3.3.4), even though discovery itself runs on a slower cadence. */
  beforeAttempt?: () => Promise<void>;
  /** Fired for individual malformed items skipped within an otherwise-valid page (F6/F7), and for a detected-but-not-recoverable truncation anomaly (F4: the server's own `paging.count` says more devices exist than pagination was able to retrieve). Non-fatal — discovery keeps going. */
  onWarning?: (message: string) => void;
}

interface RawDeviceRecordsPage {
  /** Only valid items (F6: malformed items are filtered out here, not left for the caller to re-check) — `name` is always non-empty (F7: falls back to `id` when absent/blank). */
  items: Array<{
    id: string;
    name: string;
    isConnected: boolean | undefined;
  }>;
  /** The server's own reported page size, when present — see the module doc comment on why this (not the client's requested `PAGE_LIMIT`) governs the short-page termination check. */
  reportedLimit: number | undefined;
  /** The server's own reported total-result count (`paging.count`), when present — used to detect silent truncation (F4). */
  reportedCount: number | undefined;
  /** The number of raw item *slots* the server actually sent on this page, before any per-item validation — this, not `items.length`, is what pagination offset/short-page decisions must be based on (an item skipped for being malformed is still a slot the server counted in `paging.limit`/`paging.count`). */
  rawItemCount: number;
  /** Diagnostics for individual malformed items on this page (F6) — the caller decides how to surface these; the page's valid items are still returned. */
  itemWarnings: string[];
}

function parseDeviceRecordsPage(body: string): RawDeviceRecordsPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error(`FMC devicerecords response is not valid JSON: ${(cause as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('FMC devicerecords response body is not an object');
  }
  const paging = isPlainObject(parsed.paging) ? parsed.paging : undefined;
  const reportedLimit = typeof paging?.limit === 'number' ? paging.limit : undefined;
  const reportedCount = typeof paging?.count === 'number' ? paging.count : undefined;

  const rawItems = parsed.items;
  if (rawItems === undefined) {
    return { items: [], reportedLimit, reportedCount, rawItemCount: 0, itemWarnings: [] };
  }
  if (!Array.isArray(rawItems)) {
    throw new Error('FMC devicerecords response "items" is present but not an array');
  }
  const items: RawDeviceRecordsPage['items'] = [];
  const itemWarnings: string[] = [];
  for (const raw of rawItems) {
    if (!isPlainObject(raw)) {
      itemWarnings.push('FMC devicerecords items[] entry is not an object — skipped');
      continue;
    }
    // F6: a malformed individual item (bad/missing id) is skipped, not a
    // reason to abort the whole page — mirrors the group-skip pattern used
    // by the SCC/FMC response mappers elsewhere in this codebase.
    const id = readOptionalString(raw, 'id');
    if (!id.ok || id.value === undefined || id.value.length === 0) {
      itemWarnings.push(
        `FMC devicerecords item is missing a valid "id" field (got ${JSON.stringify(raw.id)}) — skipped`,
      );
      continue;
    }
    // F7: a present-but-empty/whitespace-only or wrong-typed "name" must
    // never reach the renderer as an empty label — fall back to the
    // device's own id, which is always a well-formed non-empty UUID.
    const name = readOptionalString(raw, 'name');
    const trimmedName = name.ok && name.value !== undefined ? name.value.trim() : '';
    if (trimmedName.length === 0) {
      itemWarnings.push(
        `FMC devicerecords item "${id.value}" has a missing/empty "name" field — falling back to its id`,
      );
    }
    items.push({
      id: id.value,
      name: trimmedName.length > 0 ? trimmedName : id.value,
      isConnected: typeof raw.isConnected === 'boolean' ? raw.isConnected : undefined,
    });
  }
  return {
    items,
    reportedLimit,
    reportedCount,
    rawItemCount: rawItems.length,
    itemWarnings,
  };
}

/** The magic device-UUID-`0` footgun (DESIGN.md §3.3.1): means "the FMC appliance itself" in some health filters, distinct from a managed device. Never enqueued for health requests — v1 does not query FMC-appliance-level health. */
const FMC_APPLIANCE_DEVICE_ID = '0';

/**
 * Fetches every page of `devices/devicerecords?expanded=true` for one
 * domain, looping on `offset` until a page shorter than `PAGE_LIMIT` is
 * returned. Throws if the page count exceeds `maxPages` (a misbehaving
 * server that always returns a full page) or if any page's body fails to
 * parse — both are discovery failures for the caller (`createFmcDiscovery`
 * below) to catch and handle via "reuse the previous device list."
 */
export async function fetchAllDeviceRecords(
  options: FetchDeviceRecordsOptions,
): Promise<FmcDiscoveredDevice[]> {
  const client = createHttpClient({
    dispatcher: options.dispatcher,
    clock: options.clock,
    defaultTimeoutMs: options.requestTimeoutMs ?? 30_000,
  });
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const devices: FmcDiscoveredDevice[] = [];
  let offset = 0;
  // Running total of raw items seen across all pages so far (F4) — used
  // to detect a server that echoes back a `limit` it doesn't actually
  // honor, which would otherwise make a short-relative-to-that-limit page
  // look like the end of the list before `paging.count` is satisfied.
  let totalRawItemsSeen = 0;
  for (let page = 0; page < maxPages; page++) {
    const url =
      `https://${options.host}/api/fmc_config/v1/domain/${encodeURIComponent(options.domainUuid)}` +
      `/devices/devicerecords?expanded=true&offset=${offset}&limit=${PAGE_LIMIT}`;
    const response = await client.get(url, {
      endpoint: '/api/fmc_config/v1/domain/:domainUuid/devices/devicerecords',
      headers: { 'X-auth-access-token': options.accessToken },
      ...(options.beforeAttempt !== undefined && { beforeAttempt: options.beforeAttempt }),
    });
    const parsedPage = parseDeviceRecordsPage(response.body);
    for (const warning of parsedPage.itemWarnings) {
      options.onWarning?.(warning);
    }
    totalRawItemsSeen += parsedPage.rawItemCount;

    for (const item of parsedPage.items) {
      // F9: normalize before comparing against the magic appliance id —
      // " 0" (or any other whitespace-padded variant) must be excluded
      // exactly like "0".
      if (item.id.trim() === FMC_APPLIANCE_DEVICE_ID) {
        continue;
      }
      devices.push({
        id: item.id,
        name: item.name,
        ...(item.isConnected !== undefined ? { isConnected: item.isConnected } : {}),
      });
    }

    const stillBelowReportedCount =
      parsedPage.reportedCount !== undefined && totalRawItemsSeen < parsedPage.reportedCount;

    // F3: an empty page is unconditionally terminal — there is never a
    // legitimate reason to expect more devices after zero raw items came
    // back, regardless of what `reportedLimit`/`reportedCount` claim, and
    // trusting a bogus (e.g. `0`) reported limit here would otherwise spin
    // through maxPages re-requesting the same offset forever.
    if (parsedPage.rawItemCount === 0) {
      // F4 edge case: an empty page arriving before the server's own
      // reported total was reached is a genuine anomaly (some devices
      // never showed up in any page) — surface it rather than returning
      // a silently partial list.
      if (stillBelowReportedCount) {
        options.onWarning?.(
          `FMC devicerecords pagination ended with ${totalRawItemsSeen} items seen but the server's own paging.count reported ${parsedPage.reportedCount} — some devices may be missing`,
        );
      }
      return devices;
    }

    // Judge "short page" against the server's own reported page size when
    // it told us one, not against the `PAGE_LIMIT` we requested — see the
    // module doc comment. A non-positive reported limit is untrustworthy
    // (F3) and falls back to PAGE_LIMIT.
    const effectivePageSize =
      parsedPage.reportedLimit !== undefined && parsedPage.reportedLimit > 0
        ? parsedPage.reportedLimit
        : PAGE_LIMIT;
    const looksShort = parsedPage.rawItemCount < effectivePageSize;
    offset += parsedPage.rawItemCount;

    if (looksShort) {
      // F4: a page that looks short relative to `effectivePageSize` might
      // still be short *relative to the requested limit* while the server
      // has more devices than it honored per page — the only way to know
      // is to check the server's own reported total. If we haven't reached
      // it yet, keep paginating using the actual item count already
      // applied to `offset` above, rather than trusting `reportedLimit` as
      // a stop signal.
      if (stillBelowReportedCount) {
        continue;
      }
      return devices;
    }
  }

  throw new Error(
    `FMC device discovery aborted after ${maxPages} pages without reaching a short page — ` +
      'the FMC server may be misbehaving (always returning a full page), or maxPages needs raising',
  );
}

export interface CreateFmcDiscoveryOptions {
  clock: Clock;
  /** `FMC_DISCOVERY_INTERVAL_SECONDS` in ms — discovery runs on its own, slower cadence than the metric poll (DESIGN.md §3.3.3). */
  intervalMs: number;
  /** Performs the actual HTTP work; kept as an injected callback so this module owns only caching/cadence/error-isolation, and the caller (adapter.ts) owns supplying a live access token and domain UUID at call time. */
  fetchDevices: () => Promise<FmcDiscoveredDevice[]>;
  onDiscoverySuccess?: (deviceCount: number) => void;
  onDiscoveryFailure?: () => void;
}

export interface FmcDeviceDiscovery {
  /**
   * Returns the current device list, running discovery first if it has
   * never run or if `intervalMs` has elapsed since the last successful
   * run. A discovery failure reuses the previous list (DESIGN.md §3.3.3)
   * and does not throw — the metric poll must still succeed on a
   * discovery hiccup. Concurrent callers share one in-flight discovery
   * (single-flight, same discipline as `FmcTokenManager`).
   */
  getDevices(): Promise<FmcDiscoveredDevice[]>;
}

export function createFmcDiscovery(options: CreateFmcDiscoveryOptions): FmcDeviceDiscovery {
  let cachedDevices: FmcDiscoveredDevice[] = [];
  let lastSuccessAt: number | undefined;
  let inFlight: Promise<FmcDiscoveredDevice[]> | undefined;

  async function runDiscovery(): Promise<FmcDiscoveredDevice[]> {
    try {
      const devices = await options.fetchDevices();
      cachedDevices = devices;
      lastSuccessAt = options.clock.now();
      options.onDiscoverySuccess?.(devices.length);
      return cachedDevices;
    } catch {
      options.onDiscoveryFailure?.();
      return cachedDevices;
    }
  }

  return {
    getDevices(): Promise<FmcDiscoveredDevice[]> {
      if (inFlight !== undefined) {
        return inFlight;
      }
      const isDue =
        lastSuccessAt === undefined || options.clock.now() - lastSuccessAt >= options.intervalMs;
      if (!isDue) {
        return Promise.resolve(cachedDevices);
      }
      const promise = runDiscovery().finally(() => {
        if (inFlight === promise) {
          inFlight = undefined;
        }
      });
      inFlight = promise;
      return promise;
    },
  };
}
