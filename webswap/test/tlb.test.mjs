// The software TLB of tools/instrument.mjs: a cached translation must never
// outlive a page fault or a call, and these tests must be able to tell when
// one does (mutation checks with a deliberately broken build).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import binaryen from 'binaryen';
import { built, runBase, runVera, shufflePagesOnEveryFault, groupsSource, ROOT } from './helpers.mjs';
import { buildApp, haveClang } from '../tools/vera-build.mjs';
import { createVera, instantiateBase, VeraTrapError } from '../runtime/vera.mjs';
import { MemoryBackend } from '../runtime/backends.mjs';

const FIXTURE = 'test/fixtures/tlb.c';
const noHook = { env: { hook: () => {} } };

async function veraRun(bytes, fn, args, poolBytes, { shuffle = false } = {}) {
  const v = await createVera({ wasm: bytes, poolBytes, backend: new MemoryBackend(), imports: noHook });
  if (shuffle) shufflePagesOnEveryFault(v.pager);
  try {
    return { value: v.exports[fn](...args), status: v.exports.status(), stats: v.stats() };
  } finally {
    v.close();
  }
}

// hooked(): the host flushes every page from inside the loop.
async function hookedRun(bytes, args, poolBytes) {
  const v = await createVera({ wasm: bytes, poolBytes, backend: new MemoryBackend(), imports: { env: { hook: () => v.flush() } } });
  try {
    return { value: v.exports.hooked(...args), stats: v.stats() };
  } finally {
    v.close();
  }
}

const baseRun = async (bytes, fn, args) => (await instantiateBase(bytes, { imports: noHook })).exports[fn](...args);

function buildBroken(dir) {
  buildApp([path.join(ROOT, FIXTURE)], path.join(dir, 'tlb'), { base: false, instrumentOptions: { unsafeTlbSurvivesFaultsForTesting: true } });
  return fs.readFileSync(path.join(dir, 'tlb.vera.wasm'));
}

test('TLB: the fixture really uses TLB entries', () => {
  built(FIXTURE);
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/tlb.info.json'), 'utf8'));
  assert.ok(info.instrument.tlbEntries > 0 && info.instrument.tlbSites > 0, JSON.stringify(info.instrument));
});

test('TLB: streaming loops whose pages are evicted between accesses match the baseline', async () => {
  const { vera, base } = built(FIXTURE);
  for (const npages of [16, 20, 28]) {
    const ref = await baseRun(base, 'run', [npages, 2, 7]);
    for (const poolBytes of [64 << 10, 128 << 10, 1 << 20]) {
      const r = await veraRun(vera, 'run', [npages, 2, 7], poolBytes);
      assert.equal(r.status, 0);
      assert.equal(r.value, ref, `${npages} pages per array, pool ${poolBytes >> 10} KiB`);
      if (poolBytes === 64 << 10) assert.ok(r.stats.evictDirty + r.stats.evictClean > 1000 && r.stats.refCleared > 1000, 'really paging');
    }
  }
});

test('TLB: a host flush inside the loop (an import call) is seen by the next store', async () => {
  const { vera, base } = built(FIXTURE);
  for (const [npages, every] of [[8, 100], [12, 1000], [16, 333]]) {
    const ref = await baseRun(base, 'hooked', [npages, every]);
    const r = await hookedRun(vera, [npages, every], 64 << 10);
    assert.equal(r.value, ref, `${npages} pages, flush every ${every} stores`);
    assert.ok(r.stats.writeOps > 0);
  }
});

test('TLB: identity pages (a stack array) are cached correctly', async () => {
  const { vera, base } = built(FIXTURE);
  const ref = await baseRun(base, 'stack_sum', [50, 3]);
  assert.equal((await veraRun(vera, 'stack_sum', [50, 3], 64 << 10)).value, ref);
});

