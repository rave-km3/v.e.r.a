// The compressed page tier: the codec (round trips, exact worst case), the
// store (fixed memory, index, age order), the pager's tier policy
// (dirty/clean, spill, flush, readahead, storage errors, write budget, a
// model check of every copy of every page), durable checkpoints with the
// tier, and differential runs of real programs with tiny pools and tiers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compressPage, decompressPage, MAX_COMPRESSED_WORDS, MIN_COMPRESS_BYTES, CompressedTier } from '../runtime/compress.mjs';
import { Pager, VeraBudgetError } from '../runtime/pager.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryBackend, NodeFileBackend, PAGE } from '../runtime/backends.mjs';
import { createVera } from '../runtime/vera.mjs';
import { MemStore } from '../runtime/durable.mjs';
import { built, runBase, runVera } from './helpers.mjs';

const W = PAGE / 4;
let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
const urnd = (n) => (rnd() >>> 0) % n;
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// Page generators: what heaps hold, and the codec's edge cases.
const PATTERNS = {
  zero: () => {},
  same: (p) => p.fill(-0x5a5a5a5b),
  random: (p) => { for (let i = 0; i < W; i++) p[i] = rnd(); },
  counters64: (p) => { for (let i = 0; i < W; i += 2) p[i] = 5000 + i; },
  sorted: (p) => { let x = rnd() >>> 3; for (let i = 0; i < W; i++) p[i] = (x += rnd() & 511); },
  sparse: (p) => { for (let i = 0; i < 40; i++) p[urnd(W)] = rnd(); },
  pointers: (p) => { for (let i = 0; i < W; i++) p[i] = 0x10000000 + ((rnd() & 0xffff) << 3); },
  edges: (p) => { const v = [0, 1, -1, 1023, 1024, 0x7fffffff, -0x80000000, 0x3ff, -1024]; for (let i = 0; i < W; i++) p[i] = v[urnd(v.length)]; },
  lastDiffers: (p) => { p.fill(7); p[W - 1] = 8; },
  mixed: (p) => { for (let i = 0; i < W; i++) { const r = rnd() & 3; p[i] = r === 0 ? 0 : r === 1 ? p[Math.max(0, i - 1)] : r === 2 ? (p[Math.max(0, i - 2)] ^ (rnd() & 1023)) : rnd(); } },
  // The codec's worst case: one partial match, then a miss for every word.
  worst: (p) => { p[0] = 5; for (let i = 1; i < W; i++) p[i] = (i << 10) | (rnd() & 1023); },
};

// Every typed array (by buffer, so views are not counted twice) that obj owns.
const ownedBytes = (obj, exclude = null) => {
  const bufs = new Set();
  for (const x of Object.values(obj)) if (ArrayBuffer.isView(x) && x.buffer !== exclude) bufs.add(x.buffer);
  return [...bufs].reduce((s, b) => s + b.byteLength, 0);
};

// ---- codec -----------------------------------------------------------------

test('codec: every accepted page decompresses to exactly the original', () => {
  const out = new Int32Array(MAX_COMPRESSED_WORDS);
  const back = new Int32Array(W + 8);
  for (const [name, gen] of Object.entries(PATTERNS)) {
    for (let rep = 0; rep < 50; rep++) {
      const p = new Int32Array(W);
      gen(p);
      const n = compressPage(p, 0, out);
      assert.ok(n > 0 && n <= MAX_COMPRESSED_WORDS, `${name}: always compressible without a limit`);
      back.fill(0x1234567);
      decompressPage(out, 0, back, 4); // at an offset, as into a frame
      assert.deepEqual(back.subarray(4, 4 + W), p, `${name} #${rep}`);
      assert.equal(back[3], 0x1234567, 'nothing written before the page');
      assert.equal(back[4 + W], 0x1234567, 'nothing written after the page');
    }
  }
});

test('codec: sizes are what the format promises, and the limit rejects', () => {
  const out = new Int32Array(MAX_COMPRESSED_WORDS);
  const p = new Int32Array(W);
  assert.equal(compressPage(p, 0, out), 2, 'a zero page is one word');
  PATTERNS.counters64(p);
  assert.ok(compressPage(p, 0, out) * 4 < PAGE / 3, 'u64 counters compress more than 3:1');
  PATTERNS.random(p);
  assert.equal(compressPage(p, 0, out, 768), 0, 'random words do not fit in 3/4 of a page');
  assert.ok(compressPage(p, 0, out) > W, 'and would be larger than the page');
});

test('codec: the worst case is exact (+6.4%), and a limited compression never writes past its limit', () => {
  const out = new Int32Array(MAX_COMPRESSED_WORDS);
  const p = new Int32Array(W);
  PATTERNS.worst(p);
  assert.equal(compressPage(p, 0, out), 1 + W / 16 + 1 + 1 + (W - 1), 'header, tags, one index word, one low word, 1023 misses');
  assert.equal(MAX_COMPRESSED_WORDS, 1090, 'and that is the bound, not more');
  for (let rep = 0; rep < 200; rep++) { // no page, however random, needs more
    for (let i = 0; i < W; i++) p[i] = rep & 1 ? rnd() : rnd() & (rnd() & 0xfff0ffff);
    assert.ok(compressPage(p, 0, out) <= MAX_COMPRESSED_WORDS);
  }
  // With a limit (as the tier asks), out beyond max(limit, 65) is never touched.
  for (const limit of [65, 100, 640]) {
    for (const gen of ['random', 'worst', 'sorted', 'mixed']) {
      const o = new Int32Array(Math.max(limit, 65) + 32).fill(0x7777);
      PATTERNS[gen](p.fill(0));
      const n = compressPage(p, 0, o, limit);
      assert.ok(n <= limit, `${gen}: ${n} words for a limit of ${limit}`);
      assert.ok(o.subarray(Math.max(limit, 65)).every((x) => x === 0x7777), `${gen}: nothing written past the limit`);
    }
  }
});

