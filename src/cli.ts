/**
 * Minimal argument handling (DESIGN.md's "no CLI framework" choice carried
 * through from src/config/load.ts's own `--env-file` parsing). `--env-file`
 * itself is not inspected here — src/config/load.ts's `resolveEnvFilePath`
 * already owns that flag's parsing against the same `argv`, and duplicating
 * it here would risk the two disagreeing on what counts as "the path".
 * This module only decides which *mode* index.ts should run in.
 */

export type CliMode = 'run' | 'dump-raw' | 'version' | 'help';

export interface CliOptions {
  mode: CliMode;
}

export function parseCli(argv: readonly string[]): CliOptions {
  if (argv.includes('--version')) {
    return { mode: 'version' };
  }
  if (argv.includes('--help')) {
    return { mode: 'help' };
  }
  if (argv.includes('--dump-raw')) {
    return { mode: 'dump-raw' };
  }
  return { mode: 'run' };
}

export const HELP_TEXT = `ftd-metrics-exporter — Prometheus exporter for Cisco FTD firewall health metrics

Usage: ftd-metrics-exporter [options]

Options:
  --env-file[=<path>]  Load configuration from <path> instead of the default
                        ./.env. Values already present in the process
                        environment always win over the file's contents.
  --dump-raw           Perform one poll's worth of upstream requests and
                        write sanitized raw upstream JSON to stdout, then
                        exit. For contributing test fixtures (see
                        CONTRIBUTING.md) — never writes to disk, but the
                        output may still contain device names and topology
                        detail, so review before sharing.
  --version            Print the version and exit.
  --help               Print this help and exit.

Configuration is read entirely from environment variables — see example.env
for the full reference.
`;
