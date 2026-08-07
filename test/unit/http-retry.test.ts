import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatusCode, type HttpError } from '../../src/http/errors.ts';
import {
  BASE_DELAY_MS,
  CAP_DELAY_MS,
  computeBackoffMs,
  parseRetryAfterMs,
  RetriesExhaustedError,
  withRetry,
} from '../../src/http/retry.ts';
import { createFakeClock } from './support/fake-clock.ts';

interface FakeResponse {
  statusCode: number;
}

function resolveError(response: FakeResponse) {
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return undefined;
  }
  return classifyStatusCode(response.statusCode);
}

test('withRetry: 503, 503, 200 -> exactly 3 attempts, success returned', async () => {
  const clock = createFakeClock();
  const statuses = [503, 503, 200];
  let calls = 0;
  const result = await withRetry<FakeResponse>({
    clock,
    attempt: async () => {
      const statusCode = statuses[calls];
      calls++;
      return { statusCode: statusCode as number };
    },
    resolveError,
  });
  assert.equal(calls, 3);
  assert.equal(result.statusCode, 200);
});

test('withRetry: 503 x 4 -> gives up after 3 attempts, throws RetriesExhaustedError', async () => {
  const clock = createFakeClock();
  let calls = 0;
  await assert.rejects(
    withRetry<FakeResponse>({
      clock,
      attempt: async () => {
        calls++;
        return { statusCode: 503 };
      },
      resolveError,
    }),
    RetriesExhaustedError,
  );
  assert.equal(calls, 3, 'must not exceed MAX_ATTEMPTS even though the server never recovers');
});

test("RetriesExhaustedError preserves the last attempt's class/reason — a 429 that never recovers still reports reason=rate_limited, not unknown (Opus review F2)", async () => {
  const clock = createFakeClock();
  await assert.rejects(
    withRetry<FakeResponse>({
      clock,
      attempt: async () => ({ statusCode: 429 }),
      resolveError: (response) => classifyStatusCode(response.statusCode),
    }),
    (error: unknown) => {
      assert.ok(error instanceof RetriesExhaustedError);
      assert.equal(error.class, 'rate_limited');
      assert.equal(error.reason, 'rate_limited');
      return true;
    },
  );
});

test('RetriesExhaustedError preserves reason=http_5xx for an exhausted 503', async () => {
  const clock = createFakeClock();
  await assert.rejects(
    withRetry<FakeResponse>({
      clock,
      attempt: async () => ({ statusCode: 503 }),
      resolveError,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RetriesExhaustedError);
      assert.equal(error.reason, 'http_5xx');
      return true;
    },
  );
});

test('withRetry: an already-classified HttpError thrown by beforeAttempt (via attempt()) propagates immediately if non-retryable, without being relabelled transient/network (Opus review F1)', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const authFatal = classifyStatusCode(401);
  await assert.rejects(
    withRetry<FakeResponse>({
      clock,
      attempt: async () => {
        calls++;
        throw authFatal;
      },
      resolveError,
    }),
    (error: unknown) => {
      assert.equal(
        error,
        authFatal,
        'must be the exact same HttpError instance, not a re-wrapped one',
      );
      assert.equal((error as HttpError).class, 'auth_fatal');
      assert.equal((error as HttpError).reason, 'auth');
      return true;
    },
  );
  assert.equal(calls, 1, 'a non-retryable classified error must not be retried');
});

test('withRetry: an already-classified retryable HttpError thrown by attempt() is retried using its own class, not misclassified as network', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const rateLimited = classifyStatusCode(429, 10);
  const result = await withRetry<FakeResponse>({
    clock,
    attempt: async () => {
      calls++;
      if (calls < 2) {
        throw rateLimited;
      }
      return { statusCode: 200 };
    },
    resolveError,
  });
  assert.equal(calls, 2);
  assert.equal(result.statusCode, 200);
});

for (const statusCode of [400, 401, 403]) {
  test(`withRetry: ${statusCode} is not retried at all (single attempt, throws immediately)`, async () => {
    const clock = createFakeClock();
    let calls = 0;
    await assert.rejects(
      withRetry<FakeResponse>({
        clock,
        attempt: async () => {
          calls++;
          return { statusCode };
        },
        resolveError,
      }),
    );
    assert.equal(calls, 1);
  });
}

test('withRetry: delays stay within the jittered [0, min(cap, base*2^n)] envelope', async () => {
  const clock = createFakeClock();
  const delays: number[] = [];
  let calls = 0;
  await withRetry<FakeResponse>({
    clock,
    attempt: async () => {
      calls++;
      return { statusCode: calls < 3 ? 503 : 200 };
    },
    resolveError,
    onRetry: (_error, _attemptNumber, delayMs) => {
      delays.push(delayMs);
    },
  });
  assert.equal(delays.length, 2);
  assert.ok(
    (delays[0] as number) >= 0 &&
      (delays[0] as number) <= Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** 0),
  );
  assert.ok(
    (delays[1] as number) >= 0 &&
      (delays[1] as number) <= Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** 1),
  );
});

