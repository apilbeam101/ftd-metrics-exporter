import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateTlsFixture } from '../unit/support/tls-fixtures.ts';

/**
 * `dist/index.js` is now (Stage 11) a long-running process, not a
 * print-one-line-and-exit stub — these tests exercise it as a real
 * subprocess: startup/shutdown, `--version`/`--help`, invalid-config
 * rejection, and the actual `/healthz`/`/readyz` HTTP surface, mirroring
 * IMPLEMENTATION_PLAN.md Stage 11's testing steps 1-3, 6, and 13.
 *
 * The SCC backend is used throughout because `createSccAdapter.init()`
 * makes no network call of its own (only `fetchSnapshot()` does) — a
 * syntactically valid but unreachable `SCC_BASE_URL` lets the process
 * start up fully (server listening, poller scheduled) without this test
 * needing a real or mocked upstream. The first background poll cycle
 * against that unreachable URL fails and is absorbed by the poller's own
 * error handling (DESIGN.md §2.2) — invisible to these tests, which only
 * assert on process-level behavior.
 */

const distEntry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/**
 * A dev machine that hasn't run `npm run build` yet is a legitimate reason
 * to skip these subprocess tests. CI is not — a review found no CI job
 * ever builds `dist/` before `npm test` runs, so this entire suite (the
 * `/healthz`-during-init() ordering regression, the --dump-raw stdout
 * regression, the shebang check) was silently skipping there with `npm
 * test` still reporting exit 0. Skipping is `t.skip()`'s job on a dev
 * machine; under CI a missing `dist/` means the workflow itself is
 * misconfigured and must fail loudly instead.
 */
function requireDistBuilt(t: { skip: (message?: string) => void }): boolean {
  if (existsSync(distEntry)) {
    return true;
  }
  if (process.env.CI) {
    throw new Error(
      'dist/index.js not built and CI is set — the workflow is missing an `npm run build` step',
    );
  }
  t.skip('dist/index.js not built — run `npm run build` first');
  return false;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected an AddressInfo from a throwaway server.listen'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

interface SpawnedExporter {
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  exitCode: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * A fresh, empty directory with no `.env` file — `loadConfig()`'s default
 * lookup (no `--env-file` flag) reads `.env` from `process.cwd()`, and this
 * repo's own real `.env` (gitignored, used for manual local runs) would
 * otherwise silently supply the very variables an "invalid config" test
 * means to omit, once the child process inherits this project's directory
 * as its default `cwd`.
 */
function emptyCwd(): string {
  return mkdtempSync(join(tmpdir(), 'ftd-dist-smoke-'));
}

function spawnExporter(args: string[], env: Record<string, string | undefined>): SpawnedExporter {
  const child = spawn(process.execPath, [distEntry, ...args], {
    env: { ...env },
    cwd: emptyCwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk: Buffer) => {
    state.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    state.stderr += chunk.toString();
  });
  const exitCode = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    child,
    get stdout() {
      return state.stdout;
    },
    get stderr() {
      return state.stderr;
    },
    exitCode,
  };
}

async function waitForPortListening(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortBound(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`port ${port} was not listening within ${timeoutMs}ms`);
}

function isPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true)); // EADDRINUSE -> something is already listening
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(false));
    });
  });
}

async function httpGet(port: number, path: string): Promise<{ statusCode: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { statusCode: res.status, body };
}

function sccEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    BACKEND_TYPE: 'scc',
    SCC_BASE_URL: 'https://127.0.0.1.invalid.example/firewall',
    SCC_API_TOKEN: 'a-realistic-looking-token-value',
    SCC_FMC_UID: '00000000-0000-0000-0000-000000000000',
    POLL_INTERVAL_SECONDS: '30',
    LOG_LEVEL: 'error',
    LOG_FORMAT: 'json',
    ENABLE_DEFAULT_METRICS: 'false',
    METRICS_BIND_ADDRESS: '127.0.0.1',
    ...overrides,
  } as Record<string, string>;
}