// ---- store -------------------------------------------------------------------

test('tier memory: only typed arrays, allocated up front, all inside the budget', () => {
  for (const bytes of [MIN_COMPRESS_BYTES, 64 << 10, 1 << 20, 16 << 20, (16 << 20) + 12345]) {
    const t = new CompressedTier(bytes);
    const check = () => {
      for (const [k, x] of Object.entries(t)) {
        if (x !== null && typeof x === 'object') assert.ok(ArrayBuffer.isView(x), `${k} is a ${x.constructor.name}, not a typed array`);
      }
      assert.ok(ownedBytes(t) <= bytes, `${ownedBytes(t)} bytes allocated for a ${bytes}-byte tier`);
      assert.equal(t.memoryBytes(), ownedBytes(t));
    };
    check();
    assert.ok(ownedBytes(t) > bytes - 200, 'and it uses (almost) all of it');
    if (bytes > 1 << 20) continue;
    // Full of the smallest entries (one block each: the most entries, the
    // fullest index), churned: nothing grows.
    const before = ownedBytes(t);
    const p = new Int32Array(W);
    for (let v = 0; v < 20 * t.nblocks; v++) {
      p.fill(v);
      const n = t.compress(p, 0);
      while (!t.fits(n)) t.remove(t.pageOf(t.oldest()));
      t.store(v * 977, n, false);
    }
    assert.equal(t.size, t.nblocks, 'one entry per block');
    assert.equal(ownedBytes(t), before);
    check();
  }
});

test('tier size: refused below the minimum, and a kept page always shrinks', async () => {
  assert.throws(() => new CompressedTier(MIN_COMPRESS_BYTES - 1), /at least 16 KiB/);
  assert.throws(() => new CompressedTier(1 << 20, { limitRatio: 1 }), RangeError);
  assert.throws(() => new CompressedTier(1 << 20, { limitRatio: 2 }), RangeError);
  assert.throws(() => new CompressedTier(1 << 20, { limitRatio: 0 }), RangeError);
  const t = new CompressedTier(1 << 20, { limitRatio: 0.99 });
  const p = new Int32Array(W);
  PATTERNS.random(p);
  assert.equal(t.compress(p, 0), 0, 'a page that does not shrink is never kept');
  const { vera: wasm } = built('test/fixtures/steps.c');
  for (const compressBytes of [1000, 8 << 10, -1, 'abc', '16M', NaN, Infinity, null]) {
    await assert.rejects(createVera({ wasm, poolBytes: 64 << 10, compressBytes }), /compressBytes/, String(compressBytes));
  }
  const v = await createVera({ wasm, poolBytes: 64 << 10 });
  assert.equal(v.pager.tier, null, 'off by default');
  assert.equal(v.stats().compressBytes, 0);
  v.close();
});

test('tier store: block accounting never exceeds the budget and frees everything', () => {
  const t = new CompressedTier(64 << 10);
  const p = new Int32Array(W);
  const back = new Int32Array(W);
  const kept = new Map();
  for (let v = 0; v < 500; v++) {
    (v % 3 ? PATTERNS.sparse : PATTERNS.counters64)(p.fill(0));
    const n = t.compress(p, 0);
    assert.ok(n > 0);
    while (!t.fits(n)) t.remove(t.pageOf(t.oldest()));
    t.store(v, n, v % 2 === 0);
    kept.set(v, p.slice());
    assert.ok(t.used <= t.nblocks * 128);
  }
  for (let e = t.oldest(); e >= 0; e = t.newer(e)) {
    t.unpack(e, back, 0);
    assert.deepEqual(back, kept.get(t.pageOf(e)), `page ${t.pageOf(e)}`);
    assert.equal(t.isClean(e), t.pageOf(e) % 2 === 0);
  }
  while (t.size) t.remove(t.pageOf(t.oldest()));
  assert.equal(t.used, 0);
  assert.equal(t.nfree, t.nblocks);
});

