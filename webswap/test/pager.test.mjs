import test from 'node:test';
import assert from 'node:assert/strict';
import { Pager, VeraBudgetError } from '../runtime/pager.mjs';
import { MemoryBackend, PAGE } from '../runtime/backends.mjs';
import { probeMaxMemoryBytes } from '../runtime/vera.mjs';

// Pager on a bare Memory: page table at 0, frames at 64 KiB.
function setup({ frames = 8, nvp = 256, ...opts } = {}) {
  const framesAddr = 65536;
  const memory = new WebAssembly.Memory({ initial: (framesAddr + frames * PAGE) / 65536 + 1 });
  const backend = new MemoryBackend();
  let writes = 0, reads = 0;
  const counting = {
    kind: 'count',
    read: (v, n, u8) => { reads++; backend.read(v, n, u8); },
    write: (v, u8) => { writes++; backend.write(v, u8); },
    flush() {}, close() {},
  };
  const pager = new Pager({ memory, ptAddr: 0, nvp, framesAddr, poolFrames: frames, backend: counting, ...opts });
  const u8 = new Uint8Array(memory.buffer);
  const addr = (e) => e & ~0xfff;
  return { pager, u8, addr, counts: () => ({ reads, writes }), backend };
}

test('never-written pages are zero-filled without reading storage', () => {
  const { pager, u8, addr, counts } = setup();
  const e = pager.fault(3, 0);
  assert.equal(u8.subarray(addr(e), addr(e) + PAGE).every((x) => x === 0), true);
  assert.equal(counts().reads, 0);
  assert.equal(pager.stats.zeroFill, 1);
});

test('clean pages are evicted with zero writes', () => {
  const { pager, counts } = setup({ frames: 4 });
  for (let v = 0; v < 40; v++) pager.fault(v, 0);
  assert.equal(counts().writes, 0);
  assert.ok(pager.stats.evictClean > 0);
});

test('a dirty page is written back exactly once and reads back intact', () => {
  const { pager, u8, addr, counts } = setup({ frames: 4 });
  const e = pager.fault(7, 1);
  u8.fill(0x5a, addr(e), addr(e) + PAGE);
  for (let v = 20; v < 40; v++) pager.fault(v, 0); // push page 7 out
  assert.equal(counts().writes, 1);
  assert.equal(pager.stats.writeBytes, PAGE);
  const e2 = pager.fault(7, 0);
  assert.equal(u8.subarray(addr(e2), addr(e2) + PAGE).every((x) => x === 0x5a), true);
});

test('store to a read-mapped page faults once to mark it dirty', () => {
  const { pager } = setup();
  const e = pager.fault(1, 0);
  assert.equal(e & 2, 0, 'read mapping is not writable');
  const e2 = pager.fault(1, 1);
  assert.equal(e2 & 2, 2);
  assert.equal(pager.stats.minor, 1);
  assert.equal(pager.pt[1], e2);
});

// Map page v for writing and fill it with a non-zero byte (all-zero pages
// are never written to storage).
function dirty(t, v, byte = (v & 0xff) | 1) {
  const e = t.pager.fault(v, 1);
  t.u8.fill(byte, t.addr(e), t.addr(e) + PAGE);
}

test('sequential faults use readahead: one storage read per 16 pages', () => {
  const t = setup({ frames: 64, nvp: 1024, readahead: 16 });
  const { pager, counts } = t;
  for (let v = 0; v < 256; v++) dirty(t, v); // 256 dirty pages; most get evicted
  pager.flushAll();
  const before = counts().reads;
  for (let v = 0; v < 256; v++) if (pager.resident[v] < 0) pager.fault(v, 0); else pager.fault(v, 0);
  const reads = counts().reads - before;
  assert.ok(reads <= Math.ceil(256 / 16) + 2, `expected <= 18 reads, got ${reads}`);
  assert.ok(pager.stats.readaheadPages > 0);
});

test('CLOCK gives referenced pages a second chance', () => {
  const { pager } = setup({ frames: 4 });
  for (let v = 0; v < 4; v++) pager.fault(v, 0); // frames full, all referenced
  pager.fault(4, 0); // hand clears refs of 0..3 (unmapping them), evicts 0
  pager.fault(1, 0); // minor fault: page 1 referenced again
  pager.fault(5, 0); // must evict an unreferenced page, not 1
  assert.ok(pager.resident[1] >= 0, 'page 1 survived');
  assert.ok(pager.stats.minor >= 1);
});

