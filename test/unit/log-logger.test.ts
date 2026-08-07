import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../../src/log/logger.ts';

const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.super-secret-payload.signature';

function captureSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

function parseLines(lines: string[]): unknown[] {
  return lines.map((line) => {
    assert.ok(line.endsWith('\n'), `line not newline-terminated: ${JSON.stringify(line)}`);
    return JSON.parse(line.slice(0, -1));
  });
}

/**
 * Testing step 1 — the §9.4 canonical test: a realistic undici-shaped
 * error with an attached request carrying an Authorization header, plus a
 * nested cause with the same shape, passed through logger.error. The
 * assertion greps the RAW captured output, not just that some redaction
 * function ran.
 */
test('logger.error never leaks a bearer token from an undici-shaped error, including its cause chain', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'debug', format: 'json', sink });

  const cause = new Error('socket hang up') as Error & Record<string, unknown>;
  cause.request = {
    method: 'GET',
    url: 'https://fmc.example.com/api/v1/devices',
    headers: { authorization: `Bearer ${SECRET_TOKEN}` },
  };

  const err = new Error('Request failed') as Error & Record<string, unknown>;
  err.request = {
    method: 'GET',
    path: '/api/v1/devices?filter=device_uuid:abc',
    headers: {
      authorization: `Bearer ${SECRET_TOKEN}`,
      'x-auth-refresh-token': SECRET_TOKEN,
    },
  };
  err.response = { statusCode: 401 };
  (err as Error & { cause?: unknown }).cause = cause;

  logger.error('upstream request failed', { err });

  const rawOutput = lines.join('');
  assert.ok(!rawOutput.includes(SECRET_TOKEN), 'secret token found in raw log output');
  assert.ok(!rawOutput.toLowerCase().includes('bearer eyj'));
});

/**
 * Testing step 2: logging the frozen config object at debug produces no
 * SCC_API_TOKEN or FMC_PASSWORD value in output. Built as a plain inline
 * object shaped like the config loader's output, per Stage 5's scope
 * decision not to import the (parallel, in-progress) Stage 4 module.
 */
test('logging the frozen config object at debug redacts SCC_API_TOKEN and FMC_PASSWORD', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'debug', format: 'json', sink });

  const config = Object.freeze({
    BACKEND: 'fmc',
    FMC_BASE_URL: 'https://fmc.example.com',
    FMC_USERNAME: 'exporter-readonly',
    FMC_PASSWORD: 'super-secret-password',
    SCC_API_TOKEN: SECRET_TOKEN,
    POLL_INTERVAL_SECONDS: 60,
  });

  logger.debug('startup config', { config });

  const rawOutput = lines.join('');
  assert.ok(!rawOutput.includes('super-secret-password'));
  assert.ok(!rawOutput.includes(SECRET_TOKEN));
  const [parsed] = parseLines(lines) as [{ config: Record<string, unknown> }];
  assert.equal(parsed.config.FMC_PASSWORD, '[REDACTED]');
  assert.equal(parsed.config.SCC_API_TOKEN, '[REDACTED]');
  assert.equal(parsed.config.FMC_USERNAME, 'exporter-readonly');
});

// --- Testing step 3/4 are covered directly in log-redact.test.ts against
// redact() itself; repeated here at the logger boundary to prove the
// integration, not just the underlying function. ---

test('logger redacts a sensitive key nested at depth, at the logger boundary', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', sink });
  logger.info('nested secret', { a: { b: { authorization: 'x' } } });
  const [parsed] = parseLines(lines) as [{ a: { b: { authorization: string } } }];
  assert.equal(parsed.a.b.authorization, '[REDACTED]');
});

test('logger redaction is case-insensitive for key names at the boundary', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', sink });
  logger.info('case variants', {
    Authorization: 'a',
    AUTHORIZATION: 'b',
    'x-Auth-Access-Token': 'c',
  });
  const [parsed] = parseLines(lines) as [Record<string, string>];
  assert.equal(parsed.Authorization, '[REDACTED]');
  assert.equal(parsed.AUTHORIZATION, '[REDACTED]');
  assert.equal(parsed['x-Auth-Access-Token'], '[REDACTED]');
});

/** Testing step 5: false-positive guard, at the logger boundary. */
test('logger does not mangle a device named token-gateway-01', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', sink });
  logger.info('device seen', { device_name: 'token-gateway-01' });
  const [parsed] = parseLines(lines) as [{ device_name: string }];
  assert.equal(parsed.device_name, 'token-gateway-01');
});