test('tier store: index and age order agree with a model through stores, takes, restores and removals', () => {
  // The smallest tier and one-block entries: the index runs up to 2/3 full,
  // so probe runs, wrap-around and backward-shift deletion all happen.
  const t = new CompressedTier(MIN_COMPRESS_BYTES);
  const p = new Int32Array(W);
  const model = []; // [page, content word] in age order
  const held = []; // entries taken by a "fault", not yet given back
  const blocksOf = (e) => CompressedTier.blockBytes(t.wordsOf(e)) / 128;
  for (let step = 0; step < 30000; step++) {
    const r = urnd(10);
    if (r < 5 || model.length === 0) { // store a new page, making room first
      let v;
      do v = urnd(4) ? urnd(4 * t.slots.length) : urnd(1 << 20); while (t.has(v) || held.some(([u]) => u === v));
      p.fill(v ^ 0x55);
      if (step % 7 === 0) p[3] = 1; // a few bigger entries
      const n = t.compress(p, 0);
      while (!t.fits(n) && t.size) {
        const o = t.oldest();
        assert.equal(t.pageOf(o), model[0][0], `step ${step}: the oldest`);
        model.shift();
        t.remove(t.pageOf(o));
      }
      if (!t.fits(n)) continue; // only held entries left
      t.store(v, n, false);
      model.push([v, v ^ 0x55]);
    } else if (r < 7) { // a fault takes a random page out
      const [v] = model.splice(urnd(model.length), 1)[0];
      held.push([v, t.take(v)]);
      assert.ok(!t.has(v));
    } else if (r < 8 && held.length) { // ... and gives it back (newest) or frees it
      const [v, e] = held.splice(urnd(held.length), 1)[0];
      if (urnd(2)) { t.restore(v, e); model.push([v, v ^ 0x55]); } else t.release(e);
    } else if (model.length) { // spill the oldest
      model.shift();
      t.remove(t.pageOf(t.oldest()));
    }
    if (step % 97 === 0 || step > 29900) {
      assert.equal(t.size, model.length);
      let i = 0, blocks = 0;
      for (let e = t.oldest(); e >= 0; e = t.newer(e), i++) {
        assert.equal(t.pageOf(e), model[i][0], `step ${step}: age order`);
        assert.equal(t.get(model[i][0]), e, 'the index finds it');
        t.unpack(e, p, 0);
        assert.equal(p[0], model[i][1], 'with its content');
        blocks += blocksOf(e);
      }
      for (const [, e] of held) blocks += blocksOf(e);
      assert.equal(blocks + t.nfree, t.nblocks, `step ${step}: no block lost`);
    }
  }
});

// ---- pager -------------------------------------------------------------------

// Pager on a bare Memory with a counting backend (as in pager.test.mjs).
function setup({ frames = 8, nvp = 512, compressBytes = 64 << 10, ...opts } = {}) {
  const framesAddr = 65536;
  const memory = new WebAssembly.Memory({ initial: (framesAddr + frames * PAGE) / 65536 + 1 });
  const backend = new MemoryBackend();
  const c = { reads: 0, readPages: 0, writes: 0, fail: false };
  const counting = {
    kind: 'count',
    read: (v, n, u8) => { c.reads++; c.readPages += n; backend.read(v, n, u8); },
    write: (v, u8) => { if (c.fail) throw new Error('EIO'); c.writes++; backend.write(v, u8); },
    flush() {}, close() {},
  };
  const pager = new Pager({ memory, ptAddr: 0, nvp, framesAddr, poolFrames: frames, backend: counting, compressBytes, ...opts });
  const i32 = new Int32Array(memory.buffer);
  return { pager, i32, c, backend, memory };
}
const frameWords = (t, e) => (e & ~0xfff) >> 2;
// A compressible page whose content identifies v and a version.
function fill(t, v, ver = 1, gen = 'counters64') {
  const e = t.pager.fault(v, 1);
  const p = new Int32Array(W);
  PATTERNS[gen](p);
  p[0] = v; p[1] = ver;
  t.i32.set(p, frameWords(t, e));
  return p;
}
function check(t, v, want, msg) {
  const e = t.pager.fault(v, 0);
  assert.deepEqual(t.i32.subarray(frameWords(t, e), frameWords(t, e) + W), want, msg ?? `page ${v}`);
}
function storageHas(t, v) {
  const u8 = new Uint8Array(PAGE);
  if (t.pager.written[v]) t.backend.read(v, 1, u8);
  return new Int32Array(u8.buffer);
}

test('pager: evicted dirty pages come back from the tier without storage I/O', () => {
  const t = setup({ frames: 8 });
  const pages = [];
  for (let v = 0; v < 32; v++) pages.push(fill(t, v));
  for (let v = 0; v < 32; v++) check(t, v, pages[v]);
  assert.equal(t.c.reads, 0);
  assert.equal(t.c.writes, 0, 'nothing reached storage: 32 compressed pages fit in 64 KiB');
  assert.ok(t.pager.stats.tierHits >= 24);
  assert.equal(t.pager.stats.majorRead, 0);
});

test('pager: a full tier spills its oldest dirty pages to storage, and drops clean ones', () => {
  const t = setup({ frames: 8, compressBytes: 16 << 10 }); // room for 5 of these pages
  const pages = [];
  for (let v = 0; v < 100; v++) pages.push(fill(t, v));
  assert.ok(t.pager.stats.tierSpills > 50, 'spilled');
  assert.equal(t.c.writes, t.pager.stats.tierSpills, 'each spill is one storage write');
  for (let v = 0; v < 100; v++) check(t, v, pages[v]); // from storage, the tier or frames
  assert.ok(t.c.reads > 0);
  // Pages now clean everywhere: reading them all again writes nothing.
  const writes = t.c.writes;
  for (let round = 0; round < 2; round++) for (let v = 0; v < 100; v++) check(t, v, pages[v]);
  assert.equal(t.c.writes, writes, 'clean pages leave the tier without a write');
  assert.ok(t.pager.stats.tierDrops > 0);
});

test('pager: the tier spills in age order, oldest eviction first', () => {
  const t = setup({ frames: 8, compressBytes: 64 << 10, readahead: 1 }); // room for 40 pages
  for (let v = 0; v < 48; v++) fill(t, v); // 0..39 went to the tier in this order
  const order = [];
  for (let e = t.pager.tier.oldest(); e >= 0; e = t.pager.tier.newer(e)) order.push(t.pager.tier.pageOf(e));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'entries are in eviction order');
  check(t, order[0], (() => { const p = new Int32Array(W); PATTERNS.counters64(p); p[0] = order[0]; p[1] = 1; return p; })());
  // order[0] left the tier (faulted in); the next spill takes order[1].
  const writes = t.c.writes;
  for (let v = 100; v < 112; v++) fill(t, v);
  assert.ok(t.c.writes > writes, 'something spilled');
  assert.ok(!t.pager.tier.has(order[1]), 'the oldest remaining entry spilled');
  assert.ok(t.pager.tier.has(order[order.length - 1]), 'the newest did not');
});

