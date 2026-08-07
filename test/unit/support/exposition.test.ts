import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExposition } from './exposition.ts';

/**
 * Guards for the test-only strict exposition parser itself (support/
 * exposition.ts) — findings 4 and 5 from the Stage 3 adversarial review:
 * the parser whitelisted "Nan" (exactly the value DESIGN.md §4.8 forbids
 * emitting) and mis-split a label value ending in a literal backslash.
 */

test('parseExposition rejects a "Nan" sample value — DESIGN.md §4.8 forbids emitting NaN under any circumstance', () => {
  const text = ['# HELP ftd_test test', '# TYPE ftd_test gauge', 'ftd_test Nan', ''].join('\n');
  assert.throws(() => parseExposition(text), /invalid sample value/);
});

test('parseExposition rejects "NaN" and "nan" too', () => {
  for (const value of ['NaN', 'nan']) {
    const text = ['# HELP ftd_test test', '# TYPE ftd_test gauge', `ftd_test ${value}`, ''].join(
      '\n',
    );
    assert.throws(() => parseExposition(text), /invalid sample value/);
  }
});

test('parseExposition correctly splits a label value ending in one literal backslash from the label that follows it', () => {
  // prom-client escapes a literal backslash as \\ before the closing quote,
  // e.g. interface_name="trail\\" — the quote right before the comma is a
  // real closing quote (preceded by an *escaped* backslash, i.e. an even
  // count), not an escaped quote itself.
  const text = [
    '# HELP ftd_test test',
    '# TYPE ftd_test gauge',
    String.raw`ftd_test{a="trail\\",b="next"} 1`,
    '',
  ].join('\n');
  const families = parseExposition(text);
  const sample = families[0]?.samples[0];
  assert.ok(sample);
  assert.equal(sample.labels.a, 'trail\\');
  assert.equal(sample.labels.b, 'next');
});

test('parseExposition correctly handles an escaped quote inside a label value', () => {
  const text = [
    '# HELP ftd_test test',
    '# TYPE ftd_test gauge',
    String.raw`ftd_test{a="say \"hi\""} 1`,
    '',
  ].join('\n');
  const families = parseExposition(text);
  const sample = families[0]?.samples[0];
  assert.ok(sample);
  assert.equal(sample.labels.a, 'say "hi"');
});