/** Testing step 6: URL sanitization surfaced through a logged field. */
test('logger sanitizes a URL field, keeping keys but redacting query values', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'debug', format: 'json', sink });
  logger.debug('request sent', {
    url: 'https://fmc.example.com/api?filter=device_uuid:abc;metric:CPU',
  });
  const rawOutput = lines.join('');
  assert.ok(!rawOutput.includes('device_uuid:abc'));
  assert.ok(rawOutput.includes('filter='));
});

/** Testing step 7: cycles and non-serializable values. */
test('logger does not throw and does not drop the line for cycles or non-serializable values', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', sink });

  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;

  assert.doesNotThrow(() => {
    logger.info('weird payload', {
      cyclic,
      big: 10n,
      fn: () => 'x',
      sym: Symbol('s'),
    });
  });
  assert.equal(lines.length, 1);
  const [parsed] = parseLines(lines) as [{ cyclic: { self: unknown } }];
  assert.equal(parsed.cyclic.self, '[Circular]');
});

/**
 * Testing step 8: level filtering. At LOG_LEVEL=info, debug lines are
 * absent; at debug, per-request URLs appear but response bodies never do.
 */
test('level filtering: at level info, debug lines are absent', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', sink });
  logger.debug('should not appear', {});
  logger.info('should appear', {});
  assert.equal(lines.length, 1);
  const [parsed] = parseLines(lines) as [{ message: string }];
  assert.equal(parsed.message, 'should appear');
});

test('level filtering: at level debug, per-request URLs appear but response bodies are never logged by this call site convention', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'debug', format: 'json', sink });
  logger.debug('request', { url: '/api/v1/devices', responseSize: 4096 });
  const [parsed] = parseLines(lines) as [{ url: string; responseSize: number; body?: unknown }];
  assert.equal(parsed.url, '/api/v1/devices');
  assert.equal(parsed.responseSize, 4096);
  assert.equal(parsed.body, undefined);
});

/**
 * Testing step 9: JSON output is one valid JSON object per line,
 * newline-terminated, with no interleaving under rapid concurrent writes.
 */
test('JSON output is one valid object per line under rapid concurrent synchronous writes', async () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', sink });

  const total = 500;
  await Promise.all(
    Array.from({ length: total }, (_, i) =>
      Promise.resolve().then(() => logger.info('concurrent line', { i })),
    ),
  );

  assert.equal(lines.length, total);
  const parsed = parseLines(lines) as { i: number }[];
  const seen = new Set(parsed.map((p) => p.i));
  assert.equal(seen.size, total);
  for (let i = 0; i < total; i++) {
    assert.ok(seen.has(i), `missing index ${i}`);
  }
});

/** Testing step 10: text mode applies the same redaction as json mode. */
test('LOG_FORMAT text applies the same redaction as json mode', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'text', sink });
  logger.info('login attempt', { authorization: `Bearer ${SECRET_TOKEN}`, password: 'hunter2' });
  const rawOutput = lines.join('');
  assert.ok(!rawOutput.includes(SECRET_TOKEN));
  assert.ok(!rawOutput.includes('hunter2'));
  assert.ok(rawOutput.includes('INFO'));
  assert.ok(rawOutput.includes('login attempt'));
});

test('LOG_FORMAT text produces one human-readable line per call', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'text', backend: 'fmc', sink });
  logger.info('poll complete', { devices: 12 });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /INFO poll complete/);
  assert.match(lines[0] ?? '', /backend=fmc/);
  assert.match(lines[0] ?? '', /devices=12/);
});

/**
 * Testing step 11: header allowlist. An unlisted header is absent from
 * output entirely, proving allowlist (not denylist-with-redaction)
 * semantics.
 */
test('an unlisted header is absent from output entirely, not redacted-and-present', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'debug', format: 'json', sink });
  logger.debug('response headers', {
    headers: {
      'content-type': 'application/json',
      'x-new-auth-thing': 'super-secret-value',
    },
  });
  const [parsed] = parseLines(lines) as [{ headers: Record<string, unknown> }];
  assert.equal(parsed.headers['content-type'], 'application/json');
  assert.equal('x-new-auth-thing' in parsed.headers, false);
  const rawOutput = lines.join('');
  assert.ok(!rawOutput.includes('super-secret-value'));
});

// --- Additional coverage: base fields, child loggers ---------------------

test('base fields (backend, version) are bound once at construction and present on every line', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({
    level: 'info',
    format: 'json',
    backend: 'scc',
    version: '0.1.0',
    sink,
  });
  logger.info('first');
  logger.info('second');
  const parsed = parseLines(lines) as { backend: string; version: string }[];
  for (const line of parsed) {
    assert.equal(line.backend, 'scc');
    assert.equal(line.version, '0.1.0');
  }
});

