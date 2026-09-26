// pager.mjs - the WebSwap page-fault handler.
//
// The wasm program only calls in here when a translation misses
// (runtime/softmmu.c). Everything is synchronous.
//
// Frames: a fixed pool of 4 KiB frames inside the real WebAssembly.Memory.
// Replacement: CLOCK with sampled reference bits. When the hand passes a
// referenced frame it clears the bit and unmaps the page in the page table
// ("soft invalidation"); if the program touches it again before the hand
// comes back, a cheap minor fault (no I/O) remaps it and sets the bit.
// Dirty tracking: pages are mapped read-only until the first store, which
// faults once and marks the frame dirty. Clean frames are dropped with no
// I/O; dirty ones are written back once.
// Zero pages: a page that was never written back reads as zeros without
// touching storage.
// Readahead: on a sequential run of major faults, read up to `readahead`
// following pages in one backend call. Prefetched pages stay unmapped until
// first use, so their first touch is a minor fault that records the use.
// Write budget: bytes written to storage are counted against a daily budget;
// 'warn' emits an event once, 'throw' aborts the program.

import { PAGE } from './backends.mjs';

export class VeraBudgetError extends Error {
  constructor(msg) { super(msg); this.name = 'VeraBudgetError'; }
}

const HIST_BUCKETS = 24; // log2 microseconds: <1us, <2us, ..., >= 2^22 us

// Predicts how many major faults a bigger pool would have taken.
// Pages evicted and not yet faulted back form a "ghost" list in eviction
// order. A refault of page v whose ghost entry has d newer ghosts would have
// hit in a pool with E extra frames iff d < E (exact for LRU; approximate
// for CLOCK, which is what we run).
class FaultCurve {
  constructor(nvp, poolFrames, multipliers) {
    this.lastEvict = new Int32Array(nvp);
    this.cap = 1 << 20;
    this.bit = new Int32Array(this.cap + 1);
    this.t = 0;
    this.poolFrames = poolFrames;
    this.multipliers = multipliers;
    this.extras = multipliers.map((k) => Math.round((k - 1) * poolFrames));
    this.beyond = multipliers.map(() => 0);
    this.compulsory = 0;
    this.refaults = 0;
  }
  add(i, d) { for (; i <= this.cap; i += i & -i) this.bit[i] += d; }
  sum(i) { let s = 0; for (; i > 0; i -= i & -i) s += this.bit[i]; return s; }
  compact() {
    const live = [];
    for (let v = 0; v < this.lastEvict.length; v++) if (this.lastEvict[v]) live.push(v);
    live.sort((a, b) => this.lastEvict[a] - this.lastEvict[b]);
    while (live.length + 1 >= this.cap) this.cap *= 2;
    this.bit = new Int32Array(this.cap + 1);
    live.forEach((v, i) => { this.lastEvict[v] = i + 1; this.add(i + 1, 1); });
    this.t = live.length;
  }
  onEvict(v) {
    if (this.t + 1 > this.cap) this.compact();
    this.t++;
    this.lastEvict[v] = this.t;
    this.add(this.t, 1);
  }
  forget(v) { // page became resident without a counted fault (prefetch)
    const te = this.lastEvict[v];
    if (te) { this.add(te, -1); this.lastEvict[v] = 0; }
  }
  onMajor(v, firstTouch) {
    const te = this.lastEvict[v];
    if (firstTouch || !te) { this.compulsory++; this.forget(v); return; }
    const d = this.sum(this.t) - this.sum(te);
    this.forget(v);
    this.refaults++;
    for (let i = 0; i < this.extras.length; i++) if (d >= this.extras[i]) this.beyond[i]++;
  }
  report() {
    return {
      measuredMajorFaults: this.compulsory + this.refaults,
      compulsory: this.compulsory,
      predicted: this.multipliers.map((k, i) => ({
        poolMultiplier: k,
        poolFrames: Math.round(k * this.poolFrames),
        majorFaults: this.compulsory + this.beyond[i],
      })),
      note: 'approximate: exact for LRU, the pager runs CLOCK',
    };
  }
}

