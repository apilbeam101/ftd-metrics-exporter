import type http from 'node:http';
import https from 'node:https';
import { generateTlsFixture } from './tls-fixtures.ts';

/**
 * A scriptable local `node:https` FMC fixture server, shared across the
 * Stage 8 test files (token-manager, discovery, adapter) — richer than
 * `support/http-server.ts`'s generic handler because these tests need to
 * script a stateful token lifecycle, per-device/per-family response
 * lookup, and pagination, not just a single fixed response.
 *
 * `https`, not `http`: `auth-transport.ts` and every FMC adapter/discovery
 * call hardcodes `https://<host>` (FMC always speaks TLS in production —
 * DESIGN.md §3.3.6), so a plain `http` mock would exercise a URL scheme
 * this codebase never actually issues a request against. Uses an in-test
 * self-signed cert (`support/tls-fixtures.ts`, already used by
 * `http-agent.test.ts`) with the dispatcher's `rejectUnauthorized: false`
 * (set by each test file's own test dispatcher) standing in for a real
 * CA bundle — these tests exercise the FMC *protocol*, not TLS trust,
 * which Stage 6's `http-agent.test.ts` already covers.
 *
 * Auth endpoints (`generatetoken`/`refreshtoken`) respond `204` with token
 * headers per the real protocol (DESIGN.md §3.3.2, Appendix C) — no body.
 * `devicerecords` and `aggregatemetrics` respond with whatever JSON the
 * test script configures for the requested offset/filter.
 */

export interface AuthBehavior {
  /** Defaults to 204. Set to 401 to simulate bad credentials or an unexpected 401 on refresh. */
  statusCode?: number;
  accessToken?: string;
  refreshToken?: string;
  domainUuid?: string;
  /** If true, omits X-auth-access-token from an otherwise-204 response (plan testing step 7). */
  omitAccessTokenHeader?: boolean;
}

export interface FmcMockServer {
  port: number;
  host: string;
  /** PEM-encoded self-signed certificate this server presents — exposed so a test can load it as a CA bundle (the TLS "matching CA succeeds" path, IMPLEMENTATION_PLAN.md Stage 12 testing step 10). */
  cert: string;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  close(): Promise<void>;
  /** Queues the next `generatetoken` response. FIFO; if empty, defaults to a 204 success with generated tokens. */
  queueGenerateToken(behavior: AuthBehavior): void;
  queueRefreshToken(behavior: AuthBehavior): void;
  /** Sets the JSON body returned for `devicerecords` at a given offset (string key, e.g. "0", "25"). */
  setDeviceRecordsPage(offset: number, body: unknown): void;
  /** Sets the JSON body returned for one device/family combination. */
  setAggregateMetrics(deviceId: string, family: string, body: unknown, statusCode?: number): void;
  /** Forces the *next* aggregatemetrics request for this device/family to 401 once, then fall through to the configured response. */
  force401Once(deviceId: string, family: string): void;
  /** Delays every aggregatemetrics response by this many ms — used to observe in-flight concurrency from the client side. */
  setAggregateMetricsDelay(ms: number): void;
  generateTokenCallCount: number;
  refreshTokenCallCount: number;
}

let tokenCounter = 0;

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(text);
}

