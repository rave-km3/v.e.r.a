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

test('sequential faults use readahead: one storage read per 16 pages', () => {
  const { pager, counts } = setup({ frames: 64, nvp: 1024, readahead: 16 });
  for (let v = 0; v < 256; v++) pager.fault(v, 1); // dirty 256 pages; most get evicted
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

test('write budget: throw mode aborts, warn mode emits one event', () => {
  const t = setup({ frames: 4, writeBudgetBytesPerDay: 2 * PAGE, onBudget: 'throw' });
  assert.throws(() => { for (let v = 0; v < 20; v++) t.pager.fault(v, 1); }, VeraBudgetError);
  const events = [];
  const w = setup({ frames: 4, writeBudgetBytesPerDay: 2 * PAGE, onBudget: 'warn', onEvent: (e) => events.push(e) });
  for (let v = 0; v < 20; v++) w.pager.fault(v, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'budget');
});

test('fault curve: a cyclic scan of 2P pages thrashes a P-frame pool but fits in 2P', () => {
  const P = 16;
  const { pager } = setup({ frames: P, nvp: 1024, readahead: 1 });
  for (let round = 0; round < 3; round++) for (let v = 0; v < 2 * P; v++) {
    if (!(pager.pt[v] & 1)) pager.fault(v, 1);
  }
  const c = pager.curve.report();
  assert.equal(c.compulsory, 2 * P);
  assert.ok(c.measuredMajorFaults >= 5 * P, 'thrashes with P frames');
  assert.equal(c.predicted[0].poolMultiplier, 2);
  assert.equal(c.predicted[0].majorFaults, 2 * P, 'with 2P frames only compulsory faults remain');
});

test('auto pool probe finds a usable Memory size', () => {
  const got = probeMaxMemoryBytes(64 << 20);
  assert.ok(got >= 16 * 65536 && got <= 64 << 20);
});
