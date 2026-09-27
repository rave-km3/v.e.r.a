// Same-base merging (tools/instrument.mjs): accesses through one pointer
// share one translation. These tests check that the merged code computes
// what the ordinary build computes while frames are evicted all the time,
// that the tests would notice a group spanning a possible fault, and which
// shapes of code are (not) merged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import binaryen from 'binaryen';
import { built, runBase, runVera, groupsSource, ROOT } from './helpers.mjs';
import { buildApp, haveClang } from '../tools/vera-build.mjs';
import { instrument } from '../tools/instrument.mjs';
import { createVera, instantiateBase } from '../runtime/vera.mjs';
import { MemoryBackend } from '../runtime/backends.mjs';

const POOL = 64 << 10; // 16 frames
const PAGES = [17, 18, 20, 24, 40];

test('merged groups (with fallbacks, branches, read-modify-writes) match the ordinary build under eviction', async () => {
  const { vera, base } = built('test/fixtures/merge.c');
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/merge.info.json'), 'utf8')).instrument;
  assert.ok(info.mergedGroups >= 4 && info.mergeFallbacks >= 3, `groups ${info.mergedGroups}, with fallback ${info.mergeFallbacks}`);
  assert.ok(info.mergePeeks >= 2, `groups that peek: ${info.mergePeeks}`);
  for (const npages of PAGES) {
    const ref = await runBase(base, [npages, 100_000, 3]);
    assert.equal(ref.status, 0);
    const r = await runVera(vera, [npages, 100_000, 3], { poolBytes: POOL });
    assert.equal(r.value, ref.value, `${npages} pages in a 16-frame pool`);
    assert.ok(r.stats.evictDirty > 1000, 'really paging');
  }
});

test('the merge test detects a group that spans another pointer\'s translation (mutation check)', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-merge-'));
  const info = buildApp([path.join(ROOT, 'test/fixtures/merge.c')], path.join(dir, 'merge'),
    { base: false, instrumentOptions: { unsafeMergeAcrossFaultsForTesting: true } });
  const broken = fs.readFileSync(path.join(dir, 'merge.vera.wasm'));
  fs.rmSync(dir, { recursive: true, force: true });
  const { base } = built('test/fixtures/merge.c');
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/merge.info.json'), 'utf8')).instrument;
  assert.ok(info.instrument.mergedGroups > good.mergedGroups, 'the broken build merges more');
  let caught = 0;
  for (const npages of PAGES) {
    const ref = await runBase(base, [npages, 100_000, 3]);
    const r = await runVera(broken, [npages, 100_000, 3], { poolBytes: POOL });
    if (r.value !== ref.value) caught++;
  }
  assert.ok(caught > 0, 'the deliberately broken build must produce a wrong result');
});

// The group's translation is done before the run. It must not fault a page
// the run does not touch: look() in merge.c reads a record's fields only in
// rare modes, and its branches test the mode, not the record.
test('merging: a group is not translated before branches that may skip all of it', async () => {
  const { vera, base } = built('test/fixtures/merge.c');
  const ops = 20_000;
  const ref = (await instantiateBase(base)).exports.guarded(64, ops, 5);
  const v = await createVera({ wasm: vera, poolBytes: POOL, backend: new MemoryBackend() });
  try {
    assert.equal(v.exports.guarded(64, ops, 5), ref);
    const { majorRead } = v.stats();
    // About 20 calls read a field; each group translated early read one page per call.
    assert.ok(majorRead < ops / 100, `${majorRead} storage reads for ${ops} calls`);
  } finally {
    v.close();
  }
});

// ... nor fault before a side effect that comes first in program order:
// when the fault fails (here: the backend throws), the effect has happened.
class FlakyBackend extends MemoryBackend {
  read(...args) {
    if (this.armed) { this.armed = false; throw new Error('EIO (injected)'); }
    return super.read(...args);
  }
}

test('merging: a failing fault leaves the side effects that come before the access', async () => {
  const { vera } = built('test/fixtures/merge.c');
  const backend = new FlakyBackend();
  const v = await createVera({ wasm: vera, poolBytes: POOL, backend });
  try {
    assert.equal(v.exports.setup_once(40), 0); // 40 pages through 16 frames: record 0's page is in storage
    backend.armed = true;
    assert.throws(() => v.exports.once(0, 0), /EIO/);
    assert.equal(v.exports.progress(), 7, 'progress = 7 comes before p->b in program order');
    assert.equal(v.exports.once(0, 0), 0, 'and the program still works');
  } finally {
    v.close();
  }
});

// ---- which code is merged: hand-written modules ---------------------------

