import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
  new URL('../../scripts/check-no-native-addons.ts', import.meta.url),
);

function makeTree(
  packages: Record<string, { pkg: Record<string, unknown>; extraFiles?: Record<string, string> }>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'ftd-no-native-addons-test-'));
  const nodeModules = join(root, 'node_modules');
  for (const [name, { pkg, extraFiles }] of Object.entries(packages)) {
    const dir = join(nodeModules, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    for (const [file, contents] of Object.entries(extraFiles ?? {})) {
      writeFileSync(join(dir, file), contents);
    }
  }
  return nodeModules;
}

function run(nodeModulesDir: string): { status: number; output: string } {
  try {
    const output = execFileSync(
      'node',
      ['--experimental-strip-types', scriptPath, nodeModulesDir],
      {
        encoding: 'utf8',
      },
    );
    return { status: 0, output };
  } catch (error) {
    const err = error as { status: number; stderr: string };
    return { status: err.status, output: err.stderr };
  }
}

test('check-no-native-addons: a clean tree with no native indicators exits 0', () => {
  const dir = makeTree({
    'plain-pkg': { pkg: { name: 'plain-pkg', version: '1.0.0' } },
  });
  const result = run(dir);
  assert.equal(result.status, 0);
});

test('check-no-native-addons: a declared postinstall script is caught', () => {
  const dir = makeTree({
    'has-postinstall': {
      pkg: { name: 'has-postinstall', version: '1.0.0', scripts: { postinstall: 'node setup.js' } },
    },
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.output, /postinstall/);
});

test('check-no-native-addons: "gypfile": true with no scripts block is caught (the false-negative this check exists to close)', () => {
  const dir = makeTree({
    'fake-native': {
      pkg: { name: 'fake-native', version: '1.0.0', gypfile: true },
      extraFiles: { 'binding.gyp': '{"targets":[]}' },
    },
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.output, /gypfile/);
});

test('check-no-native-addons: a shipped *.node binary is caught even with a clean package.json', () => {
  const dir = makeTree({
    prebuilt: {
      pkg: { name: 'prebuilt', version: '1.0.0' },
      extraFiles: { 'addon.node': '' },
    },
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.output, /\*\.node/);
});

test('check-no-native-addons: a dependency literally named "install" or carrying it as a keyword does not false-positive', () => {
  const dir = makeTree({
    innocent: {
      pkg: {
        name: 'innocent',
        version: '1.0.0',
        dependencies: { install: '^0.13.0' },
        keywords: ['install'],
      },
    },
  });
  const result = run(dir);
  assert.equal(result.status, 0);
});