test('pager: pages that do not compress bypass the tier', () => {
  const t = setup({ frames: 8 });
  const pages = [];
  for (let v = 0; v < 40; v++) pages.push(fill(t, v, 1, 'random'));
  assert.ok(t.pager.stats.tierRejects >= 32);
  assert.equal(t.pager.stats.tierStores, 0);
  assert.equal(t.c.writes, t.pager.stats.evictDirty, 'every dirty eviction went to storage');
  for (let v = 0; v < 40; v++) check(t, v, pages[v]);
});

test('pager: a dirty tier entry is never read from stale storage, readahead included', () => {
  const t = setup({ frames: 32, nvp: 512, readahead: 8, compressBytes: 256 << 10 });
  const v1 = [];
  for (let v = 0; v < 128; v++) v1.push(fill(t, v, 1, 'random')); // version 1: in storage
  t.pager.flushAll();
  const v2 = v1.slice();
  for (let v = 10; v < 100; v += 7) v2[v] = fill(t, v, 2); // version 2: compressible, dirty
  for (let v = 200; v < 264; v++) fill(t, v, 1); // push them out into the tier
  for (let v = 10; v < 100; v += 7) assert.ok(t.pager.tier.has(v), `page ${v} is in the tier`);
  const reads = t.c.reads, readPages = t.c.readPages;
  for (let v = 0; v < 128; v++) check(t, v, v2[v], `page ${v} after a sequential scan`);
  assert.ok(t.c.readPages - readPages > 3 * (t.c.reads - reads), 'readahead still batches storage reads');
  assert.ok(t.pager.stats.readaheadPages > 50);
});

test('pager: prefetched pages that were never used do not enter the tier', () => {
  const t = setup({ frames: 32, nvp: 1024, readahead: 8, compressBytes: 256 << 10 }); // room for the used pages, not for all
  const { pager, backend } = t;
  const counters = (v) => { const p = new Int32Array(W); PATTERNS.counters64(p); p[1] = v; return p; };
  // Pages 100.. are in storage (as after a resume), compressible, not in the tier.
  for (let v = 100; v < 400; v++) { backend.write(v, new Uint8Array(counters(v).buffer)); pager.written[v] = 1; pager.seen[v] = 1; }
  // Four used, dirty pages go into the tier.
  for (let v = 0; v < 4; v++) t.i32.set(counters(v), frameWords(t, pager.fault(v, 1)));
  for (let v = 500; v < 540; v++) pager.fault(v, 0); // zero pages push them out
  for (let v = 0; v < 4; v++) assert.ok(pager.tier.has(v), `page ${v} in the tier`);
  // Touch two pages of each 10: the second fault reads 8 ahead, 7 of them never used.
  const unused = [];
  for (let s = 100; s < 400; s += 10) {
    pager.fault(s, 0); pager.fault(s + 1, 0);
    for (let u = s + 2; u < s + 9; u++) if (pager.resident[u] >= 0) unused.push(u);
  }
  assert.ok(unused.length > 100, 'readahead prefetched pages');
  for (let v = 600; v < 700; v++) pager.fault(v, 0); // evict everything
  assert.deepEqual(unused.filter((u) => pager.tier.has(u)), [], 'speculative pages were dropped (storage has them), not compressed');
  assert.ok(pager.stats.readaheadUnused >= unused.length);
  for (let v = 0; v < 4; v++) assert.ok(pager.tier.has(v), `used page ${v} was not displaced by them`);
  for (let s = 100; s < 400; s += 10) assert.ok(pager.tier.has(s), `used clean page ${s} was kept`);
  // A prefetched page that gets used is kept like any other: 103 reads
  // 104..109 ahead (readahead stops at 110, which is in the tier), only 104
  // is used.
  pager.fault(102, 0); pager.fault(103, 0);
  for (let u = 104; u < 110; u++) assert.ok(pager.resident[u] >= 0, `page ${u} prefetched`);
  assert.ok(!(pager.resident[110] >= 0) && pager.tier.has(110), 'readahead stopped at the tier page');
  pager.fault(104, 0);
  for (let v = 800; v < 900; v++) pager.fault(v, 0);
  for (const u of [102, 103, 104]) assert.ok(pager.tier.has(u), `used page ${u} is in the tier`);
  for (let u = 105; u < 110; u++) assert.ok(!pager.tier.has(u), `unused page ${u} is not`);
});

test('pager: flush writes dirty tier entries to storage and keeps them as clean copies', () => {
  const t = setup({ frames: 8 });
  const pages = [];
  for (let v = 0; v < 30; v++) pages.push(fill(t, v));
  assert.equal(t.c.writes, 0);
  t.pager.flushAll();
  assert.equal(t.c.writes, 30, 'every page reached storage once (frames and tier)');
  assert.ok(t.pager.stats.tierFlushes >= 22);
  for (let v = 0; v < 30; v++) assert.deepEqual(storageHas(t, v), pages[v], `storage has page ${v}`);
  for (let v = 0; v < 30; v++) check(t, v, pages[v]);
  t.pager.flushAll();
  assert.equal(t.c.writes, 30, 'nothing new to write');
});

