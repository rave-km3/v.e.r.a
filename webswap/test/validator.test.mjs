import test from 'node:test';
import assert from 'node:assert/strict';
import binaryen from 'binaryen';
import { instrument } from '../tools/instrument.mjs';

// A minimal module that has the runtime helpers (so instrument() gets past
// its own sanity checks) plus one function using `body`.
function moduleWith(body, locals = '') {
  const wat = `(module
    (import "env" "memory" (memory 1))
    (global $hb (mut i32) (i32.const 1024))
    (export "__heap_base" (global $hb))
    (func $__vera_tl (param i32 i32) (result i32) (local.get 0))
    (func $__vera_ts (param i32 i32) (result i32) (local.get 0))
    (func $f (export "f") ${locals} ${body}))`;
  const m = binaryen.parseText(wat);
  m.setFeatures(binaryen.Features.All);
  binaryen.setDebugInfo(true); // keep the name section: instrument() finds helpers by name
  const bin = m.emitBinary();
  binaryen.setDebugInfo(false);
  m.dispose();
  return bin;
}

for (const [name, body, re] of [
  ['memory.copy', '(memory.copy (i32.const 0) (i32.const 8) (i32.const 8))', /bulk-memory/],
  ['memory.fill', '(memory.fill (i32.const 0) (i32.const 0) (i32.const 8))', /bulk-memory/],
  ['memory.grow', '(drop (memory.grow (i32.const 1)))', /memory\.grow/],
  ['SIMD', '(drop (v128.load (i32.const 0)))', /SIMD/],
  ['atomics', '(drop (i32.atomic.load (i32.const 0)))', /atomics/],
]) {
  test(`validator rejects ${name} with an explanation`, () => {
    assert.throws(() => instrument(moduleWith(body), { optimize: false }), re);
  });
}

test('validator accepts a plain MVP module and instruments it', () => {
  const bin = moduleWith('(i32.store (i32.const 0x10000000) (i32.load offset=4 (local.get 0)))', '(param i32)');
  const { report } = instrument(bin, { optimize: false });
  assert.equal(report.loadsFast, 1);
  assert.equal(report.storesFast, 1);
  assert.equal(report.storesWithTemps, 1, 'stored value is a load, so it is evaluated before translating');
});

test('constant addresses below VBASE are left alone', () => {
  const bin = moduleWith('(i32.store (i32.const 64) (i32.const 1))');
  const { report } = instrument(bin, { optimize: false });
  assert.equal(report.skippedConst, 1);
  assert.equal(report.storesFast, 0);
});