export class Pager {
  constructor({
    memory, ptAddr, nvp, framesAddr, poolFrames, backend,
    readahead = 16, writeBudgetBytesPerDay = 2 ** 30, onBudget = 'warn', onEvent = null,
    curveMultipliers = [2, 4],
  }) {
    if (poolFrames < 4) throw new Error('vera: pool must have at least 4 frames');
    this.u8 = new Uint8Array(memory.buffer); // the Memory never grows
    this.pt = new Uint32Array(memory.buffer, ptAddr, nvp);
    this.nvp = nvp;
    this.framesAddr = framesAddr;
    this.P = poolFrames;
    this.backend = backend;
    this.owner = new Int32Array(poolFrames).fill(-1);
    this.dirty = new Uint8Array(poolFrames);
    this.ref = new Uint8Array(poolFrames);
    this.pinned = new Uint8Array(poolFrames);
    this.resident = new Int32Array(nvp).fill(-1);
    this.written = new Uint8Array(nvp); // storage holds a copy of this page
    this.seen = new Uint8Array(nvp);
    this.nextUnused = 0;
    this.hand = 0;
    this.lastMajor = -2;
    this.raMax = Math.max(1, Math.min(readahead | 0, Math.floor(poolFrames / 4)));
    this.tmp = new Uint8Array(this.raMax * PAGE);
    this.budget = writeBudgetBytesPerDay;
    this.onBudget = onBudget;
    this.onEvent = onEvent;
    this.budgetWindowStart = Date.now();
    this.budgetUsed = 0;
    this.budgetWarned = false;
    this.broken = null;
    this.curve = new FaultCurve(nvp, poolFrames, curveMultipliers);
    this.stats = {
      majorRead: 0, zeroFill: 0, minor: 0, readaheadPages: 0,
      readOps: 0, readBytes: 0, writeOps: 0, writeBytes: 0,
      evictClean: 0, evictDirty: 0, refCleared: 0,
      faultTimeMs: 0, hist: new Array(HIST_BUCKETS).fill(0),
    };
  }

  frameAddr(f) { return this.framesAddr + f * PAGE; }
  entry(f) { return (this.frameAddr(f) | 1 | (this.dirty[f] ? 2 : 0)) >>> 0; }
  frameView(f) { const a = this.frameAddr(f); return this.u8.subarray(a, a + PAGE); }

  // Called from wasm (import vera.fault). Returns the page table entry.
  fault(v, write) {
    if (this.broken) throw this.broken;
    const f = this.resident[v];
    if (f >= 0) { // minor: still in a frame, just unmapped or read-only
      this.stats.minor++;
      this.ref[f] = 1;
      if (write) this.dirty[f] = 1;
      const e = this.entry(f);
      this.pt[v] = e;
      return e;
    }
    return this.major(v, write);
  }

  major(v, write) {
    const t0 = performance.now();
    // Account the fault before allocating a frame: the eviction this fault
    // causes would not happen in a bigger pool.
    this.curve.onMajor(v, !this.seen[v]);
    this.seen[v] = 1;
    let count = 1;
    const fromStorage = this.written[v] === 1;
    if (fromStorage) {
      if (v === this.lastMajor + 1) {
        while (count < this.raMax && v + count < this.nvp && this.written[v + count] && this.resident[v + count] < 0) count++;
      }
      this.backend.read(v, count, this.tmp);
      this.stats.readOps++;
      this.stats.readBytes += count * PAGE;
      this.stats.majorRead++;
      this.stats.readaheadPages += count - 1;
      const frames = [];
      for (let i = 0; i < count; i++) {
        const fr = this.allocFrame();
        frames.push(fr);
        this.u8.set(this.tmp.subarray(i * PAGE, (i + 1) * PAGE), this.frameAddr(fr));
        if (i === 0) this.map(v, fr, write, true);
        else { this.map(v + i, fr, false, false); this.seen[v + i] = 1; this.curve.forget(v + i); }
      }
      for (const fr of frames) this.pinned[fr] = 0;
    } else {
      const fr = this.allocFrame();
      this.u8.fill(0, this.frameAddr(fr), this.frameAddr(fr) + PAGE);
      this.map(v, fr, write, true);
      this.pinned[fr] = 0;
      this.stats.zeroFill++;
    }
    this.lastMajor = v + count - 1;
    const dt = performance.now() - t0;
    this.stats.faultTimeMs += dt;
    if (fromStorage) { // latency histogram only for faults that read storage
      const us = dt * 1000;
      this.stats.hist[Math.min(HIST_BUCKETS - 1, us < 1 ? 0 : Math.floor(Math.log2(us)) + 1)]++;
    }
    return this.pt[v];
  }