test('pager: a page changed after it was kept compressed reaches storage, never its old copy', () => {
  const t = setup({ frames: 8, compressBytes: 24 << 10 }); // room for 11 of these pages
  const pages = [];
  for (let v = 0; v < 16; v++) pages.push(fill(t, v));
  t.pager.flushAll(); // storage: version 1 of all; the tier holds clean copies
  const tier = t.pager.tier;
  assert.ok(tier.has(0) && tier.isClean(tier.get(0)));
  // Page 0: faulted in for reading (clean), then changed through the minor
  // write fault, then pushed out again: a dirty entry, not the clean one.
  const e = t.pager.fault(0, 0);
  assert.equal(e & 2, 0, 'mapped read-only: a store will fault');
  const p0 = pages[0].slice(); p0[5] = 42;
  t.i32.set(p0, frameWords(t, t.pager.fault(0, 1)));
  // Page 1: changed in the same fault that brought it in from the tier.
  const p1 = pages[1].slice(); p1[6] = 43;
  t.i32.set(p1, frameWords(t, t.pager.fault(1, 1)));
  for (let v = 16; v < 24; v++) pages.push(fill(t, v)); // push 0 and 1 back into the tier
  for (const v of [0, 1]) assert.ok(tier.has(v) && !tier.isClean(tier.get(v)), `page ${v}: a dirty entry`);
  assert.deepEqual(storageHas(t, 0), pages[0], 'storage still has version 1 (that is fine: the tier entry is dirty)');
  // Spill everything: storage must end up with the new versions.
  for (let v = 100; v < 140; v++) fill(t, v);
  for (const v of [0, 1]) assert.ok(!tier.has(v));
  assert.deepEqual(storageHas(t, 0), p0);
  assert.deepEqual(storageHas(t, 1), p1);
  check(t, 0, p0);
  check(t, 1, p1);
  // The same through a flush instead of a spill.
  const p2 = pages[2].slice(); p2[7] = 44;
  t.i32.set(p2, frameWords(t, t.pager.fault(2, 1)));
  for (let v = 200; v < 208; v++) fill(t, v);
  assert.ok(tier.has(2) && !tier.isClean(tier.get(2)));
  t.pager.flushAll();
  assert.deepEqual(storageHas(t, 2), p2);
  assert.ok(tier.isClean(tier.get(2)));
});

test('pager: random operations keep every copy of every page consistent (model check)', () => {
  // After every operation, for every page: a frame holds the latest
  // content, and so does storage if the frame is clean; a tier entry holds
  // it, and so does storage if the entry is clean; otherwise storage holds
  // it (or the page is zeros and storage never had it). Storage errors are
  // injected on the way.
  const gens = [
    (p) => p.fill(0),
    (p) => p.fill(rnd()),
    (p) => { p.fill(0); for (let i = 0; i < W; i += 2) p[i] = 5000 + i + (rnd() & 7); },
    (p) => { for (let i = 0; i < W; i++) p[i] = rnd(); },
    (p) => { p.fill(0); for (let i = 0; i < 20; i++) p[urnd(W)] = rnd(); },
  ];
  const tmp = new Int32Array(W);
  let steps = 0;
  for (let trial = 0; trial < 24; trial++) {
    const frames = 4 + urnd(8), nvp = 24 + urnd(40);
    const t = setup({ frames, nvp, readahead: 1 + urnd(8), compressBytes: [16 << 10, 24 << 10, 64 << 10][urnd(3)] });
    const { pager, i32 } = t;
    const tier = pager.tier;
    const model = Array.from({ length: nvp }, () => new Int32Array(W));
    const verify = (step) => {
      const where = `trial ${trial} step ${step}`;
      for (let v = 0; v < nvp; v++) {
        const f = pager.resident[v], m = model[v];
        if (f >= 0) {
          const fw = frameWords(t, pager.frameAddr(f));
          assert.ok(same(i32.subarray(fw, fw + W), m), `${where}: frame of page ${v}`);
          if (!pager.dirty[f]) assert.ok(same(storageHas(t, v), m), `${where}: page ${v} clean in a frame, storage stale`);
          assert.ok(!tier.has(v), `${where}: page ${v} in a frame and in the tier`);
          if (pager.pt[v] & 2) assert.ok(pager.dirty[f], `${where}: writable but clean`);
        } else if (tier.has(v)) {
          const e = tier.get(v);
          tier.unpack(e, tmp, 0);
          assert.ok(same(tmp, m), `${where}: tier copy of page ${v}`);
          if (tier.isClean(e)) assert.ok(same(storageHas(t, v), m), `${where}: page ${v} clean in the tier, storage stale`);
          assert.equal(pager.pt[v], 0);
        } else {
          assert.ok(same(storageHas(t, v), m), `${where}: page ${v} only in storage, stale`);
          assert.equal(pager.pt[v], 0);
        }
      }
      assert.equal(pager.pinned.reduce((a, x) => a + x, 0), 0, `${where}: no frame left pinned`);
      let blocks = 0;
      for (let e = tier.oldest(); e >= 0; e = tier.newer(e)) blocks += CompressedTier.blockBytes(tier.wordsOf(e)) / 128;
      assert.equal(blocks + tier.nfree, tier.nblocks, `${where}: no tier block lost`);
    };
    for (let step = 0; step < 300; step++, steps++) {
      const r = urnd(100);
      const v = urnd(3) ? urnd(Math.min(nvp, frames * 3)) : urnd(nvp);
      t.c.fail = r % 17 === 0; // some operations meet a storage error
      try {
        if (r < 40) {
          const fw = frameWords(t, pager.fault(v, 0));
          assert.ok(same(i32.subarray(fw, fw + W), model[v]), `read ${v}`);
        } else if (r < 85) {
          const fw = frameWords(t, pager.fault(v, 1));
          const p = new Int32Array(W);
          if (r < 70) gens[urnd(gens.length)](p); else { p.set(model[v]); p[urnd(W)] = rnd(); }
          i32.set(p, fw);
          model[v] = p;
        } else if (r < 90) {
          pager.flushAll();
        } else { // a sequential scan, for readahead
          for (let u = urnd(nvp), end = Math.min(nvp, u + 12); u < end; u++) {
            const fw = frameWords(t, pager.fault(u, 0));
            assert.ok(same(i32.subarray(fw, fw + W), model[u]), `scan ${u}`);
          }
        }
      } catch (e) {
        if (!/EIO/.test(e.message)) throw e;
      }
      t.c.fail = false;
      verify(step);
    }
    assert.ok(pager.stats.tierHits > 0 && pager.stats.tierStores > 0, `trial ${trial} used the tier`);
  }
  assert.equal(steps, 24 * 300);
});