test('withRetry: 429 with Retry-After honors the exact delay rather than jittered backoff', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const observedDelays: number[] = [];
  const result = await withRetry<FakeResponse & { retryAfterMs?: number }>({
    clock,
    attempt: async () => {
      calls++;
      return calls === 1 ? { statusCode: 429, retryAfterMs: 5000 } : { statusCode: 200 };
    },
    resolveError: (response) => {
      if (response.statusCode === 429) {
        return classifyStatusCode(429, response.retryAfterMs);
      }
      return resolveError(response);
    },
    onRetry: (_error, _attemptNumber, delayMs) => {
      observedDelays.push(delayMs);
    },
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(observedDelays, [5000]);
});

test('withRetry: 429 with no Retry-After falls back to jittered backoff, not a fixed delay', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const observedDelays: number[] = [];
  await withRetry<FakeResponse>({
    clock,
    attempt: async () => {
      calls++;
      return calls === 1 ? { statusCode: 429 } : { statusCode: 200 };
    },
    resolveError,
    onRetry: (_error, _attemptNumber, delayMs) => {
      observedDelays.push(delayMs);
    },
  });
  assert.equal(observedDelays.length, 1);
  assert.ok((observedDelays[0] as number) <= BASE_DELAY_MS);
});

test('withRetry: a network-level throw (not a resolved response) is classified and retried the same way', async () => {
  const clock = createFakeClock();
  let calls = 0;
  const result = await withRetry<FakeResponse>({
    clock,
    attempt: async () => {
      calls++;
      if (calls < 2) {
        throw new Error('connect ECONNRESET');
      }
      return { statusCode: 200 };
    },
    resolveError,
  });
  assert.equal(calls, 2);
  assert.equal(result.statusCode, 200);
});

test('parseRetryAfterMs: digit-only value parses as seconds', () => {
  assert.equal(parseRetryAfterMs('5', 0), 5000);
});

test('parseRetryAfterMs: HTTP-date value parses relative to wallNowMs, not as a bogus number-of-seconds', () => {
  const wallNow = Date.parse('Wed, 21 Oct 2026 07:27:00 GMT');
  const retryAfter = 'Wed, 21 Oct 2026 07:27:03 GMT';
  const delayMs = parseRetryAfterMs(retryAfter, wallNow);
  assert.equal(delayMs, 3_000);
});

test('parseRetryAfterMs: a past HTTP-date clamps to 0, not negative', () => {
  const wallNow = Date.parse('Wed, 21 Oct 2026 07:30:00 GMT');
  const retryAfter = 'Wed, 21 Oct 2026 07:00:00 GMT';
  assert.equal(parseRetryAfterMs(retryAfter, wallNow), 0);
});

test('parseRetryAfterMs: undefined header -> undefined', () => {
  assert.equal(parseRetryAfterMs(undefined, 0), undefined);
});

test('parseRetryAfterMs: garbage value -> undefined, not NaN or a wild number', () => {
  assert.equal(parseRetryAfterMs('not-a-valid-header', 0), undefined);
});

test('parseRetryAfterMs: a legal-but-huge seconds value is capped at CAP_DELAY_MS, not honored verbatim (Opus review F3)', () => {
  assert.equal(parseRetryAfterMs('86400', 0), CAP_DELAY_MS);
});

test('parseRetryAfterMs: a legal-but-huge HTTP-date value is capped at CAP_DELAY_MS', () => {
  const wallNow = Date.parse('Wed, 21 Oct 2026 07:27:00 GMT');
  const retryAfter = 'Thu, 22 Oct 2026 07:27:00 GMT';
  assert.equal(parseRetryAfterMs(retryAfter, wallNow), CAP_DELAY_MS);
});

test('parseRetryAfterMs: a decimal value ("5.5") is rejected, not silently misparsed as a near-zero date delta (Opus review F3)', () => {
  assert.equal(parseRetryAfterMs('5.5', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT')), undefined);
});

test('parseRetryAfterMs: a negative-looking value ("-5") is rejected, not silently misparsed', () => {
  assert.equal(parseRetryAfterMs('-5', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT')), undefined);
});

test('parseRetryAfterMs: "0" is honored as an immediate retry, not treated as absent', () => {
  assert.equal(parseRetryAfterMs('0', 0), 0);
});

test('computeBackoffMs: envelope grows exponentially but never exceeds the cap', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const delay = computeBackoffMs(attempt);
    assert.ok(delay >= 0);
    assert.ok(delay <= CAP_DELAY_MS);
  }
});
