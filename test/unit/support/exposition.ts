/**
 * A strict, hand-rolled Prometheus exposition-format parser for test use
 * (IMPLEMENTATION_PLAN.md Stage 3 test 2 — "parse with a strict parser").
 * `promtool` is not available in this environment, so this asserts the
 * subset of the format this project actually emits: HELP immediately
 * followed by TYPE for every metric family, well-formed label syntax, and
 * numeric (or Nan/+Inf/-Inf) sample values. It intentionally rejects
 * anything it cannot account for rather than silently accepting it.
 */

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Deliberately excludes NaN in any casing: DESIGN.md §4.8 forbids emitting
// NaN under any circumstance, so this strict parser must reject it rather
// than accept prom-client's "Nan" rendering as a valid sample value.
const NUMERIC_VALUE = /^([+-]?Inf|[+-]?\d+(\.\d+)?(e[+-]?\d+)?)$/i;

export interface ParsedSample {
  metricName: string;
  labels: Record<string, string>;
  value: number | string;
}

export interface ParsedFamily {
  name: string;
  help: string;
  type: string;
  samples: ParsedSample[];
}

/**
 * A quote is escaped only when preceded by an odd number of backslashes —
 * `\"` is an escaped quote, `\\"` is an escaped backslash followed by a
 * real closing quote, `\\\"` is an escaped backslash followed by an
 * escaped quote, and so on. Checking only the single preceding character
 * (as an earlier version of this parser did) misclassifies the `\\"` case,
 * which is exactly the shape prom-client emits for a label value ending in
 * one literal backslash.
 */
function precedingBackslashesAreEven(text: string, quoteIndex: number): boolean {
  let count = 0;
  let i = quoteIndex - 1;
  while (i >= 0 && text[i] === '\\') {
    count++;
    i--;
  }
  return count % 2 === 0;
}

/**
 * Reverses prom-client's label-value escaping (registry.js's
 * `escapeLabelValue`: backslash -> `\\`, newline -> `\n`, quote -> `\"`,
 * applied in that order). A single left-to-right pass handles all three
 * escape sequences without the ordering hazards of chained global
 * `replace()` calls.
 */
function unescapeLabelValue(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === '\\') {
        result += '\\';
        i++;
        continue;
      }
      if (next === 'n') {
        result += '\n';
        i++;
        continue;
      }
      if (next === '"') {
        result += '"';
        i++;
        continue;
      }
    }
    result += value[i];
  }
  return result;
}

function parseLabels(labelPart: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (labelPart.length === 0) return labels;
  // Split on `,` that is not inside a quoted value.
  const pairs: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < labelPart.length; i++) {
    const ch = labelPart[i];
    if (ch === '"' && precedingBackslashesAreEven(labelPart, i)) inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      pairs.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) pairs.push(current);

  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`malformed label pair: "${pair}"`);
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (!LABEL_NAME.test(name)) throw new Error(`invalid label name: "${name}"`);
    if (!(value.startsWith('"') && value.endsWith('"'))) {
      throw new Error(`label value not quoted: "${value}"`);
    }
    value = unescapeLabelValue(value.slice(1, -1));
    if (name in labels) throw new Error(`duplicate label "${name}" in one sample`);
    labels[name] = value;
  }
  return labels;
}

function parseSampleLine(line: string): ParsedSample {
  const braceStart = line.indexOf('{');
  let metricName: string;
  let rest: string;
  let labels: Record<string, string> = {};

  if (braceStart === -1) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) throw new Error(`sample line has no value: "${line}"`);
    metricName = line.slice(0, spaceIdx);
    rest = line.slice(spaceIdx + 1);
  } else {
    metricName = line.slice(0, braceStart);
    const braceEnd = line.indexOf('}', braceStart);
    if (braceEnd === -1) throw new Error(`unterminated label set: "${line}"`);
    labels = parseLabels(line.slice(braceStart + 1, braceEnd));
    rest = line.slice(braceEnd + 1).trim();
  }

  if (!METRIC_NAME.test(metricName)) throw new Error(`invalid metric name: "${metricName}"`);
  const valueStr = rest.trim();
  if (!NUMERIC_VALUE.test(valueStr))
    throw new Error(`invalid sample value: "${valueStr}" on line "${line}"`);

  return {
    metricName,
    labels,
    value: Number.isNaN(Number(valueStr)) ? valueStr : Number(valueStr),
  };
}

/**
 * Parses a full exposition-format document into one `ParsedFamily` per
 * `# HELP`/`# TYPE` pair, in document order. Throws on any line that does
 * not fit the grammar this project emits.
 */
export function parseExposition(text: string): ParsedFamily[] {
  const lines = text.split('\n');
  const families: ParsedFamily[] = [];
  let i = 0;
  const seenNames = new Set<string>();

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line === '') {
      i++;
      continue;
    }
    if (!line.startsWith('# HELP ')) {
      throw new Error(`expected "# HELP" line, got: "${line}" (line ${i + 1})`);
    }
    const helpMatch = /^# HELP (\S+) (.*)$/.exec(line);
    if (!helpMatch) throw new Error(`malformed HELP line: "${line}"`);
    const [, name, help] = helpMatch;
    if (name === undefined || help === undefined) throw new Error(`malformed HELP line: "${line}"`);
    if (seenNames.has(name)) throw new Error(`duplicate metric family: "${name}"`);
    seenNames.add(name);
    i++;

    const typeLine = lines[i];
    if (typeLine === undefined || !typeLine.startsWith('# TYPE ')) {
      throw new Error(
        `expected "# TYPE" line immediately after HELP for "${name}", got: "${typeLine}"`,
      );
    }
    const typeMatch = /^# TYPE (\S+) (\S+)$/.exec(typeLine);
    if (!typeMatch) throw new Error(`malformed TYPE line: "${typeLine}"`);
    const [, typeName, type] = typeMatch;
    if (typeName !== name)
      throw new Error(`TYPE line name "${typeName}" does not match HELP name "${name}"`);
    if (type === undefined) throw new Error(`malformed TYPE line: "${typeLine}"`);
    i++;

    const samples: ParsedSample[] = [];
    while (i < lines.length) {
      const sampleLine = lines[i];
      if (sampleLine === undefined || sampleLine === '' || sampleLine.startsWith('# HELP')) break;
      samples.push(parseSampleLine(sampleLine));
      i++;
    }

    families.push({ name, help, type, samples });
  }

  return families;
}
