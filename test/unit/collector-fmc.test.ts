import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mapFmcFamilyResponse, mergeFmcFamilies } from '../../src/backends/fmc/map.ts';
import type {
  FmcAggregateMetricsResponse,
  FmcMetricFamily,
} from '../../src/backends/fmc/schema.ts';
import { createTestRenderer } from './support/render.ts';

function loadFixture(relativePath: string): FmcAggregateMetricsResponse {
  const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));
  return JSON.parse(readFileSync(`${fixturesDir}/${relativePath}`, 'utf8'));
}

function loadGolden(name: string): string {
  const goldenDir = fileURLToPath(new URL('../fixtures/golden', import.meta.url));
  return readFileSync(`${goldenDir}/${name}`, 'utf8');
}

const DEVICE_UID = '00000000-0000-4000-8000-000000000003';
const DEVICE_NAME = 'ftd-fmc-lab-01';

test('golden: FMC per-family responses merged into one snapshot render byte-exact expected exposition text, including ftd_interface_duplex_info', async () => {
  const families: Array<[FmcMetricFamily, string]> = [
    ['CPU', 'fmc/cpu.json'],
    ['MEM', 'fmc/mem.json'],
    ['DISK_STATS', 'fmc/disk-stats.json'],
    ['INTERFACE', 'fmc/interface.json'],
  ];
  const results = families.map(([family, file]) =>
    mapFmcFamilyResponse(loadFixture(file), family, DEVICE_UID),
  );
  const merged = mergeFmcFamilies(DEVICE_UID, DEVICE_NAME, results);
  assert.deepEqual(merged.parseErrors, []);
  assert.ok(merged.snapshot);

  const renderer = createTestRenderer();
  renderer.render([merged.snapshot]);
  const text = await renderer.text();
  assert.equal(text, loadGolden('fmc-merged.prom'));
});

test('FMC empty-family absence renders no series for that family, not zeros', async () => {
  const result = mapFmcFamilyResponse(
    loadFixture('fmc/empty-family.json'),
    'CHASSIS_STATS',
    DEVICE_UID,
  );
  assert.equal(result.partial.chassis, undefined);
  assert.deepEqual(result.parseErrors, []);

  const merged = mergeFmcFamilies(DEVICE_UID, DEVICE_NAME, [
    mapFmcFamilyResponse(loadFixture('fmc/cpu.json'), 'CPU', DEVICE_UID),
    result,
  ]);
  assert.ok(merged.snapshot);
  assert.equal(merged.snapshot.chassis, undefined);

  const renderer = createTestRenderer();
  renderer.render([merged.snapshot]);
  const text = await renderer.text();
  assert.doesNotMatch(text, /ftd_chassis_fan_rpm\{[^}]/);
});
