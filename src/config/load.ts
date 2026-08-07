import { existsSync } from 'node:fs';
import { deepFreeze } from './deep-freeze.ts';
import type { AppConfig } from './types.ts';
import { type ConfigWarning, validate } from './validate.ts';

const ENV_FILE_FLAG_PREFIX = '--env-file=';
const ENV_FILE_FLAG_STANDALONE = '--env-file';

/**
 * Resolves the `.env` path to load: `--env-file=<path>` / `--env-file <path>`
 * if present in argv, otherwise the default `.env` in the current working
 * directory. Mirrors Node's own `--env-file` CLI flag naming (DESIGN.md
 * §2.4) so the convention is familiar. Note this loader's own parsing is
 * mostly unreachable in practice on the documented `node dist/index.js
 * --env-file=...` invocation: Node itself recognizes and consumes
 * `--env-file` in *any* argv position, including after the script name, and
 * exits directly (its own error, exit code 9) on a missing/unreadable path
 * before this function or `loadEnvFile` below ever runs — verified on Node
 * 26. This function's own error handling still matters for direct
 * programmatic callers (e.g. tests) and for `--` argv-shielded invocations.
 *
 * `--env-file` with no following value returns `null` (distinct from
 * `undefined`, which means "no flag was given at all") so a caller can
 * tell the difference between "use the default" and "the operator asked
 * for an explicit file and typed nothing" — the latter must be a startup
 * error, not a silent fall-through to the default.
 */
export function resolveEnvFilePath(argv: readonly string[]): string | undefined | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith(ENV_FILE_FLAG_PREFIX)) {
      return arg.slice(ENV_FILE_FLAG_PREFIX.length);
    }
    if (arg === ENV_FILE_FLAG_STANDALONE) {
      return argv[i + 1] ?? null;
    }
  }
  return '.env';
}

/**
 * Loads `.env` (if present) into `process.env`, then validates and freezes
 * the effective configuration. Process-environment values that are already
 * set win over `.env` contents (DESIGN.md §2.4) — verified directly against
 * Node 26's `process.loadEnvFile()`: it does not overwrite a key that
 * already exists in `process.env`, so no manual precedence logic is needed
 * here, only calling it in the right order (before reading `process.env`).
 *
 * A missing `.env` file is not an error — it is the expected case for
 * Docker/Kubernetes deployments that inject configuration directly into the
 * process environment (DESIGN.md §2.4). Any other failure to read an
 * *explicitly requested* `--env-file` (e.g. permission denied, not just
 * missing) is surfaced as a startup error rather than silently ignored.
 */
export function loadEnvFile(path: string | undefined, explicit: boolean): void {
  if (path === undefined) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // process.loadEnvFile() reports a Windows permission denial (e.g. an
    // icacls-restricted .env unreadable by the running account) as ENOENT,
    // not EPERM/EACCES — verified on Node 26 against a .env whose DACL grants
    // only SYSTEM: readFileSync/openSync correctly report EPERM, but
    // loadEnvFile reports ENOENT indistinguishably from a genuinely missing
    // file. Trusting that ENOENT below would silently treat an unreadable
    // file as absent, surfacing a bare "BACKEND_TYPE is unset" instead of the
    // real cause. statSync (via existsSync) still succeeds on such a file —
    // directory traversal is intact, only the file's own DACL denies read —
    // so it is what actually distinguishes "missing" from "present but
    // unreadable", and must be checked before trusting the ENOENT.
    if (code === 'ENOENT' && existsSync(path)) {
      throw new Error(
        `Env file "${path}" exists but could not be read — check its file permissions ` +
          `(on Windows, the account running the exporter needs read access; see the ` +
          `README's icacls procedure).`,
      );
    }
    if (code === 'ENOENT' && !explicit) {
      return;
    }
    throw new Error(`Failed to load env file "${path}": ${(err as Error).message}`);
  }
}

export interface LoadResult {
  config: AppConfig;
  warnings: ConfigWarning[];
}

/**
 * Top-level entry point: load `.env`, then validate `process.env` into a
 * frozen `AppConfig`. Throws `ConfigError` (carrying every accumulated
 * error message, not just the first — plan Stage 4 testing step 20) on any
 * validation failure; callers at the process boundary (src/index.ts) are
 * responsible for exiting non-zero with the message.
 */
export function loadConfig(argv: readonly string[] = process.argv.slice(2)): LoadResult {
  const explicitPath = argv.some(
    (arg) => arg === ENV_FILE_FLAG_STANDALONE || arg.startsWith(ENV_FILE_FLAG_PREFIX),
  );
  const envFilePath = resolveEnvFilePath(argv);
  if (envFilePath === null) {
    throw new Error('--env-file was given with no path');
  }
  loadEnvFile(envFilePath, explicitPath);

  const result = validate(process.env);
  if (!result.ok) {
    throw new ConfigError(result.errors, result.warnings);
  }

  return { config: deepFreeze(result.config), warnings: result.warnings };
}

export class ConfigError extends Error {
  readonly errors: readonly string[];
  readonly warnings: readonly ConfigWarning[];

  constructor(errors: readonly string[], warnings: readonly ConfigWarning[]) {
    super(ConfigError.formatMessage(errors));
    this.name = 'ConfigError';
    this.errors = errors;
    this.warnings = warnings;
  }

  private static formatMessage(errors: readonly string[]): string {
    if (errors.length === 1) {
      return `Invalid configuration: ${errors[0]}`;
    }
    return `Invalid configuration (${errors.length} errors):\n${errors
      .map((e, i) => `  ${i + 1}. ${e}`)
      .join('\n')}`;
  }
}