  // mapped=true: the faulting page (present in the page table, referenced).
  // mapped=false: a prefetched page (resident, unmapped until first use).
  map(v, f, write, mapped) {
    this.owner[f] = v;
    this.resident[v] = f;
    this.dirty[f] = write ? 1 : 0;
    this.ref[f] = mapped ? 1 : 0;
    this.pt[v] = mapped ? this.entry(f) : 0;
  }

  allocFrame() {
    let f;
    if (this.nextUnused < this.P) {
      f = this.nextUnused++;
    } else {
      for (let scanned = 0; ; scanned++) {
        if (scanned > 3 * this.P) throw new Error('vera: no evictable frame');
        const c = this.hand;
        this.hand = c + 1 === this.P ? 0 : c + 1;
        if (this.pinned[c]) continue;
        if (this.ref[c]) { // second chance: clear the bit and unmap to sample reuse
          this.ref[c] = 0;
          this.pt[this.owner[c]] = 0;
          this.stats.refCleared++;
          continue;
        }
        this.evict(c);
        f = c;
        break;
      }
    }
    this.pinned[f] = 1;
    return f;
  }

  evict(f) {
    const v = this.owner[f];
    if (this.dirty[f]) {
      this.writeBack(v, f);
      this.stats.evictDirty++;
    } else {
      this.stats.evictClean++;
    }
    this.pt[v] = 0;
    this.resident[v] = -1;
    this.owner[f] = -1;
    this.dirty[f] = 0;
    this.ref[f] = 0;
    this.curve.onEvict(v);
  }

  writeBack(v, f) {
    this.backend.write(v, this.frameView(f));
    this.written[v] = 1;
    this.stats.writeOps++;
    this.stats.writeBytes += PAGE;
    this.chargeBudget(PAGE);
  }

  chargeBudget(bytes) {
    const now = Date.now();
    if (now - this.budgetWindowStart >= 86400000) {
      this.budgetWindowStart = now;
      this.budgetUsed = 0;
      this.budgetWarned = false;
    }
    this.budgetUsed += bytes;
    if (this.budgetUsed <= this.budget) return;
    const msg = `vera: daily storage write budget exceeded (${(this.budgetUsed / 2 ** 20).toFixed(0)} MiB > ${(this.budget / 2 ** 20).toFixed(0)} MiB)`;
    if (this.onBudget === 'throw') {
      this.broken = new VeraBudgetError(msg);
      throw this.broken;
    }
    if (!this.budgetWarned) {
      this.budgetWarned = true;
      if (this.onEvent) this.onEvent({ type: 'budget', message: msg, used: this.budgetUsed, budget: this.budget });
    }
  }

  // Make page v accessible for the host (JS) side; returns the frame address.
  touch(v, write) {
    const e = this.pt[v];
    if (e && (!write || (e & 2))) return e & ~0xfff;
    return this.fault(v, write ? 1 : 0) & ~0xfff;
  }

  // Write every dirty frame back to storage (pages stay resident, now clean).
  flushAll() {
    for (let f = 0; f < this.P; f++) {
      const v = this.owner[f];
      if (v < 0 || !this.dirty[f]) continue;
      this.writeBack(v, f);
      this.dirty[f] = 0;
      if (this.pt[v]) this.pt[v] = this.entry(f);
    }
    this.backend.flush();
  }

  residentPages() { return Math.min(this.nextUnused, this.P); }
}
