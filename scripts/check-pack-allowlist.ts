/**
 * CI tripwire for the `npm` job in release.yml (DESIGN.md §9.7's "files is
 * an allowlist" control). Runs `npm pack --dry-run --json` and asserts
 * every packed path is covered by `package.json`'s own `files` array (plus
 * the two entries npm always includes regardless of `files`: `package.json`
 * itself, and a root `LICENSE`).
 *
 * A prior version of this check was a denylist -- four known-bad prefixes
 * (`.env`, `data/`, `.scratch/`, an unsanitized fixture path) -- found by
 * review to be the same control-scoping gap the Stage 13B .dockerignore
 * review already found once: it enumerates specific bad shapes rather than
 * asserting the actual allowlist, so a stray `*.pem`/`*.key` at the repo
 * root, or a future widening of `files`, ships to npm with this tripwire
 * still reporting green. This version inverts it: anything NOT explicitly
 * covered by `files` fails, by construction.
 *
 * Not part of the shipped package. Usage:
 * node --experimental-strip-types scripts/check-pack-allowlist.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { findDisallowed } from './pack-allowlist.ts';

interface PackEntry {
  files: Array<{ path: string }>;
}

// shell:true is required for npm resolution on Windows (dev-machine use);
// no user input reaches this call.
const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const pack: PackEntry[] = JSON.parse(raw);
const files = pack[0]?.files.map((f) => f.path) ?? [];

const pkg: { files?: string[] } = JSON.parse(readFileSync('package.json', 'utf8'));
const filesAllowlist = pkg.files ?? [];

const disallowed = findDisallowed(files, filesAllowlist);
if (disallowed.length > 0) {
  process.stderr.write(`Packed files not covered by package.json's "files" allowlist:\n`);
  for (const f of disallowed) {
    process.stderr.write(`  ${f}\n`);
  }
  process.exit(1);
}
process.stdout.write(`${files.length} files packed, all covered by the "files" allowlist.\n`);
