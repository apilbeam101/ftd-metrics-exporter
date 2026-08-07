import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/**
 * IMPLEMENTATION_PLAN.md Stage 13B testing step 6: build the image with a
 * sentinel-bearing local .env present, then inspect every layer's actual
 * decompressed contents for the sentinel. DESIGN.md §6.2 calls .dockerignore
 * "a load-bearing security control" here, not housekeeping -- a stray local
 * .env baked into a layer is a real and common accident.
 *
 * Two things make a naive version of this test pass regardless of whether
 * .dockerignore actually works, verified directly against this Dockerfile:
 *
 * 1. A saved image's layer blobs are gzip-compressed (OCI/Docker
 *    tar-of-tars) -- grepping the outer `docker save` tar directly, without
 *    decompressing each layer first, can never find a plaintext string
 *    either way. Every blob is decompressed (or read raw, for the small
 *    uncompressed JSON manifest/config blobs) before searching.
 * 2. This Dockerfile's *runtime* stage never does a broad `COPY .` -- it
 *    only ever copies `dist/` and `package*.json` explicitly -- so the
 *    final tagged image can never contain `.env` regardless of
 *    .dockerignore's content; that stage is safe by construction. The
 *    build context (and thus .dockerignore) is only actually load-bearing
 *    for the intermediate `builder` stage, which does `COPY . .`. Confirmed
 *    by deliberately emptying .dockerignore's `.env` entry and rebuilding:
 *    the final image still had zero hits (architecture, not .dockerignore,
 *    protected it), while `docker build --target builder` produced a
 *    `/app/.env` file. This test therefore builds and inspects the
 *    `builder` stage, the one place .dockerignore's exclusion is the only
 *    thing standing between a local .env and a layer.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const SENTINEL = 'SENTINEL_SECRET_VALUE_DO_NOT_SHIP_38f1a2';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildDirFromRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftd-dockerignore-sentinel-'));
  for (const entry of [
    'Dockerfile',
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
  ]) {
    cpSync(join(repoRoot, entry), join(dir, entry));
  }
  cpSync(join(repoRoot, 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.env'), `${SENTINEL}=do-not-ship-this\n`);
  return dir;
}

/** Every blob in a `docker save` OCI layout, decompressed if gzip. */
function decompressedBlobs(extractedDir: string): Buffer[] {
  const blobsDir = join(extractedDir, 'blobs', 'sha256');
  return readdirSync(blobsDir).map((name) => {
    const raw = readFileSync(join(blobsDir, name));
    try {
      return gunzipSync(raw);
    } catch {
      return raw; // not gzip -- one of the small JSON manifest/config blobs
    }
  });
}

test('.dockerignore: a sentinel value in a local .env never reaches any built image layer', {
  skip: dockerAvailable() ? false : 'docker is not available in this environment',
  timeout: 180_000,
}, (t) => {
  const buildDir = buildDirFromRepo();
  const imageTag = `ftd-dockerignore-sentinel-test:${process.pid}`;
  const saveDir = mkdtempSync(join(tmpdir(), 'ftd-dockerignore-sentinel-save-'));
  t.after(() => {
    try {
      execFileSync('docker', ['rmi', imageTag], { stdio: 'ignore' });
    } catch {
      // best-effort cleanup
    }
    rmSync(buildDir, { recursive: true, force: true });
    rmSync(saveDir, { recursive: true, force: true });
  });

  execFileSync('docker', ['build', '--no-cache', '--target', 'builder', '-t', imageTag, buildDir], {
    stdio: 'ignore',
  });

  const tarPath = join(saveDir, 'image.tar');
  execFileSync('docker', ['save', imageTag, '-o', tarPath]);
  execFileSync('tar', ['xf', tarPath], { cwd: saveDir });

  const blobs = decompressedBlobs(saveDir);
  assert.ok(blobs.length > 0, 'expected at least one layer/manifest blob in the saved image');

  for (const blob of blobs) {
    assert.ok(
      !blob.includes(SENTINEL),
      'sentinel value from the local .env was found in a built image layer -- .dockerignore is not excluding .env',
    );
  }
});

/**
 * The test above only inspects the `builder` stage, since that is the only
 * stage where .dockerignore is load-bearing today (the runtime stage never
 * does a broad COPY). But that also means it cannot detect a *different*
 * regression: a future Dockerfile edit that adds a broad COPY to the
 * runtime stage. This is a positive-inventory check on the actual shipped
 * image, independent of .dockerignore, that closes that gap -- confirmed by
 * mutation-testing a `COPY . .` inserted into the runtime stage and
 * verifying this test fails against it (leaked src/, tsconfig.json, and a
 * planted credential file).
 */
test('shipped runtime image contains only dist/ and package manifests under /app -- no source, no stray files', {
  skip: dockerAvailable() ? false : 'docker is not available in this environment',
  timeout: 180_000,
}, (t) => {
  const buildDir = buildDirFromRepo();
  const imageTag = `ftd-runtime-inventory-test:${process.pid}`;
  t.after(() => {
    try {
      execFileSync('docker', ['rmi', imageTag], { stdio: 'ignore' });
    } catch {
      // best-effort cleanup
    }
    rmSync(buildDir, { recursive: true, force: true });
  });

  execFileSync('docker', ['build', '--no-cache', '-t', imageTag, buildDir], { stdio: 'ignore' });

  const listing = execFileSync('docker', [
    'run',
    '--rm',
    '--entrypoint',
    '/bin/sh',
    imageTag,
    '-c',
    'ls -A /app',
  ])
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  assert.deepEqual(
    [...listing].sort(),
    ['dist', 'node_modules', 'package-lock.json', 'package.json'],
    `expected /app to contain only dist/, node_modules/, and the package manifests; got: ${listing.join(', ')}`,
  );
});
