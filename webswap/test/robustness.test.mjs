// Tests added after the independent review: each one reproduces a problem
// the review found and checks that it is fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { built, runBase, runVera, ROOT } from './helpers.mjs';
import { buildApp, haveClang } from '../tools/vera-build.mjs';
import { createVera, instantiateBase, VeraTrapError, memoryImportMinPages } from '../runtime/vera.mjs';
import { NodeFileBackend, FileBudgetStore, MemoryBackend } from '../runtime/backends.mjs';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vera-rob-'));

test('store ordering: a[i] += a[j] just above the pool size matches the baseline', async () => {
  const { vera, base } = built('test/fixtures/rmw.c');
  for (const npages of [17, 18, 20, 24]) {
    const ref = await runBase(base, [npages, 100_000, 5]);
    const r = await runVera(vera, [npages, 100_000, 5], { poolBytes: 64 << 10 });
    assert.equal(r.value, ref.value, `${npages} pages in a 16-frame pool`);
    assert.ok(r.stats.evictDirty > 1000, 'really paging');
  }
});

test('the rmw test detects a broken ordering rule (mutation check)', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = tmpdir();
  buildApp([path.join(ROOT, 'test/fixtures/rmw.c')], path.join(dir, 'rmw'), { instrumentOptions: { unsafeTranslateFirstForTesting: true } });
  const broken = fs.readFileSync(path.join(dir, 'rmw.vera.wasm'));
  const { base } = built('test/fixtures/rmw.c');
  let caught = 0;
  for (const npages of [17, 18, 20, 24]) {
    const ref = await runBase(base, [npages, 100_000, 5]);
    const r = await runVera(broken, [npages, 100_000, 5], { poolBytes: 64 << 10 });
    if (r.value !== ref.value) caught++;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(caught > 0, 'the deliberately broken build must produce a wrong result');
});

test('stack overflow traps in the paged build, as it does in the ordinary build', async () => {
  const { vera, base } = built('test/fixtures/stack.c');
  assert.equal((await runBase(base, [10, 0, 0])).status, 0, 'shallow recursion is fine');
  await assert.rejects(runBase(base, [40, 0, 0]), /out of bounds/);
  await assert.rejects(runVera(vera, [40, 0, 0], { poolBytes: 1 << 20 }), (e) => e instanceof VeraTrapError && /stack overflow/.test(e.message));
  const ok = await runVera(vera, [10, 0, 0], { poolBytes: 1 << 20 });
  assert.equal(ok.status, 0);
});

test('allocator: big/small churn and realloc growth do not exhaust the heap', async () => {
  const { vera, base } = built('test/fixtures/alloc.c');
  const v = await createVera({ wasm: vera, poolBytes: 1 << 20 });
  assert.equal(v.exports.frag(64, 200), 0, '200 x (64 MiB + 8 KiB) with at most 64 MiB live');
  assert.equal(v.exports.regrow(16 << 10, 300), 0, '300 x realloc doubling to 16 MiB');
  v.close();
  const b = await instantiateBase(base);
  assert.equal(b.exports.frag(64, 200), 0);
  assert.ok(b.memory.buffer.byteLength < 200 << 20, 'the ordinary build reuses memory too');
});

test('calloc of fresh memory writes nothing to storage, and reused memory is zeroed', async () => {
  const { vera } = built('test/fixtures/alloc.c');
  const v = await createVera({ wasm: vera, poolBytes: 1 << 20 });
  assert.equal(v.exports.czero_fresh(32), 0n);
  // Only the page holding the block header is dirty; the 32 MiB of zeros are
  // never written (they were never touched, and calloc skips the memset).
  assert.ok(v.stats().writeBytes <= 4096, `calloc of 32 MiB fresh memory wrote ${v.stats().writeBytes} bytes`);
  assert.equal(v.exports.czero_reuse(32), 0n, 'reused memory comes back zeroed');
  v.close();
});

test('baseline heap survives a full 4 GiB Memory limit (no u32 wraparound)', async () => {
  const { base } = built('test/fixtures/alloc.c');
  const b = await instantiateBase(base, { maxBytes: 4 * 2 ** 30 });
  assert.equal(b.exports.frag(1, 10), 0);
});