export async function startFmcMockServer(): Promise<FmcMockServer> {
  const requests: FmcMockServer['requests'] = [];
  const generateTokenQueue: AuthBehavior[] = [];
  const refreshTokenQueue: AuthBehavior[] = [];
  const deviceRecordsPages = new Map<number, unknown>();
  const aggregateMetrics = new Map<string, { body: unknown; statusCode: number }>();
  const force401 = new Set<string>();
  let generateTokenCallCount = 0;
  let refreshTokenCallCount = 0;
  let aggregateMetricsDelayMs = 0;

  function keyFor(deviceId: string, family: string): string {
    return `${deviceId}::${family}`;
  }

  const tlsFixture = await generateTlsFixture('127.0.0.1', '127.0.0.1');

  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { cert: tlsFixture.cert, key: tlsFixture.key },
      (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = req.url ?? '';
        requests.push({ method: req.method ?? 'GET', url, headers: req.headers });

        if (url.startsWith('/api/fmc_platform/v1/auth/generatetoken')) {
          generateTokenCallCount++;
          const behavior = generateTokenQueue.shift() ?? {};
          const statusCode = behavior.statusCode ?? 204;
          if (statusCode !== 204) {
            res.writeHead(statusCode);
            res.end();
            return;
          }
          tokenCounter++;
          const headers: Record<string, string> = {};
          if (!behavior.omitAccessTokenHeader) {
            headers['X-auth-access-token'] = behavior.accessToken ?? `access-${tokenCounter}`;
          }
          headers['X-auth-refresh-token'] = behavior.refreshToken ?? `refresh-${tokenCounter}`;
          headers.DOMAIN_UUID = behavior.domainUuid ?? '00000000-0000-4000-8000-000000000002';
          res.writeHead(204, headers);
          res.end();
          return;
        }

        if (url.startsWith('/api/fmc_platform/v1/auth/refreshtoken')) {
          refreshTokenCallCount++;
          const behavior = refreshTokenQueue.shift() ?? {};
          const statusCode = behavior.statusCode ?? 204;
          if (statusCode !== 204) {
            res.writeHead(statusCode);
            res.end();
            return;
          }
          tokenCounter++;
          const headers: Record<string, string> = {};
          if (!behavior.omitAccessTokenHeader) {
            headers['X-auth-access-token'] = behavior.accessToken ?? `access-${tokenCounter}`;
          }
          headers['X-auth-refresh-token'] = behavior.refreshToken ?? `refresh-${tokenCounter}`;
          headers.DOMAIN_UUID = behavior.domainUuid ?? '00000000-0000-4000-8000-000000000002';
          res.writeHead(204, headers);
          res.end();
          return;
        }

        if (url.includes('/devices/devicerecords')) {
          const parsed = new URL(url, 'http://localhost');
          const offset = Number(parsed.searchParams.get('offset') ?? '0');
          const page = deviceRecordsPages.get(offset);
          if (page === undefined) {
            sendJson(res, 200, { links: {}, paging: { offset, limit: 1000, count: 0, pages: 0 } });
            return;
          }
          sendJson(res, 200, page);
          return;
        }

        if (url.includes('/health/aggregatemetrics')) {
          const parsed = new URL(url, 'http://localhost');
          const filter = parsed.searchParams.get('filter') ?? '';
          const deviceMatch = /device_uuid:([^;]+)/.exec(filter);
          const familyMatch = /metric:([^;]+)/.exec(filter);
          const deviceId = deviceMatch?.[1] ?? '';
          const family = familyMatch?.[1] ?? '';
          const key = keyFor(deviceId, family);

          const respond = () => {
            if (force401.has(key)) {
              force401.delete(key);
              res.writeHead(401);
              res.end();
              return;
            }
            const entry = aggregateMetrics.get(key);
            if (entry === undefined) {
              sendJson(res, 200, {
                links: {},
                paging: { offset: 0, limit: 25, count: 0, pages: 0 },
              });
              return;
            }
            sendJson(res, entry.statusCode, entry.body);
          };
          if (aggregateMetricsDelayMs > 0) {
            setTimeout(respond, aggregateMetricsDelayMs);
          } else {
            respond();
          }
          return;
        }

        if (url.startsWith('/api/fmc_platform/v1/info/domain')) {
          sendJson(res, 200, {
            items: [{ uuid: '00000000-0000-4000-8000-000000000002', name: 'Global' }],
          });
          return;
        }

        res.writeHead(404);
        res.end();
      },
    );

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected an AddressInfo from server.listen'));
        return;
      }
      resolve({
        port: address.port,
        host: `127.0.0.1:${address.port}`,
        cert: tlsFixture.cert,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
        queueGenerateToken(behavior) {
          generateTokenQueue.push(behavior);
        },
        queueRefreshToken(behavior) {
          refreshTokenQueue.push(behavior);
        },
        setDeviceRecordsPage(offset, body) {
          deviceRecordsPages.set(offset, body);
        },
        setAggregateMetrics(deviceId, family, body, statusCode = 200) {
          aggregateMetrics.set(keyFor(deviceId, family), { body, statusCode });
        },
        force401Once(deviceId, family) {
          force401.add(keyFor(deviceId, family));
        },
        setAggregateMetricsDelay(ms) {
          aggregateMetricsDelayMs = ms;
        },
        get generateTokenCallCount() {
          return generateTokenCallCount;
        },
        get refreshTokenCallCount() {
          return refreshTokenCallCount;
        },
      });
    });
  });
}