test('write budget: throw mode aborts, warn mode reports once after the fault returns', async () => {
  const t = setup({ frames: 4, writeBudgetBytes: 2 * PAGE, onBudget: 'throw' });
  assert.throws(() => { for (let v = 0; v < 20; v++) dirty(t, v); }, VeraBudgetError);
  const events = [];
  const w = setup({ frames: 4, writeBudgetBytes: 2 * PAGE, onBudget: 'warn', onEvent: (e) => events.push(e) });
  for (let v = 0; v < 20; v++) dirty(w, v);
  assert.equal(events.length, 0, 'not delivered inside the fault');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'budget');
});

test('a budget store keeps the 24 h window across pagers (really daily)', () => {
  let saved = null;
  const store = { save: (st) => { saved = st; } };
  const a = setup({ frames: 4, writeBudgetBytes: 1 << 30, saveBudget: store.save });
  for (let v = 0; v < 12; v++) dirty(a, v);
  a.pager.flushAll();
  assert.ok(saved && saved.used === a.pager.budgetUsed && saved.used > 0);
  const b = setup({ frames: 4, writeBudgetBytes: 1 << 30, budgetState: saved, saveBudget: store.save });
  assert.equal(b.pager.budgetUsed, saved.used, 'second run starts from the first one\'s total');
  assert.equal(b.pager.budgetScope, 'day');
  const old = setup({ frames: 4, budgetState: { windowStart: Date.now() - 2 * 86400000, used: 999 } });
  assert.equal(old.pager.budgetUsed, 0, 'an expired window starts over');
});

test('all-zero pages are never written to storage', () => {
  const { pager, counts } = setup({ frames: 4 });
  for (let v = 0; v < 40; v++) pager.fault(v, 1); // written to, but only zeros
  pager.flushAll();
  assert.equal(counts().writes, 0);
  assert.ok(pager.stats.zeroElided > 0);
});

test('a host callback cannot re-enter the pager during a fault', () => {
  const t = setup({ frames: 4 });
  t.pager.fault(1, 0);
  t.pager.inFault = true; // as if we were inside a fault
  assert.throws(() => t.pager.touch(99, false), /re-entrant/);
  t.pager.inFault = false;
});

test('a storage error during readahead does not leak pinned frames', () => {
  const t = setup({ frames: 16, nvp: 1024, readahead: 4 });
  for (let v = 0; v < 64; v++) dirty(t, v);
  t.pager.flushAll();
  let fail = true;
  const inner = t.pager.backend;
  t.pager.backend = { ...inner, kind: 'flaky', read: inner.read, write: (v, u8) => { if (fail) throw new Error('EIO'); inner.write(v, u8); } };
  for (let v = 100; v < 116; v++) dirty(t, v); // dirty frames that will need write-back
  for (let round = 0; round < 8; round++) {
    try { for (let v = 0; v < 8; v++) t.pager.fault(v, 0); } catch { /* storage error */ }
  }
  assert.equal(t.pager.pinned.reduce((a, x) => a + x, 0), 0, 'no frame left pinned');
  fail = false;
  for (let v = 0; v < 40; v++) t.pager.fault(v, 0); // still works after recovery
});

test('fault curve: a cyclic scan of 2P pages thrashes a P-frame pool but fits in 2P', () => {
  const P = 16;
  const t = setup({ frames: P, nvp: 1024, readahead: 1 });
  const { pager } = t;
  for (let v = 0; v < 2 * P; v++) dirty(t, v); // first pass: zero-fill faults, not storage reads
  for (let round = 0; round < 2; round++) for (let v = 0; v < 2 * P; v++) {
    if (!(pager.pt[v] & 1)) pager.fault(v, 1);
  }
  const c = pager.curve.report();
  assert.equal(c.measuredStorageReads, pager.stats.majorRead, 'the curve counts exactly the storage reads');
  assert.ok(c.measuredStorageReads >= 3 * P, 'thrashes with P frames');
  assert.equal(c.predicted[0].poolMultiplier, 2);
  assert.equal(c.predicted[0].storageReads, 0, 'with 2P frames every page stays resident: no reads at all');
});

test('fault curve: a write-only fill reports zero storage reads', () => {
  const t = setup({ frames: 8, nvp: 1024 });
  for (let v = 0; v < 200; v++) dirty(t, v);
  assert.equal(t.pager.curve.report().measuredStorageReads, 0);
  assert.equal(t.pager.stats.majorRead, 0);
});

test('auto pool probe finds a usable Memory size', () => {
  const got = probeMaxMemoryBytes(64 << 20);
  assert.ok(got >= 16 * 65536 && got <= 64 << 20);
});