test('TLB: an aligned-claimed stream running into the next page traps, also after hits', async () => {
  const { vera, base } = built(FIXTURE);
  // In-page: 4080 + 4 * 4 = 4096, no crossing.
  assert.equal((await veraRun(vera, 'straddle', [4080, 4], 1 << 20)).value, await baseRun(base, 'straddle', [4080, 4]));
  // Misaligned by 2: the 4th u32 (at 4094) crosses into the next page.
  await assert.rejects(veraRun(vera, 'straddle', [4082, 8], 1 << 20), (e) => e instanceof VeraTrapError && /crosses a page boundary/.test(e.message));
});

test('TLB: tlb: false builds the same program without entries', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-tlb-'));
  const info = buildApp([path.join(ROOT, FIXTURE)], path.join(dir, 'tlb'), { base: false, instrumentOptions: { tlb: false } });
  assert.equal(info.instrument.tlbEntries, 0);
  assert.ok(info.instrument.inlineFunctions > 0);
  const plain = fs.readFileSync(path.join(dir, 'tlb.vera.wasm'));
  const { vera } = built(FIXTURE);
  for (const poolBytes of [64 << 10, 1 << 20]) {
    assert.equal((await veraRun(plain, 'run', [12, 2, 5], poolBytes)).value, (await veraRun(vera, 'run', [12, 2, 5], poolBytes)).value);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TLB: other VBASE values (page table below and above VBASE >> 10) work', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-tlb-'));
  const { base } = built(FIXTURE);
  const ref = await baseRun(base, 'run', [20, 2, 3]);
  for (const vbase of [0x04000000, 0xF0000000]) {
    buildApp([path.join(ROOT, FIXTURE)], path.join(dir, 'tlb'), { base: false, vbase });
    const bytes = fs.readFileSync(path.join(dir, 'tlb.vera.wasm'));
    for (const poolBytes of [64 << 10, 1 << 20]) {
      assert.equal((await veraRun(bytes, 'run', [20, 2, 3], poolBytes)).value, ref, `vbase 0x${vbase.toString(16)}, pool ${poolBytes >> 10} KiB`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TLB: a merged group\'s cached translation does not outlive a fault', async () => {
  const { vera, base } = built(FIXTURE);
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/tlb.info.json'), 'utf8'));
  assert.ok(info.instrument.tlbGroupSites > 0, 'some merged group translation uses a TLB entry');
  assert.ok(info.instrument.tlbPeekSites > 0, 'so does a group that peeks');
  for (const npages of [16, 20, 28]) {
    const ref = await baseRun(base, 'fields', [npages, 2, 7]);
    for (const poolBytes of [64 << 10, 1 << 20]) {
      const r = await veraRun(vera, 'fields', [npages, 2, 7], poolBytes);
      assert.equal(r.status, 0);
      assert.equal(r.value, ref, `${npages} pages per array, pool ${poolBytes >> 10} KiB`);
    }
  }
});

// The pager may move any page in any fault (here: all of them, every time).
// straddlers() needs this to notice a merged group's fallback copy that
// does not empty the entries when it ends (CLOCK rarely evicts a page that
// is in use right then).
test('TLB: the fixture matches the baseline when every fault moves every page', async () => {
  const { vera, base } = built(FIXTURE);
  for (const [fn, args] of [['run', [16, 2, 7]], ['fields', [16, 2, 7]], ['straddlers', [4, 2, 7]], ['straddlers', [8, 1, 9]]]) {
    const r = await veraRun(vera, fn, args, 64 << 10, { shuffle: true });
    assert.equal(r.value, await baseRun(base, fn, args), `${fn}(${args})`);
  }
});

test('TLB: the tests detect entries that survive faults and calls (mutation check)', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-tlb-'));
  const broken = buildBroken(dir);
  const { base } = built(FIXTURE);
  let caughtFault = 0, caughtCall = 0, caughtGroup = 0;
  for (const npages of [16, 20, 28]) {
    const ref = await baseRun(base, 'fields', [npages, 2, 7]);
    try {
      if ((await veraRun(broken, 'fields', [npages, 2, 7], 64 << 10)).value !== ref) caughtGroup++;
    } catch { caughtGroup++; }
  }
  for (const npages of [16, 20, 28]) {
    const ref = await baseRun(base, 'run', [npages, 2, 7]);
    try {
      if ((await veraRun(broken, 'run', [npages, 2, 7], 64 << 10)).value !== ref) caughtFault++;
    } catch { caughtFault++; } // a wrong frame can also make the program trap
  }
  for (const [npages, every] of [[8, 100], [12, 1000], [16, 333]]) {
    const ref = await baseRun(base, 'hooked', [npages, every]);
    try {
      if ((await hookedRun(broken, [npages, every], 64 << 10)).value !== ref) caughtCall++;
    } catch { caughtCall++; }
  }
  let caughtShuffled = 0;
  for (const fn of ['run', 'fields', 'straddlers']) {
    const args = [8, 1, 3];
    try {
      if ((await veraRun(broken, fn, args, 64 << 10, { shuffle: true })).value !== await baseRun(base, fn, args)) caughtShuffled++;
    } catch { caughtShuffled++; }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(caughtShuffled, 3, 'with pages moved in every fault, each function notices');
  assert.ok(caughtFault > 0, 'entries kept across faults must produce a wrong result');
  assert.ok(caughtCall > 0, 'entries kept across a flushing import call must produce a wrong result');
  assert.ok(caughtGroup > 0, 'a merged group\'s entry kept across faults must produce a wrong result');
});

test('TLB: every build keeps the store-ordering rule (rmw fixture, TLB build)', async () => {
  const { vera, base } = built('test/fixtures/rmw.c');
  for (const npages of [17, 20]) {
    const ref = await runBase(base, [npages, 50_000, 9]);
    const v = await createVera({ wasm: vera, poolBytes: 64 << 10 });
    try {
      assert.equal(v.exports.run(npages, 50_000, 9), ref.value);
    } finally {
      v.close();
    }
  }
});

// A review finding: in a function with many TLB entries, every out-of-line
// translation in merged groups' fallback copies emptied all of them, and
// binaryen -O3 slowed down with each of those resets (25 s here). Now a
// straight-line fallback copy empties the entries once when it ends, and
// only the entries of the loops around it.
test('TLB: many merged groups with fallback copies next to many entries build in seconds', { skip: !haveClang() && 'needs clang' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-tlb-'));
  try {
    const src = path.join(dir, 'groups.c');
    fs.writeFileSync(src, groupsSource(2, 8));
    // Unoptimized: count the entry resets (c0f7e2b: 70,753; now ~600).
    buildApp([src], path.join(dir, 'raw'), { base: false, instrumentOptions: { optimize: false } });
    const m = binaryen.readBinary(fs.readFileSync(path.join(dir, 'raw.vera.wasm')));
    const text = binaryen.emitText(binaryen.getFunctionInfo(m.getFunction('run')).body);
    m.dispose();
    const resets = (text.match(/\(local\.set \$\d+\s+\(i64\.const 0\)\s*\)/g) || []).length;
    const t0 = Date.now();
    const info = buildApp([src], path.join(dir, 'groups'));
    const ms = Date.now() - t0;
    const r = info.instrument;
    assert.ok(r.tlbEntries >= 24 && r.mergeFallbacks >= 16 && r.mergedAccesses > 2000, JSON.stringify(r));
    assert.deepEqual(r.outOfLine, []);
    assert.ok(resets < 3000, `${resets} TLB entry resets before optimization`);
    assert.ok(ms < 20000, `build took ${ms} ms (c0f7e2b: ~25 s)`);
    const vera = fs.readFileSync(path.join(dir, 'groups.vera.wasm'));
    const ref = await runBase(fs.readFileSync(path.join(dir, 'groups.base.wasm')), [64, 20_000, 3]);
    for (const poolBytes of [64 << 10, 256 << 10]) {
      assert.equal((await runVera(vera, [64, 20_000, 3], { poolBytes })).value, ref.value, `pool ${poolBytes >> 10} KiB`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
