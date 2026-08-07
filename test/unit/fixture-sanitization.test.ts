import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Guards against real identifiers leaking back into committed fixtures
 * (DESIGN.md §9.7). If this test ever fails, do not "fix" it by adding an
 * exception — regenerate the fixture via scripts/sanitize-fixtures.ts, or
 * fix the hand-authored fixture's synthetic identifier to match the
 * placeholder shape below.
 *
 * This is an *inverse* assertion (every UUID/IPv4-shaped substring must be
 * a recognized placeholder) rather than a denylist of known-real values.
 * A denylist only catches identifiers someone thought to enumerate — it
 * would not catch a leaked UUID nobody remembered to list. The inverse
 * form needs no maintenance as new fixtures are added and catches any
 * real-shaped identifier by construction.
 *
 * Uses the same IPV4 pattern (including its version-string exclusion) as
 * src/util/sanitize.ts, so this test and the sanitizer agree on what
 * counts as an IPv4-shaped substring — see that file's history for why the
 * exclusion exists (a real value, a Snort version string, was once
 * corrupted by an earlier, looser pattern).
 */

const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b(?!-\d)/g;

// Placeholder UUIDs used across this fixture corpus: the sanitizer's
// generic sweep (src/util/sanitize.ts) mints `...-4000-8000-...`; hand- and
// script-authored synthetic fixtures use `...-4000-8000-...` or
// `...-4000-9000-...` for a distinguishable synthetic namespace.
const PLACEHOLDER_UUID = /^00000000-0000-4000-[89]000-[0-9a-f]{12}$/i;
// RFC 5737 TEST-NET-3 — the only IPv4 range this sanitizer ever emits.
const PLACEHOLDER_IPV4 = /^203\.0\.113\.\d{1,3}$/;

function listJsonFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      out.push(...listJsonFilesRecursive(fullPath));
    } else if (entry.endsWith('.json')) {
      out.push(fullPath);
    }
  }
  return out;
}

test('every UUID-shaped substring in every fixture is a recognized placeholder', () => {
  const files = listJsonFilesRecursive(fixturesDir);
  assert.ok(files.length > 0, 'expected at least one fixture file');

  const offenders: string[] = [];
  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    for (const match of contents.match(UUID_PATTERN) ?? []) {
      if (!PLACEHOLDER_UUID.test(match)) {
        offenders.push(`${file} contains non-placeholder UUID "${match}"`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test('every IPv4-shaped substring in every fixture is inside the TEST-NET-3 placeholder range', () => {
  const files = listJsonFilesRecursive(fixturesDir);

  const offenders: string[] = [];
  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    for (const match of contents.match(IPV4_PATTERN) ?? []) {
      if (!PLACEHOLDER_IPV4.test(match)) {
        offenders.push(`${file} contains non-placeholder IPv4 "${match}"`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

// The real lab identifiers this test denylists must not be hardcoded in a
// committed file (they'd be the exact leak this test exists to prevent) —
// loaded instead from the gitignored .scratch/sanitize-replacements.json
// that scripts/sanitize-fixtures.ts also reads. Skipped, not failed, when
// that file is absent (a fresh clone or CI has no .scratch/ at all): the
// inverse UUID/IPv4 assertions above already cover that environment.
const replacementsPath = fileURLToPath(
  new URL('../../.scratch/sanitize-replacements.json', import.meta.url),
);

test('no fixture contains a known real hostname or device-name fragment from the raw captures', (t) => {
  if (!existsSync(replacementsPath)) {
    t.skip('.scratch/sanitize-replacements.json not present in this environment');
    return;
  }

  const files = listJsonFilesRecursive(fixturesDir);
  const knownRealFragments = Object.keys(
    JSON.parse(readFileSync(replacementsPath, 'utf8')) as Record<string, string>,
  );

  const offenders: string[] = [];
  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    for (const fragment of knownRealFragments) {
      if (contents.includes(fragment)) {
        offenders.push(`${file} contains "${fragment}"`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test('every fixture file is valid JSON', () => {
  const files = listJsonFilesRecursive(fixturesDir);
  for (const file of files) {
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(file, 'utf8')),
      `${file} should parse as JSON`,
    );
  }
});
