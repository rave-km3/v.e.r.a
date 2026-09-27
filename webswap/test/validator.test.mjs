import test from 'node:test';
import assert from 'node:assert/strict';
import binaryen from 'binaryen';
import { instrument } from '../tools/instrument.mjs';

// A minimal module that has the runtime helpers (so instrument() gets past
// its own sanity checks) plus one function using `body`.
function moduleWith(body, locals = '') {
  const wat = `(module
    (import "env" "memory" (memory 1))
    (import "vera" "trap" (func $__vera_trap (param i32 i32)))
    (global $__stack_pointer (mut i32) (i32.const 65536))
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

test('a store whose value loads memory translates its address LAST', () => {
  // Inspect the emitted code: [set $p addr] [set $v (load ...)] [store (call __vera_ts $p) $v]
  const bin = moduleWith('(i32.store (local.get 0) (i32.load (local.get 1)))', '(param i32 i32)');
  const { binary } = instrument(bin, { optimize: false });
  const m = binaryen.readBinary(binary);
  const fname = binaryen.getExportInfo(m.getExport('f')).value; // names are not kept in the output
  const body = binaryen.getFunctionInfo(m.getFunction(fname)).body;
  const top = binaryen.getExpressionInfo(body);
  const candidates = [top, ...(top.children || []).map((k) => binaryen.getExpressionInfo(k))];
  const block = candidates.find((i) => i.id === binaryen.BlockId && i.children.length === 3);
  assert.ok(block, 'ordered-store block present');
  const [setP, setV, store] = block.children.map((c) => binaryen.getExpressionInfo(c));
  assert.equal(setP.id, binaryen.LocalSetId);
  assert.equal(setV.id, binaryen.LocalSetId);
  assert.equal(binaryen.getExpressionInfo(setV.value).id, binaryen.LoadId, 'value (a load) is evaluated second');
  assert.equal(store.id, binaryen.StoreId);
  const ptr = binaryen.getExpressionInfo(store.ptr);
  assert.equal(ptr.id, binaryen.CallId);
  assert.equal(ptr.target, '__vera_ts', 'translation happens inside the store, after the value');
  m.dispose();
});

test('every write to the stack pointer gets an overflow check', () => {
  const bin = moduleWith('(global.set $__stack_pointer (i32.sub (global.get $__stack_pointer) (i32.const 16)))');
  const { report } = instrument(bin, { optimize: false });
  assert.equal(report.stackChecks, 1);
  assert.equal(report.stackTop, 65536);
});

test('vbase must be a multiple of 64 KiB', () => {
  const bin = moduleWith('(nop)');
  assert.throws(() => instrument(bin, { vbase: 0x10000800 }), /multiple of 64 KiB/);
  assert.throws(() => instrument(bin, { vbase: 0 }), /multiple of 64 KiB/);
});

test('constant addresses below VBASE are left alone', () => {
  const bin = moduleWith('(i32.store (i32.const 64) (i32.const 1))');
  const { report } = instrument(bin, { optimize: false });
  assert.equal(report.skippedConst, 1);
  assert.equal(report.storesFast, 0);
});
