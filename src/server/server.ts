import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Registry } from 'prom-client';
import type { MetricsTlsConfig } from '../config/types.ts';
import { createRequestHandler, type RouteDeps } from './routes.ts';

/**
 * `node:http`, or `node:https` when `tls` is supplied (DESIGN.md §2.7/§9.2 —
 * the framework-free choice from Stage 0 is what makes this a two-line
 * difference: same handler, same hardening options, only the constructor
 * and its TLS-specific fields change).
 *
 * Certificate/key/client-CA *readability* was already validated at startup
 * by Stage 4's config loader (`checkReadablePath`) — this module still reads
 * the actual file *contents* itself (mirroring
 * `src/backends/fmc/adapter.ts`'s `caBundlePath` handling), since the config
 * layer only ever stores paths, never file contents, per its own
 * `MetricsTlsConfig` shape.
 */

/** Exported for direct assertion in tests — the relationship between these values (not just their individual presence) is what makes the hardening real; see each constant's own comment. */
export const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Deliberately near Node's own 5s default, not generous: this endpoint's
 * clients are a handful of Prometheus/Alloy scrapers on a 15-60s interval, so
 * a long keep-alive buys little (the next scrape rarely lands inside the
 * window) while holding every idle socket from every client — well-behaved
 * or not — for the full duration. Plan risk #5 names "unbounded connection
 * accumulation from a misbehaving scraper" as the thing the explicit
 * timeouts exist to bound; a generous keep-alive works against that.
 */
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_HEADER_SIZE_BYTES = 16_384;
/**
 * `headersTimeout`/`requestTimeout` are enforced by a periodic sweep of
 * incomplete connections, not a per-connection timer — at Node's 30s default
 * sweep interval, a 10s `headersTimeout` is actually enforced at up to ~30s
 * (verified: a stalled connection survived until the next sweep tick, not at
 * the 10s mark). Setting the sweep interval well below the shortest
 * configured timeout is what makes that timeout mean what it says.
 */
export const DEFAULT_CONNECTIONS_CHECKING_INTERVAL_MS = 2_000;
/**
 * Plan risk #5's "unbounded connection accumulation" cannot be closed by a
 * timeout alone — a client opening connections fast enough sustains far more
 * concurrently than any keep-alive window would suggest (verified: 200
 * concurrent idle keep-alive sockets, all held, with no cap set). The
 * expected client population is a small number of scrapers plus liveness/
 * readiness probes — normally single digits — so this leaves two orders of
 * magnitude of headroom while still being a real ceiling; Node closes
 * connections beyond it immediately rather than accepting and then failing
 * to service them.
 */
export const DEFAULT_MAX_CONNECTIONS = 64;

export interface CreateServerOptions {
  bindAddress: string;
  port: number;
  registry: Registry;
  isAlive: () => boolean;
  isReady: () => boolean;
  /** See `RouteDeps.renderMetrics` — repopulates device gauges from the cache immediately before each `/metrics` response. */
  renderMetrics?: () => void;
  /** Enables `node:https` with the given cert/key when set; plain `node:http` otherwise. */
  tls?: MetricsTlsConfig;
}

export interface ListeningAddress {
  address: string;
  port: number;
}

export interface HardeningSnapshot {
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
  maxHeaderSize: number;
  connectionsCheckingInterval: number;
  maxConnections: number | undefined;
}

export interface MetricsServer {
  /** Binds and starts listening. Rejects (e.g. `EADDRINUSE`) rather than failing silently — the caller (Stage 11's `index.ts`) is expected to exit non-zero on rejection. */
  start(): Promise<ListeningAddress>;
  /** Stops accepting new connections and closes idle ones. Idempotent. */
  stop(): Promise<void>;
  /**
   * Reads the hardening values actually applied to the underlying
   * `http.Server`/`https.Server` instance. A real-time reproduction of a
   * slow-loris connection surviving `headersTimeout` is flaky in some CI/
   * sandboxed network environments (a stalled partial-header connection can
   * be interfered with by intermediate security software) — this gives
   * tests a reliable way to catch the actual regression class (an
   * accidentally deleted or wrongly-valued constant) without a real-clock
   * network probe.
   */
  hardening(): HardeningSnapshot;
}