test('pager: a storage error while spilling loses nothing and leaks no frame', () => {
  const t = setup({ frames: 8, compressBytes: 16 << 10 });
  const pages = [];
  for (let v = 0; v < 20; v++) pages.push(fill(t, v));
  t.c.fail = true;
  let errors = 0;
  for (let v = 20; v < 60; v++) {
    try { pages[v] = fill(t, v); } catch (e) { assert.match(e.message, /EIO/); errors++; }
  }
  assert.ok(errors > 0, 'storage errors happened');
  assert.equal(t.pager.pinned.reduce((a, x) => a + x, 0), 0, 'no frame left pinned');
  t.c.fail = false;
  for (let v = 0; v < 60; v++) if (pages[v]) check(t, v, pages[v]);
});

test('pager: a tier fault that cannot get a frame puts the page back', () => {
  const t = setup({ frames: 8 });
  const pages = [];
  for (let v = 0; v < 12; v++) pages.push(fill(t, v, 1, v < 4 ? 'counters64' : 'random'));
  assert.ok(t.pager.tier.has(0));
  t.c.fail = true; // the next eviction (a dirty random page) cannot be written
  assert.throws(() => t.pager.fault(0, 0), /EIO/);
  assert.ok(t.pager.tier.has(0), 'page 0 is still in the tier');
  t.c.fail = false;
  for (let v = 0; v < 12; v++) check(t, v, pages[v]);
});

test('pager: enabling the tier allocates nothing per virtual page', () => {
  const mk = (compressBytes) => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    return [new Pager({ memory, ptAddr: 0, nvp: 1 << 14, framesAddr: 65536, poolFrames: 16, backend: new MemoryBackend(), compressBytes }), memory];
  };
  const [a, ma] = mk(0), [b, mb] = mk(64 << 10);
  assert.equal(ownedBytes(b, mb.buffer), ownedBytes(a, ma.buffer), 'the same pager metadata with and without a tier');
  assert.ok(ownedBytes(b.tier) <= 64 << 10, 'and the tier within its budget');
});

test('write budget: only storage writes are charged, not pages kept in the tier', () => {
  const t = setup({ frames: 8, compressBytes: 64 << 10, writeBudgetBytes: 4 * PAGE, onBudget: 'throw' });
  for (let v = 0; v < 32; v++) fill(t, v); // 24 dirty pages evicted, all into the tier
  assert.ok(t.pager.stats.tierStores >= 24);
  assert.equal(t.c.writes, 0);
  assert.equal(t.pager.stats.writeBytes, 0);
  assert.equal(t.pager.budgetUsed, 0, 'far over 4 pages evicted, nothing charged');
  assert.throws(() => t.pager.flushAll(), VeraBudgetError, 'a flush really writes');
  assert.equal(t.c.writes, 5, 'the write that crossed the budget, then the pager stopped');
  assert.equal(t.pager.budgetUsed, 5 * PAGE);
  // With spills, drops and flushes: every charged byte is a storage write.
  const u = setup({ frames: 8, compressBytes: 16 << 10 });
  const pages = [];
  for (let v = 0; v < 100; v++) pages.push(fill(u, v, 1, v % 5 ? 'counters64' : 'random'));
  for (let v = 0; v < 100; v += 3) check(u, v, pages[v]); // clean pages through the tier: dropped, not written
  for (let v = 100; v < 111; v++) fill(u, v); // the last three evicted are dirty tier entries
  u.pager.flushAll();
  assert.ok(u.pager.stats.tierSpills > 0 && u.pager.stats.tierFlushes > 0 && u.pager.stats.tierDrops > 0);
  assert.equal(u.pager.stats.writeOps, u.c.writes);
  assert.equal(u.pager.stats.writeBytes, u.c.writes * PAGE);
  assert.equal(u.pager.budgetUsed, u.c.writes * PAGE);
});

