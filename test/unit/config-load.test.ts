import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, loadConfig, resolveEnvFilePath } from '../../src/config/load.ts';

function makeEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ftd-config-load-test-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return path;
}

const REQUIRED_SCC_KEYS = ['BACKEND_TYPE', 'SCC_BASE_URL', 'SCC_API_TOKEN', 'SCC_FMC_UID'];

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of [...REQUIRED_SCC_KEYS, 'SCC_TIME_RANGE', 'FOO_CONFIG_LOAD_TEST']) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// 17. Process env overrides .env for the same key.
test('process env overrides .env for the same key', (t) => {
  const before = snapshotEnv();
  t.after(() => restoreEnv(before));

  const envPath = makeEnvFile(
    [
      'BACKEND_TYPE=scc',
      'SCC_BASE_URL=https://api.eu.security.cisco.com/firewall',
      'SCC_API_TOKEN=from-dotenv-token',
      'SCC_FMC_UID=00000000-0000-0000-0000-000000000000',
      'FOO_CONFIG_LOAD_TEST=from-dotenv',
    ].join('\n'),
  );

  for (const key of REQUIRED_SCC_KEYS) delete process.env[key];
  delete process.env.FOO_CONFIG_LOAD_TEST;
  process.env.SCC_API_TOKEN = 'from-process-env';

  const { config } = loadConfig(['--env-file', envPath]);

  assert.equal(process.env.FOO_CONFIG_LOAD_TEST, 'from-dotenv');
  assert.ok(config.backend.kind === 'scc');
  if (config.backend.kind === 'scc') {
    assert.equal(config.backend.apiToken.reveal(), 'from-process-env');
  }
});

test('resolveEnvFilePath honors --env-file=<path>', () => {
  assert.equal(resolveEnvFilePath(['--env-file=/tmp/custom.env']), '/tmp/custom.env');
});

test('resolveEnvFilePath honors --env-file <path> (space-separated)', () => {
  assert.equal(resolveEnvFilePath(['--env-file', '/tmp/custom2.env']), '/tmp/custom2.env');
});

test('resolveEnvFilePath defaults to .env when no flag is present', () => {
  assert.equal(resolveEnvFilePath([]), '.env');
});

// Regression (C1): --env-file with no following value must not silently
// fall through to the default .env -- the operator asked for an explicit
// file and typed nothing, which is a startup error, not "use the default".
test('regression (C1): resolveEnvFilePath returns null for a trailing --env-file with no value', () => {
  assert.equal(resolveEnvFilePath(['--env-file']), null);
});

test('regression (C1): loadConfig throws when --env-file is given with no path', (t) => {
  const before = snapshotEnv();
  t.after(() => restoreEnv(before));
  for (const key of REQUIRED_SCC_KEYS) delete process.env[key];

  assert.throws(() => loadConfig(['--env-file']), /--env-file was given with no path/);
});

test('a missing default .env is not an error (Docker/Kubernetes path with no .env file)', (t) => {
  const before = snapshotEnv();
  const previousCwd = process.cwd();
  t.after(() => {
    restoreEnv(before);
    process.chdir(previousCwd);
  });

  for (const key of REQUIRED_SCC_KEYS) delete process.env[key];
  process.env.BACKEND_TYPE = 'scc';
  process.env.SCC_BASE_URL = 'https://api.eu.security.cisco.com/firewall';
  process.env.SCC_API_TOKEN = 'process-only-token';
  process.env.SCC_FMC_UID = '00000000-0000-0000-0000-000000000000';

  // No --env-file flag at all -- resolveEnvFilePath defaults to ".env"
  // relative to cwd, which is deliberately empty here so the default
  // lookup path (not an explicit --env-file) is what's under test.
  const dir = mkdtempSync(join(tmpdir(), 'ftd-config-load-nofile-'));
  process.chdir(dir);

  const { config } = loadConfig([]);
  assert.equal(config.backend.kind, 'scc');
});

test('loadEnvFile: an explicitly-requested missing path is a startup error, not silently skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ftd-config-load-explicit-missing-'));
  const missingPath = join(dir, '.env');
  assert.throws(() => loadConfig(['--env-file', missingPath]), /Failed to load env file/);
});

test('an explicitly-requested --env-file that fails for a reason other than ENOENT surfaces as an error', (t) => {
  const before = snapshotEnv();
  t.after(() => restoreEnv(before));

  for (const key of REQUIRED_SCC_KEYS) delete process.env[key];

  const dir = mkdtempSync(join(tmpdir(), 'ftd-config-load-dir-'));
  // Passing a directory path makes the underlying read fail with EISDIR,
  // not ENOENT -- this must not be silently swallowed the way a missing
  // file is.
  assert.throws(() => loadConfig(['--env-file', dir]));
});

// Regression: process.loadEnvFile() reports a Windows ACL-denied .env as
// ENOENT, indistinguishable from a genuinely missing file, unless loadEnvFile
// checks existsSync() first. Windows-only: icacls is not available elsewhere,
// and POSIX's chmod-based equivalent of this failure already reports EACCES
// correctly (not the bug this test guards against).
//
// Denies read access to the current process's own SID explicitly, rather
// than granting access only to an unrelated principal (e.g. SYSTEM) and
// relying on every other account being excluded by omission -- the first
// real run of this test on GitHub's windows-latest runner found that
// grant-only-to-SYSTEM left the file still readable by whatever account
// actually ran the step, so loadConfig() never hit the permission-denied
// path at all. Resolved via PowerShell rather than `whoami`, since some
// Windows identity setups (e.g. a hybrid-AD-joined account name) can't be
// mapped to a SID by icacls from the account name alone -- a SID lookup
// is reliable across setups in a way an account-name lookup is not.
test('loadEnvFile: an existing but permission-denied .env is reported distinctly from a missing one', {
  skip: process.platform !== 'win32',
}, (t) => {
  const before = snapshotEnv();
  t.after(() => restoreEnv(before));
  for (const key of REQUIRED_SCC_KEYS) delete process.env[key];

  const dir = mkdtempSync(join(tmpdir(), 'ftd-config-load-denied-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'BACKEND_TYPE=scc\n');

  const sid = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8' },
  ).trim();

  execFileSync('icacls', [envPath, '/inheritance:r']);
  execFileSync('icacls', [envPath, '/deny', `*${sid}:(R)`]);
  t.after(() => execFileSync('icacls', [envPath, '/reset']));

  assert.throws(() => loadConfig(['--env-file', envPath]), /exists but could not be read/);
});

test('loadConfig throws ConfigError carrying every accumulated error message', (t) => {
  const before = snapshotEnv();
  t.after(() => restoreEnv(before));

  for (const key of REQUIRED_SCC_KEYS) delete process.env[key];
  process.env.BACKEND_TYPE = 'scc';

  const envPath = makeEnvFile('# intentionally empty -- no SCC_* keys here\n');

  assert.throws(
    () => loadConfig(['--env-file', envPath]),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.ok(err.errors.some((e) => e.includes('SCC_API_TOKEN')));
      assert.ok(err.errors.some((e) => e.includes('SCC_FMC_UID')));
      return true;
    },
  );
});