/**
 * `https.createServer` accepts an empty `cert`/`key` string and binds
 * successfully — `start()` resolves, the process looks started — but every
 * subsequent TLS handshake then fails permanently with alert 40
 * (handshake_failure), and nothing in this module's own health signals
 * reflects it (verified). Stage 4's `checkReadablePath` only validates
 * readability, not content, and can't fully close this: the file can be
 * rewritten between startup validation and this read (a projected
 * Kubernetes Secret volume is the realistic case), so the check belongs
 * here, at the point the material is actually consumed.
 */
function readNonEmptyFile(path: string, variable: string): string {
  const contents = readFileSync(path, 'utf8');
  if (contents.trim() === '') {
    throw new Error(`${variable} ("${path}") is empty — expected PEM-encoded material`);
  }
  return contents;
}

function readTlsMaterial(tls: MetricsTlsConfig): {
  cert: string;
  key: string;
  ca?: string;
} {
  const cert = readNonEmptyFile(tls.certPath, 'METRICS_TLS_CERT_PATH');
  const key = readNonEmptyFile(tls.keyPath, 'METRICS_TLS_KEY_PATH');
  const ca =
    tls.clientCaPath !== undefined
      ? readNonEmptyFile(tls.clientCaPath, 'METRICS_TLS_CLIENT_CA_PATH')
      : undefined;
  return { cert, key, ...(ca !== undefined ? { ca } : {}) };
}

export function createServer(options: CreateServerOptions): MetricsServer {
  const routeDeps: RouteDeps = {
    registry: options.registry,
    isAlive: options.isAlive,
    isReady: options.isReady,
    ...(options.renderMetrics !== undefined ? { renderMetrics: options.renderMetrics } : {}),
  };
  const handler = createRequestHandler(routeDeps);

  const hardening = {
    headersTimeout: DEFAULT_HEADERS_TIMEOUT_MS,
    requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    maxHeaderSize: DEFAULT_MAX_HEADER_SIZE_BYTES,
    connectionsCheckingInterval: DEFAULT_CONNECTIONS_CHECKING_INTERVAL_MS,
  };

  const optionsTls = options.tls;
  const server =
    optionsTls !== undefined
      ? (() => {
          const { cert, key, ca } = readTlsMaterial(optionsTls);
          const mutualTls = ca !== undefined;
          return https.createServer(
            {
              cert,
              key,
              minVersion: optionsTls.minVersion,
              ...hardening,
              // Mutual TLS (DESIGN.md §9.2): requesting a client cert AND
              // rejecting unauthorized connections together is what makes an
              // absent or untrusted client certificate fail the TLS
              // handshake outright, rather than merely being ignored.
              ...(mutualTls ? { ca, requestCert: true, rejectUnauthorized: true } : {}),
            },
            handler,
          );
        })()
      : http.createServer(hardening, handler);

  // Not a constructor option on either `http.Server`/`https.Server` — set
  // as a property. Node rejects connections beyond this count immediately,
  // which is what actually bounds plan risk #5's "unbounded connection
  // accumulation"; `keepAliveTimeout` alone cannot, since a client opening
  // connections fast enough sustains far more concurrently than any
  // keep-alive window would suggest.
  server.maxConnections = DEFAULT_MAX_CONNECTIONS;

  return {
    start(): Promise<ListeningAddress> {
      return new Promise((resolve, reject) => {
        const onError = (cause: Error): void => {
          server.removeListener('listening', onListening);
          reject(cause);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          const bound = server.address();
          if (bound === null || typeof bound === 'string') {
            reject(new Error('expected an AddressInfo after listen()'));
            return;
          }
          resolve({ address: bound.address, port: bound.port });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port, options.bindAddress);
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    hardening(): HardeningSnapshot {
      // maxHeaderSize/connectionsCheckingInterval are real runtime
      // properties on http.Server/https.Server (set from the matching
      // ServerOptions field at construction) but @types/node only types
      // them as constructor options, not instance properties.
      const untyped = server as unknown as {
        maxHeaderSize: number;
        connectionsCheckingInterval: number;
      };
      return {
        headersTimeout: server.headersTimeout,
        requestTimeout: server.requestTimeout,
        keepAliveTimeout: server.keepAliveTimeout,
        maxHeaderSize: untyped.maxHeaderSize,
        connectionsCheckingInterval: untyped.connectionsCheckingInterval,
        maxConnections: server.maxConnections,
      };
    },
  };
}