test('fault curve with a tier: predicts a bigger pool behind the same tier', () => {
  const N = 48; // 16 frames + a 23-page tier hold 39 of them; 32 frames + the tier hold all
  const scan = (frames) => {
    const t = setup({ frames, nvp: 256, readahead: 1, compressBytes: 40 << 10 });
    for (let round = 1; round <= 4; round++) for (let v = 0; v < N; v++) fill(t, v, round);
    return t.pager;
  };
  const small = scan(16), big = scan(32);
  const c = small.curve.report();
  assert.ok(small.stats.majorRead >= 2 * N, `a cyclic scan thrashes 16 frames + tier (${small.stats.majorRead} reads)`);
  assert.equal(big.stats.majorRead, 0, '32 frames + tier: no storage reads');
  assert.equal(c.predicted[0].poolMultiplier, 2);
  assert.ok(c.predicted[0].storageReads <= N / 4, `predicted ${c.predicted[0].storageReads} reads with a 2x pool, measured 0`);
  assert.match(c.note, /compressed tier/);
});

// ---- whole programs --------------------------------------------------------

test('fuzz: identical results with tiny pools and compressed tiers', async () => {
  const { vera, base } = built('apps/fuzz.c');
  for (const seedArg of [1, 2]) {
    const ref = await runBase(base, [8, 100_000, seedArg]);
    for (const [poolBytes, compressBytes, backend] of [
      [64 << 10, 64 << 10, 'mem'], [64 << 10, 256 << 10, 'file'], [64 << 10, 16 << 10, 'mem'],
      [1 << 20, 1 << 20, 'delay'], [256 << 10, 4 << 20, 'mem'],
    ]) {
      const r = await runVera(vera, [8, 100_000, seedArg], { poolBytes, backend, compressBytes });
      assert.equal(r.status, 0);
      assert.equal(r.value, ref.value, `seed ${seedArg}, pool ${poolBytes >> 10} KiB, tier ${compressBytes >> 10} KiB, ${backend}`);
      assert.ok(r.stats.tierHits > 0 && r.stats.tierStores > 0, 'the tier was used');
      if (compressBytes <= 256 << 10) assert.ok(r.stats.tierSpills > 0 && r.stats.majorRead > 0, 'and spilled to storage');
      assert.ok(r.stats.tierMemoryBytes <= compressBytes);
    }
  }
});

for (const [app, mb, ops] of [
  ['sort', 8, 0], ['blur', 8, 1], ['hash', 8, 100_000], ['rand', 8, 200_000], ['chase', 2, 50_000], ['packed', 8, 100_000],
]) {
  test(`${app}: paged result equals baseline with a 12.5% pool and a 12.5% tier`, async () => {
    const { vera, base } = built(`apps/${app}.c`);
    const ref = await runBase(base, [mb, ops, 7]);
    const r = await runVera(vera, [mb, ops, 7], { poolBytes: (mb << 20) / 8, compressBytes: (mb << 20) / 8, backend: 'file' });
    assert.equal(r.status, 0);
    assert.equal(r.value, ref.value);
  });
}

test('store ordering: a[i] += a[j] with frames recycled through the tier', async () => {
  const { vera, base } = built('test/fixtures/rmw.c');
  for (const npages of [17, 20, 40]) {
    const ref = await runBase(base, [npages, 100_000, 5]);
    const r = await runVera(vera, [npages, 100_000, 5], { poolBytes: 64 << 10, compressBytes: 32 << 10 });
    assert.equal(r.value, ref.value, `${npages} pages, 16 frames + tier`);
    assert.ok(r.stats.tierHits > 1000, 'really going through the tier');
  }
});

test('stats and meter: the tier reports its memory, and storage writes stay storage writes', async () => {
  const { vera, base } = built('apps/rand.c');
  const ref = await runBase(base, [4, 50_000, 3]);
  const r = await runVera(vera, [4, 50_000, 3], { poolBytes: 512 << 10, compressBytes: 512 << 10 });
  assert.equal(r.value, ref.value);
  const s = r.stats;
  assert.equal(s.compressBytes, 512 << 10);
  assert.ok(s.tierMemoryBytes <= s.compressBytes && s.tierMemoryBytes > s.compressBytes - 200);
  assert.ok(s.tierUsedBytes <= s.tierMemoryBytes);
  assert.ok(s.tierHits > 0 && s.tierPages > 0);
  assert.ok(s.tierBlockBytes >= s.tierOutBytes && s.tierOutBytes < s.tierInBytes, 'blocks hold the compressed words and more');
  assert.equal(s.writeBytes, s.writeOps * PAGE);
  assert.equal(s.budgetUsedBytes, s.writeBytes);
  const en = r.vera.meter('en'), tr = r.vera.meter('tr');
  assert.match(en, /Compressed tier: 0\.5 MiB of JS memory/);
  assert.match(en, new RegExp(`${s.tierHits} faults were served from it`));
  assert.match(tr, /Sıkıştırılmış katman: 0,5 MiB JS belleği/);
  const off = await runVera(vera, [4, 50_000, 3], { poolBytes: 512 << 10 });
  assert.equal(off.stats.compressBytes, 0);
  assert.doesNotMatch(off.vera.meter('en'), /Compressed tier/);
});

// ---- durable checkpoints ------------------------------------------------------

const counterPage = (v, ver) => { const p = new Int32Array(W); PATTERNS.counters64(p); p[0] = v; p[1] = ver; return new Uint8Array(p.buffer); };

