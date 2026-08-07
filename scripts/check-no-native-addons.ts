/**
 * CI check (Stage 14, DESIGN.md §5.1/§12.4 "no native build step"): walks a
 * node_modules tree and fails if anything would trigger a native
 * compilation step at install time.
 *
 * A prior version of this check only grepped raw package.json text for the
 * string "install", which had two real failure modes found by review: (1) a
 * package with `"gypfile": true` and a `binding.gyp` but no `scripts` block
 * triggers a real `node-gyp rebuild` yet the grep saw nothing; (2) a
 * dependency with any field merely *containing* the substring "install"
 * (a package literally named `install`, a keyword, a bin entry) tripped the
 * grep with nothing native going on at all. This version parses each
 * package.json as JSON and checks the actual `scripts.install`/
 * `preinstall`/`postinstall` keys, `gypfile`, a sibling `binding.gyp`, and
 * any shipped `*.node` prebuilt binary (which proves a native step already
 * ran somewhere, even if this exact package's own manifest looks clean).
 *
 * Usage: node --experimental-strip-types scripts/check-no-native-addons.ts [root]
 * Defaults to ./node_modules. Exits 1 and prints every offending package on
 * a hit; exits 0 with no output otherwise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Finding {
  path: string;
  reason: string;
}

function walk(dir: string, findings: Finding[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      if (entry.endsWith('.node')) {
        findings.push({ path: full, reason: 'ships a prebuilt *.node binary' });
      }
      continue;
    }
    const pkgJsonPath = join(full, 'package.json');
    try {
      const pkg: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (pkg !== null && typeof pkg === 'object') {
        const record = pkg as Record<string, unknown>;
        const scripts = record.scripts;
        if (scripts !== null && typeof scripts === 'object') {
          for (const key of ['install', 'preinstall', 'postinstall']) {
            const value = (scripts as Record<string, unknown>)[key];
            if (typeof value === 'string' && value.trim().length > 0) {
              findings.push({ path: pkgJsonPath, reason: `declares a "${key}" lifecycle script` });
            }
          }
        }
        if (record.gypfile === true) {
          findings.push({ path: pkgJsonPath, reason: 'declares "gypfile": true' });
        }
      }
    } catch {
      // No package.json at this level, or unparseable -- not this check's concern.
    }
    try {
      statSync(join(full, 'binding.gyp'));
      findings.push({ path: join(full, 'binding.gyp'), reason: 'ships a binding.gyp' });
    } catch {
      // No binding.gyp -- expected for the overwhelming majority of packages.
    }
    walk(full, findings);
  }
}

const root = process.argv[2] ?? 'node_modules';
const findings: Finding[] = [];
walk(root, findings);

if (findings.length > 0) {
  process.stderr.write('Found packages that would trigger a native build step:\n');
  for (const f of findings) {
    process.stderr.write(`  ${f.path}: ${f.reason}\n`);
  }
  process.exit(1);
}
process.stdout.write('No native build step indicators found.\n');
