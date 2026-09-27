import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import binaryen from 'binaryen';
import { built, runBase, runVera, ROOT } from './helpers.mjs';
import { readLayout } from '../runtime/vera.mjs';
import { buildApp, haveClang } from '../tools/vera-build.mjs';
import { instrument } from '../tools/instrument.mjs';

test('build: translation helpers are fully inlined and layout is embedded', () => {
  const { vera, base } = built('apps/fuzz.c');
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/fuzz.info.json'), 'utf8'));
  assert.ok(info.instrument.loadsFast > 0 && info.instrument.storesFast > 0);
  assert.ok(info.instrument.loadsSlow > 0, 'packed accesses take the byte-wise path');
  assert.equal(info.instrument.remainingHelperCalls, 0);
  const layout = readLayout(new WebAssembly.Module(vera));
  assert.equal(layout.format, 'vera-webswap/1');
  assert.equal(layout.vbase, 0x10000000);
  assert.ok(layout.heapBase < layout.vbase);
  assert.ok(vera.length < 200_000, 'no multi-MiB zero page-table segment in the binary');
  assert.ok(base.length > 0);
});

// cflags that change how clang writes the runtime: -fPIC reads the page
// table address through the (constant) __memory_base global, -O0 through
// locals, and at -O0 the slow paths of softmmu.c would use the shadow stack
// (tools/vera-build.mjs always optimizes softmmu.c).
test('build: position-independent (-fPIC) and unoptimized (-O0) programs match the ordinary build', { skip: !haveClang() && 'needs clang' }, async () => {
  for (const cflags of [['-fPIC'], ['-O0']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-cflags-'));
    try {
      const info = buildApp([path.join(ROOT, 'apps/fuzz.c')], path.join(dir, 'fuzz'), { cflags });
      assert.deepEqual(info.instrument.warnings, [], cflags.join(' '));
      assert.ok(info.instrument.inlineFunctions > 0 && info.instrument.tlbEntries > 0, 'the inline walk and the TLB are used');
      const vera = fs.readFileSync(path.join(dir, 'fuzz.vera.wasm'));
      const base = fs.readFileSync(path.join(dir, 'fuzz.base.wasm'));
      const ref = await runBase(base, [4, 20_000, 3]);
      assert.equal(ref.status, 0);
      for (const poolBytes of [64 << 10, 1 << 20]) {
        const r = await runVera(vera, [4, 20_000, 3], { poolBytes });
        assert.equal(r.value, ref.value, `${cflags.join(' ')}, pool ${poolBytes >> 10} KiB`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// A minimal module linked like softmmu.c: helpers, slow paths, page table.
function mmuModule({ ptAddr = '(i32.const 65536)', slowBody = '(local.get 0)' } = {}) {
  const wat = `(module
    (import "env" "memory" (memory 2))
    (import "vera" "trap" (func $__vera_trap (param i32 i32)))
    (global $__stack_pointer (mut i32) (i32.const 65536))
    (global $hb (mut i32) (i32.const 1024))
    (global $memory_base i32 (i32.const 0))
    (export "__heap_base" (global $hb))
    (func $__vera_tl (param i32 i32) (result i32) (local.get 0))
    (func $__vera_ts (param i32 i32) (result i32) (local.get 0))
    (func $__vera_tl_slow (param i32 i32) (result i32) ${slowBody})
    (func $__vera_ts_slow (param i32 i32) (result i32) (local.get 0))
    (func $__vera_pt_addr (result i32) ${ptAddr})
    (func $f (export "f") (param i32) (result i32) (i32.load (local.get 0))))`;
  const m = binaryen.parseText(wat);
  m.setFeatures(binaryen.Features.All);
  binaryen.setDebugInfo(true); // keep the name section: instrument() finds helpers by name
  const bin = m.emitBinary();
  binaryen.setDebugInfo(false);
  m.dispose();
  return bin;
}

test('instrument: the page table address is read through immutable globals and locals', () => {
  for (const ptAddr of [
    '(i32.add (global.get $memory_base) (i32.const 65536))', // -fPIC
    '(local i32) (local.set 0 (i32.const 65536)) (return (local.get 0))', // -O0
  ]) {
    const { report } = instrument(mmuModule({ ptAddr }), { optimize: false });
    assert.deepEqual(report.warnings, []);
    assert.equal(report.inlineFunctions, 1, ptAddr);
  }
  // Not a constant at all: every access calls __vera_tl/__vera_ts, with a warning.
  const { report } = instrument(mmuModule({ ptAddr: '(i32.add (global.get $hb) (i32.const 64))' }), { optimize: false });
  assert.equal(report.inlineFunctions, 0);
  assert.match(report.warnings.join('\n'), /not a constant/);
});

test('instrument: a slow path that uses the shadow stack is refused', () => {
  const body = '(global.set $__stack_pointer (i32.sub (global.get $__stack_pointer) (i32.const 16))) (local.get 0)';
  assert.throws(() => instrument(mmuModule({ slowBody: body }), { optimize: false }), /__vera_tl_slow uses the shadow stack/);
});