test('NodeFileBackend refuses to reuse an existing swap file and creates it private (0600)', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'heap.bin');
  const a = new NodeFileBackend(fs, p);
  assert.throws(() => new NodeFileBackend(fs, p), /EEXIST/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  a.close();
  assert.equal(fs.existsSync(p), false, 'deleted on close');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a budget store makes the write budget cumulative across runs', async () => {
  const dir = tmpdir();
  const store = new FileBudgetStore(fs, path.join(dir, 'budget.json'));
  const { vera } = built('apps/rand.c');
  const events = [];
  for (let i = 0; i < 3; i++) {
    const v = await createVera({
      wasm: vera, poolBytes: 1 << 20, backend: new MemoryBackend(), budgetStore: store,
      writeBudgetBytes: 40 << 20, onEvent: (e) => events.push(e),
    });
    v.exports.run(8, 20_000, i + 1);
    v.close();
    await new Promise((r) => setTimeout(r, 0));
  }
  const st = store.load();
  assert.ok(st.used > 40 << 20, `total over three runs: ${st.used >> 20} MiB`);
  assert.ok(events.length >= 1, 'the budget warning fired once the total passed the budget');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('instantiateBase: real link errors are not disguised, and the memory minimum is read', async () => {
  const { base } = built('apps/sort.c');
  assert.ok(memoryImportMinPages(base) > 0);
  await assert.rejects(instantiateBase(base, { maxBytes: 64 * 1024 }), /needs .* KiB of memory to start/);
});

// A switch with n distinct, data-dependent cases (clang cannot turn it into
// a table). run(x) returns what case x leaves in a[x % 64].
function switchSource(n) {
  const cases = Array.from({ length: n }, (_, i) => `case ${i}: a[(x * ${i * 7 + 3}u) % 64] ^= a[(x + ${i}u) % 64] + ${i}u; break;`).join('\n');
  return `#include "vera.h"\nVERA_EXPORT("run") u64 run(u32 x, u32 o, u32 s) { (void)o; (void)s;\n` +
    `u64 *a = malloc(64 * 8); for (u32 i = 0; i < 64; i++) a[i] = 0;\nswitch (x) {\n${cases}\n}\nu64 r = a[x % 64]; free(a); return r; }\n`;
}
const switchExpect = (n, x) => (x < n && Number((BigInt(x) * BigInt(x * 7 + 3)) % 64n) === x % 64 ? BigInt(x) : 0n);

async function checkSwitch(dir, n, xs) {
  const v = await createVera({ wasm: fs.readFileSync(path.join(dir, 'sw.vera.wasm')), poolBytes: 1 << 20 });
  for (const x of xs) assert.equal(v.exports.run(x, 0, 0), switchExpect(n, x), `case ${x}`);
  v.close();
}

test('deeply nested code (a 6000-case switch) instruments without a stack overflow', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'sw.c'), switchSource(6000));
  // Unoptimized: this test is about the walker's depth, not binaryen's speed.
  const info = buildApp([path.join(dir, 'sw.c')], path.join(dir, 'sw'), { base: false, quiet: true, instrumentOptions: { optimize: false } });
  assert.ok(info.instrument.storesFast > 6000, `stores instrumented: ${info.instrument.storesFast}`);
  assert.ok(info.instrument.sharedTemps > 5000, 'leaf stores share their temps');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.linked.')), [], 'no temp files left');
  await checkSwitch(dir, 6000, [0, 1, 3, 5, 63, 64, 65, 4095, 5999, 6000]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a function with very many accesses is optimized with out-of-line translation, in seconds', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'sw.c'), switchSource(1000));
  const t0 = Date.now();
  const info = buildApp([path.join(dir, 'sw.c')], path.join(dir, 'sw'), { base: false, quiet: true });
  const ms = Date.now() - t0;
  assert.deepEqual(info.instrument.outOfLine, ['run']);
  assert.ok(ms < 30000, `build took ${ms} ms (inlining everything took ~70 s)`);
  await checkSwitch(dir, 1000, [0, 1, 3, 5, 63, 64, 65, 999, 1000]);
  fs.rmSync(dir, { recursive: true, force: true });
});