test('dist/index.js exists and starts with a shebang for bin invocation', (t) => {
  if (!requireDistBuilt(t)) return;
  const firstLine = readFileSync(distEntry, 'utf8').split('\n')[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});

// --- Testing step 6: --version prints and exits 0; --help lists the flags ---

test('--version prints the version and exits 0', async (t) => {
  if (!requireDistBuilt(t)) return;
  const exporter = spawnExporter(['--version'], {});
  const { code } = await exporter.exitCode;
  assert.equal(code, 0);
  assert.ok(exporter.stdout.trim().length > 0);
});

test('--help lists the documented flags and exits 0', async (t) => {
  if (!requireDistBuilt(t)) return;
  const exporter = spawnExporter(['--help'], {});
  const { code } = await exporter.exitCode;
  assert.equal(code, 0);
  for (const flag of ['--env-file', '--dump-raw', '--version', '--help']) {
    assert.ok(exporter.stdout.includes(flag), `--help output missing ${flag}`);
  }
});

// --- Testing step 1: invalid config -> non-zero exit, one actionable message, no socket opened ---

test('invalid config: non-zero exit, actionable message, and the configured port stays free', async (t) => {
  if (!requireDistBuilt(t)) return;
  const port = await findFreePort();
  const exporter = spawnExporter([], {
    PATH: process.env.PATH ?? '',
    BACKEND_TYPE: 'scc',
    METRICS_PORT: String(port),
    // Deliberately omit SCC_API_TOKEN/SCC_FMC_UID/SCC_BASE_URL -- an
    // invalid config per DESIGN.md §2.4's fail-fast contract.
  });
  const { code } = await exporter.exitCode;
  assert.notEqual(code, 0);
  assert.ok(exporter.stderr.length > 0, 'expected an actionable error message on stderr');
  assert.ok(
    exporter.stderr.includes('SCC_API_TOKEN') || exporter.stderr.includes('SCC_BASE_URL'),
    `expected the missing-variable name in the error message, got: ${exporter.stderr}`,
  );
  assert.equal(
    await isPortBound(port),
    false,
    'the configured port must never be opened on a config error',
  );
});

// --- Testing step 2: valid config -> server listening, /readyz 503 then eventually reflects poll state ---

test('valid config: the metrics server listens, /healthz is 200 immediately, /readyz is 503 before the first successful poll', async (t) => {
  if (!requireDistBuilt(t)) return;
  const port = await findFreePort();
  const exporter = spawnExporter([], sccEnv({ METRICS_PORT: String(port) }));
  try {
    await waitForPortListening(port);
    const healthz = await httpGet(port, '/healthz');
    assert.equal(healthz.statusCode, 200);
    const readyz = await httpGet(port, '/readyz');
    // The unreachable SCC_BASE_URL means the first poll cannot succeed
    // within this test's lifetime, so /readyz must still read 503 --
    // proving readiness genuinely tracks "cache populated," not merely
    // "server is up."
    assert.equal(readyz.statusCode, 503);
  } finally {
    exporter.child.kill('SIGKILL');
    await exporter.exitCode;
  }
});

// --- Testing step 3/4: SIGTERM/SIGINT -> graceful shutdown, exit code 0, within the shutdown budget ---
//
// Windows note: `ChildProcess.kill('SIGTERM'|'SIGINT')` on win32 does not
// deliver a real, catchable signal to a Node.js child — Node's own docs
// for `subprocess.kill()` describe this as force-terminating the process,
// and it was confirmed empirically here: a child with a `process.on(
// 'SIGTERM', ...)` handler that calls `process.exit(0)` still reports
// `code: null, signal: 'SIGTERM'` (i.e. it was killed, the handler never
// ran) when killed this way from a Node.js parent on Windows. These tests
// are skipped on win32 for that reason — they remain meaningful (and will
// run) on Linux/macOS CI, where `kill()` sends the real POSIX signal. The
// signal->shutdown wiring itself is still exercised on every platform via
// `lifecycle.test.ts`'s fake-process `EventEmitter` tests, which drive
// `install()`'s registered handlers directly rather than through a real
// OS signal delivery mechanism.

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`${signal}: stops accepting connections and exits 0 within the shutdown budget`, async (t) => {
    if (process.platform === 'win32') {
      t.skip(
        `real ${signal} delivery to a Node.js child is not observable via child_process.kill() on Windows — see lifecycle.test.ts for the platform-independent coverage`,
      );
      return;
    }
    if (!requireDistBuilt(t)) return;
    const port = await findFreePort();
    const exporter = spawnExporter([], sccEnv({ METRICS_PORT: String(port) }));
    await waitForPortListening(port);

    const killed = exporter.child.kill(signal);
    assert.ok(killed, `child.kill(${signal}) reported failure`);

    const { code, signal: exitSignal } = await exporter.exitCode;
    // A graceful shutdown that calls process.exit(0) reports code 0 with a
    // null signal on both platforms this project targets.
    assert.equal(
      code,
      0,
      `expected exit code 0 after ${signal}, got code=${code} signal=${exitSignal}`,
    );

    // Testing step 13: no open handles keep the process alive after a
    // clean shutdown -- already proven by the exit event firing at all
    // within exitCode's promise; a lingering handle would have kept the
    // child process running past the hard-exit timer instead.
    assert.equal(
      await isPortBound(port),
      false,
      'the port must be released after a graceful shutdown',
    );
  });
}