test('child logger merges device_uid into every subsequent line without mutating the parent', () => {
  const { lines, sink } = captureSink();
  const parent = createLogger({ level: 'info', format: 'json', backend: 'fmc', sink });
  const child = parent.child({ device_uid: 'device-123' });

  child.info('device event');
  parent.info('parent event');

  const parsed = parseLines(lines) as Record<string, unknown>[];
  assert.equal(parsed[0]?.device_uid, 'device-123');
  assert.equal(parsed[1]?.device_uid, undefined);
});

test('every line carries a level and an ISO-8601 time field', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', sink });
  logger.warn('something odd');
  const [parsed] = parseLines(lines) as [{ level: string; time: string }];
  assert.equal(parsed.level, 'warn');
  assert.doesNotThrow(() => new Date(parsed.time).toISOString());
});

// --- Regression tests for adversarial review findings R5, R6 -----------

test('R5: a meta field named level/time/message cannot override the logger-stamped values', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'debug', format: 'json', backend: 'fmc', sink });
  logger.error('real error message', {
    level: 'debug',
    time: 'FORGED-TIME',
    message: 'forged message',
  });
  const [parsed] = parseLines(lines) as [{ level: string; time: string; message: string }];
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.message, 'real error message');
  assert.notEqual(parsed.time, 'FORGED-TIME');
});

test('R5: a meta field named backend cannot override the bound base field', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', backend: 'fmc', sink });
  logger.info('poll complete', { backend: 'scc-forged' });
  const [parsed] = parseLines(lines) as [{ backend: string }];
  assert.equal(parsed.backend, 'fmc');
});

test('R5: a meta field named device_uid cannot override a child logger binding', () => {
  const { lines, sink } = captureSink();
  const parent = createLogger({ level: 'info', format: 'json', sink });
  const child = parent.child({ device_uid: 'real-device' });
  child.info('event', { device_uid: 'forged-device' });
  const [parsed] = parseLines(lines) as [{ device_uid: string }];
  assert.equal(parsed.device_uid, 'real-device');
});

test('R6: an embedded newline in a text-mode field cannot forge an additional physical log line', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'text', sink });
  logger.info('device seen', {
    device_name: 'fw01\n2026-08-03T09:00:00.000Z ERROR token refresh failed',
  });
  assert.equal(lines.length, 1, 'one logger call must produce exactly one physical line');
  const rawOutput = lines.join('');
  assert.equal(
    rawOutput.split('\n').length,
    2,
    'exactly one newline: the trailing line terminator',
  );
  assert.ok(rawOutput.includes('\\n'), 'the embedded newline must be escaped, not literal');
});

test('R6: text mode escapes newlines the same way for the message field itself', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'text', sink });
  logger.info('line one\nFORGED ERROR line two');
  assert.equal(lines.length, 1);
  assert.equal(lines.join('').split('\n').length, 2);
});

// --- Regression test for Stage 7 review finding F6/F1: a meta object
// whose keys merely resemble error-shape hints (statusCode/cause/status/
// request/response/options) must not collapse the whole log line -------

test('R11: a meta object with a statusCode key does not collapse the log line to an error shape', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'error', format: 'json', backend: 'scc', sink });
  const child = logger.child({ device_uid: 'device-123' });
  child.error('SCC auth failed', { statusCode: 401, reason: 'auth' });
  const [parsed] = parseLines(lines) as [
    { time: string; level: string; backend: string; device_uid: string; message: string },
  ];
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.backend, 'scc');
  assert.equal(parsed.device_uid, 'device-123');
  assert.equal(parsed.message, 'SCC auth failed');
  assert.doesNotThrow(() => new Date(parsed.time).toISOString());
});

test('R11: a meta object with a cause key does not collapse the log line to an error shape', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'info', format: 'json', backend: 'fmc', sink });
  logger.warn('discovery failed', { cause: 'timeout', devices_discovered: 4 });
  const [parsed] = parseLines(lines) as [
    { level: string; backend: string; message: string; devices_discovered: number },
  ];
  assert.equal(parsed.level, 'warn');
  assert.equal(parsed.backend, 'fmc');
  assert.equal(parsed.message, 'discovery failed');
  assert.equal(parsed.devices_discovered, 4);
});

test('R11: a genuine nested Error under a meta key is still normalized to the narrow shape', () => {
  const { lines, sink } = captureSink();
  const logger = createLogger({ level: 'error', format: 'json', sink });
  const err = new Error('boom') as Error & Record<string, unknown>;
  err.statusCode = 503;
  logger.error('request failed', { err });
  const [parsed] = parseLines(lines) as [{ err: { message: string; statusCode: number } }];
  assert.equal(parsed.err.message, 'boom');
  assert.equal(parsed.err.statusCode, 503);
});