// Stand-in MMU: identity translation; the group helpers (and peeks) return
// 0 (= use the per-access fallback) when the range crosses a 4 KiB page,
// like softmmu.c. peeks = false: an older runtime without peeks.
function moduleWith(body, locals = '', extra = '', { peeks = true } = {}) {
  const peek = peeks ? `
    (func $__vera_tl_peek (param i32 i32) (result i32) (call $group (local.get 0) (local.get 1)))
    (func $__vera_ts_peek (param i32 i32) (result i32) (call $group (local.get 0) (local.get 1)))` : '';
  const wat = `(module
    (import "env" "memory" (memory 1))
    (import "vera" "trap" (func $__vera_trap (param i32 i32)))
    (global $__stack_pointer (mut i32) (i32.const 65536))
    (global $hb (mut i32) (i32.const 1024))
    (export "__heap_base" (global $hb))
    (func $__vera_tl (param i32 i32) (result i32) (local.get 0))
    (func $__vera_ts (param i32 i32) (result i32) (local.get 0))
    (func $__vera_tlg (param i32 i32) (result i32) (call $group (local.get 0) (local.get 1)))
    (func $__vera_tsg (param i32 i32) (result i32) (call $group (local.get 0) (local.get 1)))${peek}
    (func $group (param i32 i32) (result i32)
      (select (i32.const 0) (local.get 0)
        (i32.gt_u (i32.add (i32.and (local.get 0) (i32.const 4095)) (local.get 1)) (i32.const 4096))))
    (func $g)
    ${extra}
    (func $f (export "f") ${locals} ${body}))`;
  const m = binaryen.parseText(wat);
  m.setFeatures(binaryen.Features.All);
  binaryen.setDebugInfo(true); // keep the name section: instrument() finds helpers by name
  const bin = m.emitBinary();
  binaryen.setDebugInfo(false);
  m.dispose();
  return bin;
}

const P2 = '(param i32 i32)';
for (const [name, body, groups, peeks = 0] of [
  ['fields through one pointer', '(i32.store (local.get 0) (i32.const 1)) (i32.store offset=4 (local.get 0) (i32.const 2))', 1],
  ['a[i] and a[i+1] as base + constant', '(i32.store (local.get 0) (i32.const 1)) (i32.store (i32.add (local.get 0) (i32.const 4)) (i32.const 2))', 1],
  ['loads with a branch between them', '(drop (i32.load (local.get 0))) (br_if 0 (local.get 1)) (drop (i32.load offset=4 (local.get 0)))', 1],
  ['not across an access through another pointer',
    '(i32.store (local.get 0) (i32.const 1)) (i32.store (local.get 1) (i32.const 2)) (i32.store offset=4 (local.get 0) (i32.const 3))', 0],
  ['not across a call', '(i32.store (local.get 0) (i32.const 1)) (call $g) (i32.store offset=4 (local.get 0) (i32.const 2))', 0],
  ['not across a change of the base', '(i32.store (local.get 0) (i32.const 1)) (local.set 0 (local.get 1)) (i32.store offset=4 (local.get 0) (i32.const 2))', 0],
  ['not stores with a branch between them', '(i32.store (local.get 0) (i32.const 1)) (br_if 0 (local.get 1)) (i32.store offset=4 (local.get 0) (i32.const 2))', 0],
  ['not across a loop', '(i32.store (local.get 0) (i32.const 1)) (loop (nop)) (i32.store offset=4 (local.get 0) (i32.const 2))', 0],
  ['not when the address loads memory', '(i32.store (local.get 0) (i32.const 1)) (i32.store (i32.load (local.get 0)) (i32.const 2))', 0],
  ['not over more than a small range', '(i32.store (local.get 0) (i32.const 1)) (i32.store offset=4000 (local.get 0) (i32.const 2))', 0],
  // The first access may not run, or comes after something observable: the
  // group's translation must not fault (a peek).
  ['with a peek: a load that a branch may skip',
    '(if (local.get 1) (then (drop (i32.load (local.get 0))))) (drop (i32.load offset=4 (local.get 0)))', 1, 1],
  ['with a peek: loads after a br_if', '(block (br_if 0 (local.get 1)) (drop (i32.load (local.get 0)))) (drop (i32.load offset=4 (local.get 0)))', 1, 1],
  ['with a peek: a store after a possible trap',
    '(i32.store (local.get 0) (i32.div_u (i32.const 7) (local.get 1))) (i32.store offset=4 (local.get 0) (i32.const 2))', 1, 1],
  ['with a peek: a store after a global.set',
    '(i32.store (local.get 0) (block (result i32) (global.set $hb (local.get 1)) (i32.const 1))) (i32.store offset=4 (local.get 0) (i32.const 2))', 1, 1],
  ['without a peek: a branch after the first load', '(drop (i32.load (local.get 0))) (if (local.get 1) (then (drop (i32.load offset=4 (local.get 0)))))', 1, 0],
]) {
  test(`merging: ${name}`, () => {
    const { report } = instrument(moduleWith(body, P2), { optimize: false });
    assert.equal(report.mergedGroups, groups);
    assert.equal(report.mergedAccesses, 2 * groups);
    assert.equal(report.mergePeeks, peeks);
  });
}

test('merging: without peeks (an older runtime) a group whose first access may not run is not made', () => {
  const body = '(if (local.get 1) (then (drop (i32.load (local.get 0))))) (drop (i32.load offset=4 (local.get 0)))';
  assert.equal(instrument(moduleWith(body, P2, '', { peeks: false }), { optimize: false }).report.mergedGroups, 0);
});

