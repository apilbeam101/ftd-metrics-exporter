import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepFreeze } from '../../src/config/deep-freeze.ts';

test('deepFreeze freezes the top-level object', () => {
  const obj = deepFreeze({ a: 1 });
  assert.throws(() => {
    (obj as { a: number }).a = 2;
  }, TypeError);
});

test('deepFreeze freezes nested objects', () => {
  const obj = deepFreeze({ nested: { b: 1 } });
  assert.throws(() => {
    (obj.nested as { b: number }).b = 2;
  }, TypeError);
});

test('deepFreeze freezes nested arrays and their contents', () => {
  const obj = deepFreeze({ list: [{ c: 1 }] });
  assert.throws(() => {
    (obj.list as unknown[]).push(2);
  }, TypeError);
  assert.throws(() => {
    (obj.list[0] as { c: number }).c = 2;
  }, TypeError);
});

test('deepFreeze does not throw on primitives, null, or already-frozen values', () => {
  assert.equal(deepFreeze(5), 5);
  assert.equal(deepFreeze('x'), 'x');
  assert.equal(deepFreeze(null), null);
  const frozen = Object.freeze({ d: 1 });
  assert.doesNotThrow(() => deepFreeze(frozen));
});

test('deepFreeze still recurses into the children of an already shallow-frozen parent', () => {
  // Regression: a parent frozen by something other than deepFreeze (or by a
  // prior partial call) must not cause its children to be skipped -- the
  // whole point of "deep" freezing is that a shallow freeze upstream cannot
  // hide a mutable subtree.
  const outer: { inner: { mutable: number } } = { inner: { mutable: 1 } };
  Object.freeze(outer);
  deepFreeze(outer);
  assert.throws(() => {
    outer.inner.mutable = 999;
  }, TypeError);
});

test('deepFreeze tolerates a cyclic object graph without infinite recursion', () => {
  const node: { self?: unknown } = {};
  node.self = node;
  assert.doesNotThrow(() => deepFreeze(node));
  assert.ok(Object.isFrozen(node));
});
