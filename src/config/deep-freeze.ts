/**
 * Recursively `Object.freeze`s an object graph (plan Stage 4 scope: "Deep
 * `Object.freeze` the final config object"). ESM modules run in strict mode,
 * so an attempted mutation of a frozen property throws `TypeError` rather
 * than failing silently — that is what makes freezing here an enforceable
 * guarantee rather than a hint.
 *
 * Cycle protection uses a `WeakSet`, not an `Object.isFrozen` short-circuit:
 * an object can be shallow-frozen (e.g. by a caller, or by a prior partial
 * `deepFreeze` call) while its children remain mutable, and an
 * `isFrozen`-based early return would skip recursing into those children —
 * silently defeating the "deep" half of this function's contract on
 * exactly the input it exists to handle defensively.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  return value;
}
