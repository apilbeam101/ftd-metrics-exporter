/**
 * Generic identifier sanitizer for raw upstream payloads.
 *
 * Used twice: once (offline, via scripts/sanitize-fixtures.ts) to produce
 * the committed test fixtures from real captures, and again at runtime by
 * `--dump-raw` (Stage 11) so a third-party contributor's capture is safe by
 * default before it ever leaves their environment (DESIGN.md §3.3.5).
 *
 * Strategy: replace every UUID-looking and IPv4-looking substring with a
 * deterministic placeholder from an RFC 4122/5737 documentation-safe range.
 * The same real value always maps to the same placeholder *for the
 * lifetime of one Sanitizer instance*, so cross-references — a device UUID
 * appearing both as `id` and inside a `links.self` query string, or the
 * same device across several files sanitized with one instance — stay
 * consistent. This is deliberately a safety net, not the primary defense:
 * it catches UUIDs and IPv4 addresses (the two identifier shapes actually
 * observed in these APIs) but not free-text device names or hostnames,
 * which callers must replace explicitly via `exactReplacements` — over-
 * sanitizing a name is cheap; under-sanitizing one is a real leak
 * (DESIGN.md §9.7).
 */

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/**
 * A dotted-quad is ambiguous with a dotted version-with-build-number string
 * (e.g. Snort's "3.9.3.1-61") — both are four period-separated numbers
 * under 256. The trailing negative lookahead excludes the version-string
 * shape specifically: a real IPv4 address is never immediately followed by
 * a hyphen and a digit, but a "<version>-<build>" string always is. This
 * fixed a real corruption where sanitizing a live FMC capture turned
 * "3.9.3.1-61" into "203.0.113.1-61".
 */
const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b(?!-\d)/g;

function placeholderUuid(index: number): string {
  const hex = index.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function placeholderIpv4(index: number): string {
  // RFC 5737 TEST-NET-3 — reserved for documentation, never routable.
  const last = index % 254;
  return `203.0.113.${last}`;
}

export interface SanitizeOptions {
  /** Exact substrings replaced verbatim before the generic UUID/IPv4 pass. */
  exactReplacements?: ReadonlyMap<string, string>;
}

/**
 * True if `value` itself looks like a UUID or an IPv4 address. A caller's
 * `exactReplacements` map must never map to a value like this — the generic
 * sweep runs after the exact pass and would re-match its own output,
 * silently reshaping it into a different (still-safe, but inconsistent)
 * placeholder. This is what the double-sweep bug in this file's history
 * looked like: a replacement value shaped like an IP got swept a second
 * time. Callers should assert `!looksLikeUuidOrIpv4(value)` for every
 * value in their exact-replacement table.
 */
export function looksLikeUuidOrIpv4(value: string): boolean {
  return (
    new RegExp(`^(?:${UUID_PATTERN.source})$`, 'i').test(value) ||
    new RegExp(`^(?:${IPV4_PATTERN.source})$`).test(value)
  );
}

export class Sanitizer {
  private readonly uuidMap = new Map<string, string>();
  private readonly ipv4Map = new Map<string, string>();

  private sanitizeString(input: string, exact: ReadonlyMap<string, string>): string {
    let result = input;
    for (const [from, to] of exact) {
      result = result.split(from).join(to);
    }
    result = result.replace(UUID_PATTERN, (match) => {
      const lower = match.toLowerCase();
      let placeholder = this.uuidMap.get(lower);
      if (!placeholder) {
        placeholder = placeholderUuid(this.uuidMap.size + 1);
        this.uuidMap.set(lower, placeholder);
      }
      return placeholder;
    });
    result = result.replace(IPV4_PATTERN, (match) => {
      let placeholder = this.ipv4Map.get(match);
      if (!placeholder) {
        placeholder = placeholderIpv4(this.ipv4Map.size + 1);
        this.ipv4Map.set(match, placeholder);
      }
      return placeholder;
    });
    return result;
  }

  /**
   * Deep-clones `value`, applying exact replacements first and then the
   * generic UUID/IPv4 sweep, recursively over every string found at any
   * nesting depth (objects, arrays, and top-level strings alike).
   */
  sanitize(value: unknown, options: SanitizeOptions = {}): unknown {
    const exact = options.exactReplacements ?? new Map<string, string>();

    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        return this.sanitizeString(node, exact);
      }
      if (Array.isArray(node)) {
        return node.map((item) => walk(item));
      }
      if (node !== null && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(node)) {
          out[key] = walk(val);
        }
        return out;
      }
      return node;
    };

    return walk(value);
  }
}

/** Convenience one-shot sanitize for a single value with no cross-call state. */
export function sanitize(value: unknown, options: SanitizeOptions = {}): unknown {
  return new Sanitizer().sanitize(value, options);
}
