/**
 * The single sanctioned output path (DESIGN.md §2.6). Every log line is
 * produced here, and every log line passes through `redact()` before
 * serialization — this is what makes redaction a boundary property
 * rather than a call-site convention (DESIGN.md §9.4).
 *
 * Hand-rolled per DESIGN.md §2.6's recommendation, to hold runtime
 * dependencies at two (`prom-client`, `undici`). Not a `pino` reimplementation.
 */

import { redact } from './redact.ts';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogFormat = 'json' | 'text';

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const VALID_LEVELS: ReadonlySet<string> = new Set(Object.keys(LEVEL_RANK));
const VALID_FORMATS: ReadonlySet<string> = new Set(['json', 'text']);

export type LogMeta = Record<string, unknown>;

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  backend?: string;
  version?: string;
  sink?: (line: string) => void;
}

export interface Logger {
  error(message: string, meta?: LogMeta | Error): void;
  warn(message: string, meta?: LogMeta | Error): void;
  info(message: string, meta?: LogMeta | Error): void;
  debug(message: string, meta?: LogMeta | Error): void;
  /** Returns a new logger with `bindings` merged into every subsequent line, e.g. per-device `device_uid`. */
  child(bindings: LogMeta): Logger;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

function defaultSink(line: string): void {
  process.stdout.write(line);
}

function envLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return raw !== undefined && VALID_LEVELS.has(raw) ? (raw as LogLevel) : 'info';
}

function envFormat(): LogFormat {
  const raw = process.env.LOG_FORMAT;
  return raw !== undefined && VALID_FORMATS.has(raw) ? (raw as LogFormat) : 'json';
}

/**
 * Escapes embedded newlines so one logical field can never forge
 * additional physical output lines (review finding R6) — a device name
 * or other upstream-controlled string containing `\n` would otherwise
 * split one `sink()` call into two physical lines, the second
 * indistinguishable from a genuine log line at any severity. JSON mode
 * is unaffected: `JSON.stringify` already escapes `\n` as `\\n` inside a
 * string value.
 */
function escapeNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\\n');
}

function formatTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return escapeNewlines(value);
  }
  try {
    return escapeNewlines(JSON.stringify(value) ?? String(value));
  } catch {
    return escapeNewlines(String(value));
  }
}

function formatText(fields: Record<string, unknown>): string {
  const { time, level, message, ...rest } = fields;
  const restEntries = Object.entries(rest);
  const suffix =
    restEntries.length > 0
      ? ` ${restEntries.map(([key, value]) => `${key}=${formatTextValue(value)}`).join(' ')}`
      : '';
  return `${escapeNewlines(String(time))} ${escapeNewlines(String(level).toUpperCase())} ${escapeNewlines(String(message))}${suffix}`;
}

interface ResolvedOptions {
  level: LogLevel;
  format: LogFormat;
  sink: (line: string) => void;
}

/**
 * Fields whose value is stamped by the logger itself and must never be
 * overridable by caller-supplied `meta` — review finding R5: building
 * `rawFields` and then spreading `meta` over it unconditionally let a
 * meta object with a `level`/`message`/`time`/`backend` key silently
 * re-stamp severity or forge a timestamp. An upstream response body that
 * happens to have its own `message` field (Cisco's APIs do) is enough to
 * trigger this without any malicious intent.
 */
const RESERVED_FIELDS = new Set(['time', 'level', 'message']);

function buildLine(
  format: LogFormat,
  boundFields: Record<string, unknown>,
  level: LogLevel,
  message: string,
  meta: LogMeta | Error | undefined,
): string {
  const metaFields: Record<string, unknown> = {};
  if (meta instanceof Error) {
    metaFields.err = meta;
  } else if (isPlainObject(meta)) {
    for (const [key, value] of Object.entries(meta)) {
      if (RESERVED_FIELDS.has(key) || key in boundFields) {
        continue;
      }
      metaFields[key] = value;
    }
  } else if (meta !== undefined) {
    metaFields.meta = meta;
  }

  const rawFields: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    ...boundFields,
    message,
    ...metaFields,
  };

  const safeFields = redact(rawFields) as Record<string, unknown>;
  const body = format === 'json' ? JSON.stringify(safeFields) : formatText(safeFields);
  return `${body}\n`;
}

function createLoggerInternal(
  resolved: ResolvedOptions,
  boundFields: Record<string, unknown>,
): Logger {
  const write = (level: LogLevel, message: string, meta?: LogMeta | Error): void => {
    if (LEVEL_RANK[level] > LEVEL_RANK[resolved.level]) {
      return;
    }
    resolved.sink(buildLine(resolved.format, boundFields, level, message, meta));
  };

  return {
    error: (message, meta) => write('error', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
    child: (bindings) => createLoggerInternal(resolved, { ...boundFields, ...bindings }),
  };
}

/**
 * Creates a logger. `level`/`format` fall back to `LOG_LEVEL`/`LOG_FORMAT`
 * env vars (and then to `info`/`json`) when not passed explicitly, so a
 * caller can rely on env-driven defaults in production while tests inject
 * an explicit level, format, and sink for determinism.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const resolved: ResolvedOptions = {
    level: options.level ?? envLevel(),
    format: options.format ?? envFormat(),
    sink: options.sink ?? defaultSink,
  };

  const boundFields: Record<string, unknown> = {};
  if (options.backend !== undefined) {
    boundFields.backend = options.backend;
  }
  if (options.version !== undefined) {
    boundFields.version = options.version;
  }

  return createLoggerInternal(resolved, boundFields);
}