// --- Testing step 5: hang-guard -- covered at the unit level (lifecycle.test.ts); a full stuck-close
// subprocess repro is deliberately not attempted here, since it would require injecting a hang into
// the real backend/server without a test-only seam, and the unit test already exercises the exact
// hard-exit-timer code path this integration test would otherwise duplicate. ---

// --- Regression: the server must start (and /healthz must answer) before backend.init() completes,
// not after (Stage 11 review finding 2). Uses the FMC backend against a blackholed (RFC 5737-adjacent,
// non-routable) address: init() performs a real login attempt and cannot resolve quickly, but the port
// must already be bound and /healthz already answering well before that login attempt's own timeout. ---

test('server ordering: /healthz answers while backend.init() is still in flight against an unreachable FMC host', async (t) => {
  if (!requireDistBuilt(t)) return;
  const port = await findFreePort();
  const exporter = spawnExporter([], {
    PATH: process.env.PATH ?? '',
    BACKEND_TYPE: 'fmc',
    METRICS_PORT: String(port),
    METRICS_BIND_ADDRESS: '127.0.0.1',
    FMC_HOST: '203.0.113.1', // RFC 5737 TEST-NET-3 -- documented non-routable, never answers.
    FMC_USERNAME: 'svc',
    FMC_PASSWORD: 'a-realistic-looking-password',
    FMC_TLS_INSECURE_SKIP_VERIFY: 'true',
    REQUEST_TIMEOUT_SECONDS: '30', // deliberately generous -- the point is /healthz must not wait for it.
    LOG_LEVEL: 'error',
    LOG_FORMAT: 'json',
    ENABLE_DEFAULT_METRICS: 'false',
  });
  try {
    // If the server only started after backend.init() (the bug this
    // regression guards against), this would need to wait out most/all of
    // REQUEST_TIMEOUT_SECONDS before the port ever bound. Waiting only a
    // small fraction of that budget is the actual assertion.
    await waitForPortListening(port, 5_000);
    const healthz = await httpGet(port, '/healthz');
    assert.equal(healthz.statusCode, 200);
  } finally {
    exporter.child.kill('SIGKILL');
    await exporter.exitCode;
  }
});

// --- Regression: --dump-raw's stdout must contain nothing but the JSON capture -- no log lines
// interleaved (Stage 11 review finding 3). Every other log line (the config summary, the mandatory
// dump-raw warning) must go to stderr instead. ---

test('--dump-raw: stdout is valid JSON with no log lines mixed in (config summary and warnings go to stderr)', async (t) => {
  if (!requireDistBuilt(t)) return;
  // FMC, not SCC: the SCC adapter's real 30s inter-request spacing floor
  // makes any retryable failure (including a plain closed-port
  // ECONNREFUSED) slow to observe once a retry re-invokes the spacing
  // guard's wait(). The FMC backend has no such floor, and a self-signed
  // HTTPS mock (with FMC_TLS_INSECURE_SKIP_VERIFY) returning 404 for
  // generatetoken fails init() in milliseconds, non-retryably.
  const tls = await generateTlsFixture('127.0.0.1', '127.0.0.1');
  const upstream = https.createServer({ cert: tls.cert, key: tls.key }, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;

  try {
    const exporter = spawnExporter(['--dump-raw'], {
      PATH: process.env.PATH ?? '',
      BACKEND_TYPE: 'fmc',
      FMC_HOST: `127.0.0.1:${port}`,
      FMC_USERNAME: 'svc',
      FMC_PASSWORD: 'a-realistic-looking-password',
      FMC_TLS_INSECURE_SKIP_VERIFY: 'true',
      LOG_LEVEL: 'info', // 'error' would filter out the info-level config summary this test checks for.
      LOG_FORMAT: 'json',
      ENABLE_DEFAULT_METRICS: 'false',
    });
    await exporter.exitCode;

    assert.doesNotThrow(
      () => JSON.parse(exporter.stdout),
      `--dump-raw stdout was not valid JSON -- a log line likely leaked in: ${exporter.stdout.slice(0, 300)}`,
    );
    assert.ok(
      exporter.stderr.includes('Effective configuration'),
      'the config summary must be on stderr in --dump-raw mode, not silently dropped or on stdout',
    );
  } finally {
    upstream.close();
  }
});
