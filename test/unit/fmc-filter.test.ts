import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAggregateMetricsUrl, buildFmcFilter } from '../../src/backends/fmc/filter.ts';
import { METRIC_FAMILY_VALUES, TIME_RANGE_VALUES } from '../../src/config/types.ts';

const SAMPLE_UUID = '395e114a-cc97-11ed-a71f-c6cf66a8f073';

test('buildFmcFilter: exact string equality against the DESIGN.md/Appendix C reference form', () => {
  const filter = buildFmcFilter(SAMPLE_UUID, 'CPU', '5m');
  assert.equal(filter, 'device_uuid:395e114a-cc97-11ed-a71f-c6cf66a8f073;metric:CPU;timeRange:5m');
  assert.ok(!filter.endsWith(';'), 'no trailing semicolon');
  assert.ok(!filter.includes(' '), 'no stray spaces');
});

test('buildFmcFilter: every family x every time range produces a well-formed string', () => {
  for (const family of METRIC_FAMILY_VALUES) {
    for (const timeRange of TIME_RANGE_VALUES) {
      const filter = buildFmcFilter(SAMPLE_UUID, family, timeRange);
      assert.equal(filter, `device_uuid:${SAMPLE_UUID};metric:${family};timeRange:${timeRange}`);
    }
  }
});

test('buildAggregateMetricsUrl: percent-encodes the filter value in the form Appendix C confirms FMC accepts', () => {
  const url = buildAggregateMetricsUrl(
    'fmc.example.internal',
    '00000000-0000-4000-8000-000000000002',
    SAMPLE_UUID,
    'CPU',
    '5m',
  );
  const parsed = new URL(url);
  assert.equal(
    parsed.searchParams.get('filter'),
    `device_uuid:${SAMPLE_UUID};metric:CPU;timeRange:5m`,
    'the decoded value round-trips exactly',
  );
  assert.ok(url.includes('filter=device_uuid%3A'), 'colons are percent-encoded in the raw URL');
  assert.ok(url.includes('%3Bmetric%3A'), 'semicolons are percent-encoded in the raw URL');
});

test('buildFmcFilter: a device UUID containing unexpected characters is rejected, never silently truncated at a delimiter', () => {
  assert.throws(
    () => buildFmcFilter('not-a-uuid;metric:MEM', 'CPU', '5m'),
    /not a well-formed device UUID/,
  );
  assert.throws(() => buildFmcFilter('', 'CPU', '5m'));
  assert.throws(() => buildFmcFilter(`${SAMPLE_UUID};metric:HACKED`, 'CPU', '5m'));
});
