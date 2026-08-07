/**
 * Branded wrapper so a credential can never be interpolated into a string,
 * logged, or JSON.stringify'd as its raw value by accident (DESIGN.md §9.4 —
 * "no code path prints the raw config object"). The only way to obtain the
 * real value is the explicit `reveal()` call, which every genuine caller
 * (the backend adapters building an Authorization header) must use
 * deliberately, so an accidental leak requires an accidental `reveal()`
 * call rather than an accidental template-string interpolation.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }
}