test('merging: a read-modify-write needs one write translation, no temps and no fallback', () => {
  const { report } = instrument(moduleWith('(i32.store (local.get 0) (i32.add (i32.load (local.get 0)) (i32.const 1)))', P2), { optimize: false });
  assert.equal(report.mergedGroups, 1);
  assert.equal(report.mergedAccesses, 2);
  assert.equal(report.mergeFallbacks, 0, 'same address and size: crosses a page only if each access does (and traps)');
  assert.equal(report.storesWithTemps, 0, 'no fault can happen between the translation and the store');
});

test('merging: a side effect before the first access makes the group peek, with a fallback', () => {
  // The store below VBASE (at 64) runs before the first store through $0 is
  // translated, so a fault or trap from translating early would lose it.
  const effect = '(block (result i32) (i32.store (i32.const 64) (i32.const 1)) (i32.const 7))';
  const body = `(i32.store (local.get 0) ${effect}) (i32.store (local.get 0) (i32.add (i32.load (local.get 0)) (i32.const 1)))`;
  const { report } = instrument(moduleWith(body, P2), { optimize: false });
  assert.equal(report.mergedGroups, 1);
  assert.equal(report.mergedAccesses, 3);
  assert.equal(report.mergeFallbacks, 1, 'not the trapping no-fallback form');
  assert.equal(report.mergePeeks, 1);
});

test('merging: the tee that computes a shared address is split off first', () => {
  const body = '(i32.store (local.tee 1 (i32.add (local.get 0) (i32.const 8))) (i32.add (i32.load (local.get 1)) (i32.const 1)))';
  const { report } = instrument(moduleWith(body, P2), { optimize: false });
  assert.equal(report.mergedGroups, 1);
});

// Run the instrumented function against a real Memory, both where the
// group fits in a page and where it crosses one (fallback), optimized or not.
test('merging: merged code computes the same memory contents, fast path and fallback', async () => {
  const body = `
    (i32.store (local.get 0) (i32.const 11))
    (i32.store offset=4 (local.get 0) (i32.add (i32.load (local.get 0)) (i32.const 1)))
    (local.set 0 (local.get 1))
    (i32.store offset=8 (local.get 0) (i32.const 33))
    (i32.store offset=12 (local.get 0) (i32.add (i32.load offset=8 (local.get 0)) (i32.load offset=4 (local.get 0))))`;
  for (const optimize of [false, true]) {
    const { binary, report } = instrument(moduleWith(body, P2), { optimize });
    assert.equal(report.mergedGroups, 2);
    for (const [p, q] of [[1000, 2000], [4092, 8184], [4088, 12272]]) {
      const memory = new WebAssembly.Memory({ initial: 1 });
      const { instance } = await WebAssembly.instantiate(binary, { env: { memory }, vera: { trap: () => { throw new Error('trap'); } } });
      const w = new Uint32Array(memory.buffer);
      w[(q + 4) >> 2] = 5;
      instance.exports.f(p, q);
      assert.deepEqual([w[p >> 2], w[(p + 4) >> 2]], [11, 12], `p = ${p}`);
      assert.deepEqual([w[(q + 8) >> 2], w[(q + 12) >> 2]], [33, 38], `q = ${q} (the base changed between the groups)`);
    }
  }
});

// Merging limits (a review finding): merging puts every group's accesses in
// the function twice, and binaryen -O3 took 84 s on a function that then
// called out of line anyway (a249032: 3.7 s), and ~40 s on one with 8,099
// merged accesses. Such functions are not merged.
async function buildGroups(name, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-merge-'));
  try {
    fs.writeFileSync(path.join(dir, `${name}.c`), source);
    const t0 = Date.now();
    const info = buildApp([path.join(dir, `${name}.c`)], path.join(dir, name));
    const ms = Date.now() - t0;
    const vera = fs.readFileSync(path.join(dir, `${name}.vera.wasm`));
    const ref = await runBase(fs.readFileSync(path.join(dir, `${name}.base.wasm`)), [64, 20_000, 3]);
    assert.equal(ref.status, 0);
    for (const poolBytes of [64 << 10, 256 << 10]) {
      assert.equal((await runVera(vera, [64, 20_000, 3], { poolBytes })).value, ref.value, `pool ${poolBytes >> 10} KiB`);
    }
    return { report: info.instrument, ms };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('merging: a function that calls out of line even after merging is not merged', { skip: !haveClang() && 'needs clang' }, async () => {
  const { report } = await buildGroups('ool', groupsSource(25, 8, 2)); // 200 small groups: ~1,000 accesses
  assert.deepEqual(report.outOfLine, ['run']);
  assert.deepEqual(report.unmerged, ['run']);
});

test('merging: a function with more than 4096 accesses to merge is not merged, and builds in seconds', { skip: !haveClang() && 'needs clang' }, async () => {
  const { report, ms } = await buildGroups('big', groupsSource(8, 8)); // 64 groups of 128 accesses
  assert.deepEqual(report.unmerged, ['run']);
  assert.deepEqual(report.outOfLine, ['run']);
  assert.ok(ms < 20000, `build took ${ms} ms (c0f7e2b: ~40 s)`);
});
