/**
 * CI backstop for the `licenses` job in ci.yml (Stage 14, DESIGN.md §9.7).
 * `license-checker-rseidelsohn --onlyAllow` accepts an SPDX compound
 * expression (e.g. "(MIT AND GPL-3.0)") as passing if its *individual*
 * disjuncts/conjuncts happen to appear in the allowlist string, even for an
 * `AND` expression -- which is wrong, since `AND` means both licenses'
 * obligations apply simultaneously, and a copyleft conjunct is exactly what
 * a compliance gate exists to catch. Verified directly: a synthetic
 * "(MIT AND GPL-3.0)" dependency passes --onlyAllow with the allowlist used
 * in ci.yml, while a bare "GPL-3.0" correctly fails.
 *
 * This script re-reads the same `--json` output and fails on any license
 * string containing the word "AND" (case-insensitive), or that is
 * UNKNOWN/blank. Run after the --onlyAllow step, not instead of it --
 * --onlyAllow is still the correct first-line check for simple/OR
 * expressions.
 *
 * Not part of the shipped package. Usage:
 * node --experimental-strip-types scripts/check-license-compound.ts
 */
import { execFileSync } from 'node:child_process';
import { findOffenders, type LicenseEntry } from './license-compound.ts';

// shell:true is required for npx resolution on Windows (dev-machine use);
// every argument here is a static literal, never user input, so this is
// not a command-injection risk despite the shell hop.
const raw = execFileSync(
  'npx',
  ['--yes', 'license-checker-rseidelsohn@4.4.2', '--production', '--json'],
  { encoding: 'utf8', shell: process.platform === 'win32' },
);
const data: Record<string, LicenseEntry> = JSON.parse(raw);
const offenders = findOffenders(data);

if (offenders.length > 0) {
  process.stderr.write('Found dependencies with a compound (AND) or unknown license:\n');
  for (const o of offenders) {
    process.stderr.write(`  ${o.name}: ${o.license}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  'No compound (AND) or unknown licenses found among production dependencies.\n',
);
