/**
 * One-shot offline script that reads the raw captures in the gitignored
 * .scratch/ directory and writes sanitized, committable fixtures under
 * test/fixtures/ (DESIGN.md §9.7, §3.3.5; IMPLEMENTATION_PLAN.md Stage 1).
 *
 * Not part of the shipped package or the test run — invoked manually
 * whenever .scratch/ gains a new raw capture worth turning into a fixture.
 * All real device names, hostnames, and the lab FMC host:port are replaced
 * via an explicit exact-match table loaded from the gitignored
 * .scratch/sanitize-replacements.json (over-sanitizing structural values
 * like interface hardware ids would destroy the signal the mappers depend
 * on — see the "over-sanitization" risk in IMPLEMENTATION_PLAN.md Stage 1),
 * and every UUID/IPv4 substring is replaced generically by the shared
 * Sanitizer. The replacement table itself names real internal lab
 * identifiers, so it lives next to the raw captures it describes rather
 * than in this committed script — this script and .scratch/ both already
 * only exist together on a machine with real capture access.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeUuidOrIpv4, Sanitizer } from '../src/util/sanitize.ts';

const scratchDir = fileURLToPath(new URL('../.scratch', import.meta.url));
const fixturesDir = fileURLToPath(new URL('../test/fixtures', import.meta.url));

// One Sanitizer instance so the same real UUID/IP maps to the same
// placeholder across every file processed in this run.
const sanitizer = new Sanitizer();

const replacementsPath = `${scratchDir}/sanitize-replacements.json`;
const replacementsTable: Record<string, string> = JSON.parse(
  readFileSync(replacementsPath, 'utf8'),
);

// Replacement values must never look like a UUID or IPv4 address — the
// generic sweep below runs after this table and would re-match its own
// output, silently reshaping a replacement into a different (still-safe,
// but inconsistent) placeholder. This exact failure mode corrupted a real
// value once (a Snort version string collided with the IPv4 pattern); the
// guard below now makes a recurrence a startup error instead of a silent
// re-sweep.
const exactReplacements = new Map<string, string>(Object.entries(replacementsTable));

for (const replacementValue of exactReplacements.values()) {
  if (looksLikeUuidOrIpv4(replacementValue)) {
    throw new Error(
      `exactReplacements value "${replacementValue}" looks like a UUID or IPv4 address — it would be re-swept by the generic pass and produce an inconsistent result. Use a hostname- or token-shaped placeholder instead.`,
    );
  }
}

interface Job {
  source: string;
  dest: string;
}

const jobs: Job[] = [
  { source: 'scc_health_metrics.json', dest: 'scc/full-live.json' },
  { source: 'scc_health_metrics_recheck.json', dest: 'scc/cpu-group-absent.json' },
  { source: 'fmc_CPU.json', dest: 'fmc/cpu.json' },
  { source: 'fmc_MEM.json', dest: 'fmc/mem.json' },
  { source: 'fmc_DISK_STATS.json', dest: 'fmc/disk-stats.json' },
  { source: 'fmc_CHASSIS_STATS.json', dest: 'fmc/empty-family.json' },
  { source: 'fmc_INTERFACE_ftd1_recheck.json', dest: 'fmc/interface.json' },
  { source: 'fmc_INTERFACE_spoke1.json', dest: 'fmc/device-not-connected.json' },
  { source: 'fmc_fpinterfacestatistics.json', dest: 'fmc/unsupported-device.json' },
  { source: 'fmc_devices.json', dest: 'fmc/devicerecords-page1.json' },
];

for (const job of jobs) {
  const raw = readFileSync(`${scratchDir}/${job.source}`, 'utf8');
  const parsed = JSON.parse(raw);
  const cleaned = sanitizer.sanitize(parsed, { exactReplacements });
  const destPath = `${fixturesDir}/${job.dest}`;
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${job.dest}\n`);
}
