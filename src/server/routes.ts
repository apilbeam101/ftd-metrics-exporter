import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from 'prom-client';

/**
 * Exactly four routes plus a 404/405 (DESIGN.md §9.2, plan Stage 10
 * scope, plus the Prometheus instrumentation guidelines' recommended `/`
 * landing page). No routing library, no body parsing — every handler here reads
 * only `req.method`/`req.url` and writes a response directly.
 *
 * `/metrics` always renders from whatever `registry.metrics()` currently
 * holds — this module has no upstream awareness at all. The poll-cache-serve
 * contract (DESIGN.md §2.2: "a Prometheus scrape triggers a live upstream
 * call" must never happen) is satisfied structurally: nothing in this file
 * can reach the network, because nothing here is given a `HealthBackend` or
 * an HTTP client to reach it with.
 */

export interface RouteDeps {
  registry: Registry;
  /** DESIGN.md §7.2: liveness must never depend on upstream health — this always returns true once the server exists to answer it. */
  isAlive: () => boolean;
  /** DESIGN.md §7.2: readiness reflects "cache populated by a successful poll," not "upstream currently healthy" — true forever after the first successful poll, never flaps back to false on a later failure. */
  isReady: () => boolean;
  /**
   * Synchronously repopulates the device-metric gauges from whatever the
   * cache currently holds (Stage 9's `MetricsCache` + Stage 3's
   * `renderDeviceMetrics` — collector.ts's own doc comment names this "the
   * HTTP layer" as the caller). Invoked once per `/metrics` request,
   * immediately before `registry.metrics()` reads the registry back out, so
   * a scrape always reflects the latest cache entry with no upstream call
   * in the request path. Absent (e.g. a registry with no device gauges
   * wired up, as in some unit tests) simply skips the render step.
   */
  renderMetrics?: () => void;
}

function endWith(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(statusCode, { 'Content-Type': contentType, ...extraHeaders });
  res.end(body);
}

/**
 * Single-flights concurrent `/metrics` requests behind one render + one
 * `registry.metrics()` call. This is not just an optimization: `Gauge.get()`
 * (prom-client) only reads its value map synchronously when the gauge has no
 * async `collect` hook — a gauge that does have one suspends at `await
 * collect()` *before* reading its state, so `registry.metrics()` as a whole
 * has a real yield point mid-render. Two overlapping `/metrics` requests
 * calling `renderMetrics()` independently could, for such a gauge, produce a
 * response whose body mixes two different renders (verified by test). No
 * `ftd_*` gauge declares such a hook today, so this is defense against a
 * latent hazard rather than a currently-observable bug, but it also matches
 * the actual poll-cache-serve semantics: two concurrent scrapes with no new
 * poll in between should serve byte-identical output, not each pay their own
 * render cost.
 */
function createMetricsRenderer(
  deps: RouteDeps,
): () => Promise<{ contentType: string; body: string }> {
  let inFlight: Promise<{ contentType: string; body: string }> | undefined;

  return () => {
    inFlight ??= (async () => {
      try {
        deps.renderMetrics?.();
        const body = await deps.registry.metrics();
        return { contentType: deps.registry.contentType, body };
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}

/**
 * A throwing `isAlive`/`isReady` callback must never escape this module: an
 * uncaught throw from inside a `node:http` `'request'` listener is an
 * `uncaughtException` with no promise boundary to catch it, which crashes
 * the whole process — the exact restart-loop hazard DESIGN.md §7.2 warns
 * about, arriving through the probe mechanism itself rather than a bad
 * boolean. Stage 11 wires these callbacks to real closures over the cache
 * and poller (e.g. `() => cache.get() !== undefined`), so a throw here is a
 * real, reachable failure mode, not a hypothetical one. Fails closed to
 * `false` — an unknown liveness/readiness signal must never be reported as
 * healthy — and the response body distinguishes "reported unhealthy" from
 * "the check itself is broken" so the failure is visible to an operator.
 */
function probe(fn: () => boolean): { ok: boolean; threw: boolean } {
  try {
    return { ok: fn(), threw: false };
  } catch {
    return { ok: false, threw: true };
  }
}

function handleHealthz(deps: RouteDeps, res: ServerResponse): void {
  const result = probe(deps.isAlive);
  if (result.ok) {
    endWith(res, 200, 'text/plain; charset=utf-8', 'ok\n');
  } else if (result.threw) {
    endWith(res, 503, 'text/plain; charset=utf-8', 'not alive — liveness check itself failed\n');
  } else {
    endWith(res, 503, 'text/plain; charset=utf-8', 'not alive\n');
  }
}

function handleReadyz(deps: RouteDeps, res: ServerResponse): void {
  const result = probe(deps.isReady);
  if (result.ok) {
    endWith(res, 200, 'text/plain; charset=utf-8', 'ready\n');
  } else if (result.threw) {
    endWith(res, 503, 'text/plain; charset=utf-8', 'not ready — readiness check itself failed\n');
  } else {
    endWith(res, 503, 'text/plain; charset=utf-8', 'not ready — no successful poll yet\n');
  }
}

/** DESIGN.md/Prometheus instrumentation guidelines' verbatim recommendation: a landing page at `/` naming the exporter and linking `/metrics`, for a human who hits the bare host:port. */
const LANDING_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>FTD Metrics Exporter</title></head>
<body>
<h1>FTD Metrics Exporter</h1>
<p><a href="/metrics">Metrics</a></p>
</body>
</html>
`;

const KNOWN_PATHS = new Set(['/', '/metrics', '/healthz', '/readyz']);
/** RFC 9110 §9.1: GET and HEAD are the two methods every general-purpose server must support; `node:http` suppresses the body automatically for a HEAD response, so routing it to the same handler as GET is correct with no special-casing. */
const ALLOWED_METHODS = 'GET, HEAD';

export function createRequestHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  const renderMetrics = createMetricsRenderer(deps);

  return (req, res) => {
    const url = req.url ?? '/';
    // `url.split('?', 1)[0]` is always a string for any string `url` --
    // `noUncheckedIndexedAccess` types array indexing as possibly
    // `undefined` regardless, hence the fallback.
    const path = url.split('?', 1)[0] ?? url;
    const method = req.method ?? '';
    const isGetOrHead = method === 'GET' || method === 'HEAD';

    if (KNOWN_PATHS.has(path) && !isGetOrHead) {
      // RFC 9110 §15.5.6: a 405 response MUST include an Allow header
      // listing the resource's supported methods.
      endWith(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n', {
        Allow: ALLOWED_METHODS,
      });
      return;
    }

    switch (path) {
      case '/':
        endWith(res, 200, 'text/html; charset=utf-8', LANDING_PAGE_HTML);
        return;
      case '/metrics':
        renderMetrics()
          .then(({ contentType, body }) => endWith(res, 200, contentType, body))
          .catch((cause) => {
            endWith(
              res,
              500,
              'text/plain; charset=utf-8',
              `error rendering metrics: ${cause instanceof Error ? cause.message : String(cause)}\n`,
            );
          });
        return;
      case '/healthz':
        handleHealthz(deps, res);
        return;
      case '/readyz':
        handleReadyz(deps, res);
        return;
      default:
        endWith(res, 404, 'text/plain; charset=utf-8', 'not found\n');
    }
  };
}