test('durable: a checkpoint includes pages that were only in the tier', async () => {
  const { vera: wasm } = built('test/fixtures/steps.c');
  const store = new MemStore();
  const v1 = await createVera({ wasm, poolBytes: 64 << 10, compressBytes: 256 << 10, durableStore: store, resume: true });
  const base = v1.layout.vbase;
  for (let v = 0; v < 128; v++) v1.write(base + v * PAGE, counterPage(v, 1));
  assert.ok(v1.stats().tierPages > 64, 'most pages are only in the tier');
  v1.checkpoint({ k: 1 });
  assert.ok(v1.stats().tierFlushes > 64);
  for (let v = 0; v < 128; v += 2) v1.write(base + v * PAGE, counterPage(v, 2)); // after the checkpoint: lost
  v1.close();
  const v2 = await createVera({ wasm, poolBytes: 64 << 10, compressBytes: 256 << 10, durableStore: store, resume: true });
  assert.deepEqual(v2.resumed.extra, { k: 1 });
  for (let v = 0; v < 128; v++) assert.deepEqual(v2.read(base + v * PAGE, PAGE), counterPage(v, 1), `page ${v}`);
  v2.close();
});

test('durable: a crash in any phase of a checkpoint resumes the last committed one, tier or not', async () => {
  // Checkpoint 1 has version 1 of 96 pages. Then every third page changes
  // (version 2): with the big tier the changes sit in frames and dirty tier
  // entries; with the small one most are spilled to storage (the uncommitted
  // slots) before checkpoint 2 starts. The "crash" is an exception thrown
  // from the phase hook; the instance is then abandoned, as a killed process
  // would leave it, and a new one resumes from the same store.
  const { vera: wasm } = built('test/fixtures/steps.c');
  for (const compressBytes of [256 << 10, 32 << 10]) {
    for (const phase of ['meta', 'low', 'flushed', 'half-header', 'committed']) {
      const store = new MemStore();
      const opts = { wasm, poolBytes: 64 << 10, compressBytes, durableStore: store, resume: true };
      const v1 = await createVera(opts);
      const base = v1.layout.vbase;
      for (let v = 0; v < 96; v++) v1.write(base + v * PAGE, counterPage(v, 1));
      v1.checkpoint({ e: 1 });
      const spilled = v1.stats().tierSpills;
      for (let v = 0; v < 96; v += 3) v1.write(base + v * PAGE, counterPage(v, 2));
      for (let v = 1; v < 96; v += 3) v1.read(base + v * PAGE, 16); // clean pages through the tier too
      const s = v1.stats();
      if (compressBytes > 64 << 10) assert.equal(s.tierSpills, spilled, 'big tier: nothing spilled');
      else assert.ok(s.tierSpills > spilled, 'small tier: version-2 pages spilled to storage before the checkpoint');
      v1.pager.backend.onPhase = (ph) => { if (ph === phase) throw new Error(`crash in ${ph}`); };
      assert.throws(() => v1.checkpoint({ e: 2 }), /crash/);
      const v2 = await createVera(opts);
      const want = phase === 'committed' ? 2 : 1;
      assert.deepEqual(v2.resumed.extra, { e: want }, `${compressBytes >> 10} KiB tier, crash in ${phase}`);
      for (let v = 0; v < 96; v++) {
        const ver = want === 2 && v % 3 === 0 ? 2 : 1;
        assert.deepEqual(v2.read(base + v * PAGE, PAGE), counterPage(v, ver), `${compressBytes >> 10} KiB, ${phase}: page ${v}`);
      }
      v2.close();
    }
  }
});

// Review concern: close() does not flush dirty tier entries. It is the
// documented close() semantics, the same with or without a tier: close()
// writes no pages, flush() and checkpoint() are the persistence points (the
// durable test above shows checkpoint() with the tier). With a swap file
// kept after close (keep: true), flush() first keeps every page, including
// the ones only the tier held.
test('close() writes no pages, tier or not; flush() before it keeps frame and tier pages alike', async () => {
  const { vera: wasm } = built('test/fixtures/steps.c');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-close-'));
  const N = 128;
  try {
    for (const compressBytes of [0, 256 << 10]) {
      for (const flushFirst of [false, true]) {
        const file = path.join(dir, `swap-${compressBytes}-${flushFirst}.bin`);
        const be = new NodeFileBackend(fs, file, { keep: true });
        let closing = false, writesInClose = 0;
        const spy = {
          kind: 'file', read: (v, n, u8) => be.read(v, n, u8), flush: () => be.flush(), close: () => be.close(),
          write: (v, u8) => { if (closing) writesInClose++; be.write(v, u8); },
        };
        const vera = await createVera({ wasm, poolBytes: 64 << 10, backend: spy, compressBytes });
        const base = vera.layout.vbase;
        for (let v = 0; v < N; v++) vera.write(base + v * PAGE, counterPage(v, 1));
        if (compressBytes) assert.ok(vera.stats().tierPages > N / 2, 'most pages are only in the tier');
        if (flushFirst) vera.flush();
        closing = true;
        vera.close();
        const what = `compressBytes ${compressBytes}, ${flushFirst ? 'flush, close' : 'close'}`;
        assert.equal(writesInClose, 0, `${what}: close() wrote nothing`);
        const img = fs.readFileSync(file);
        let kept = 0;
        for (let v = 0; v < N; v++) if (img.length >= (v + 1) * PAGE && same(img.subarray(v * PAGE, (v + 1) * PAGE), counterPage(v, 1))) kept++;
        if (flushFirst) assert.equal(kept, N, `${what}: the file has every page`);
        else assert.ok(kept < N - 8, `${what}: pages changed since the last flush are not in the file (${kept} of ${N} are)`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
