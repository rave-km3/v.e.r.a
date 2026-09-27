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
// touching storage, and a never-written page whose frame is still all zeros
// is dropped instead of written.
// Readahead: on a sequential run of major faults, read up to `readahead`
// following pages in one backend call. Prefetched pages stay unmapped until
// first use, so their first touch is a minor fault that records the use.
// Compressed tier (optional, compressBytes > 0; see compress.mjs): evicted
// pages that compress well are kept compressed in JS memory instead of going
// to storage, and a fault finds them there first. The tier and the frame
// pool never hold the same page: a page leaves the tier when it is faulted
// in. A tier entry is clean when storage holds the same content (it is
// dropped when the tier is full) and dirty otherwise (it is written to
// storage when the tier is full, and on flush). A page faulted in from a
// dirty entry starts dirty, since storage does not have it. Clean pages that
// were used are kept too, so a refault costs a decompression instead of a
// storage read; a prefetched page that was never used is dropped as without
// the tier. Pages that do not compress (random data, already-compressed
// media) go straight to storage as without the tier. Readahead stops at a
// page in the tier (its storage copy may be stale). The tier only adds to
// the pager's memory what compressBytes allows; "does not compress" is one
// bit in seen[].
// Write budget: bytes written to storage are counted against a budget over a
// 24-hour window. Without a budget store the window lives only as long as
// this pager (one run); with one (see backends.mjs) it really is per day.
// 'warn' reports once (onEvent, or console.warn), 'throw' aborts the program.
// Events are delivered after the fault returns, never inside it, and a fault
// can never re-enter the pager.

import { PAGE } from './backends.mjs';
import { CompressedTier } from './compress.mjs';

export class VeraBudgetError extends Error {
  constructor(msg) { super(msg); this.name = 'VeraBudgetError'; }
}

const HIST_BUCKETS = 24; // log2 microseconds: <1us, <2us, ..., >= 2^22 us
// seen[v] bits
const SEEN = 1; // faulted in at least once (the fault curve's first touch)
const INCOMPRESSIBLE = 2; // did not compress when last put away, unchanged since

function isZeroPage(u8) {
  const w = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2);
  for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false;
  return true;
}

// Predicts how many storage reads a bigger pool would have needed.
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
  // Only faults that read storage are counted (a zero-fill costs no I/O in
  // any pool size); every fault updates the ghost list. inTier: pages the
  // compressed tier holds now. They are the newest ghosts (the tier keeps
  // recent evictions), so behind a bigger pool the same tier would still
  // cover that many more: the page would have stayed iff d < E + inTier.
  onMajor(v, firstTouch, fromStorage, inTier = 0) {
    const te = this.lastEvict[v];
    const d = te ? this.sum(this.t) - this.sum(te) : -1;
    this.forget(v);
    if (!fromStorage) return;
    if (firstTouch || d < 0) { this.compulsory++; return; }
    this.refaults++;
    for (let i = 0; i < this.extras.length; i++) if (d - inTier >= this.extras[i]) this.beyond[i]++;
  }
  report() {
    return {
      measuredStorageReads: this.compulsory + this.refaults,
      compulsory: this.compulsory,
      predicted: this.multipliers.map((k, i) => ({
        poolMultiplier: k,
        poolFrames: Math.round(k * this.poolFrames),
        storageReads: this.compulsory + this.beyond[i],
      })),
      note: 'approximate: exact for LRU, the pager runs CLOCK; readahead batches count as one read'
        + (this.tiered ? '; a compressed tier is assumed to keep holding as many pages as it did' : ''),
    };
  }
}

export class Pager {
  constructor({
    memory, ptAddr, nvp, framesAddr, poolFrames, backend,
    readahead = 16, writeBudgetBytes = 2 ** 30, onBudget = 'warn', onEvent = null,
    budgetState = null, saveBudget = null, curveMultipliers = [2, 4], compressBytes = 0,
  }) {
    if (poolFrames < 4) throw new Error('vera: pool must have at least 4 frames');
    this.u8 = new Uint8Array(memory.buffer); // the Memory never grows
    this.i32 = new Int32Array(memory.buffer);
    this.tier = compressBytes > 0 ? new CompressedTier(compressBytes) : null;
    this.pt = new Uint32Array(memory.buffer, ptAddr, nvp);
    this.nvp = nvp;
    this.framesAddr = framesAddr;
    this.P = poolFrames;
    this.backend = backend;
    this.owner = new Int32Array(poolFrames).fill(-1);
    this.dirty = new Uint8Array(poolFrames);
    this.ref = new Uint8Array(poolFrames);
    this.pinned = new Uint8Array(poolFrames);
    this.prefetched = new Uint8Array(poolFrames); // read ahead, not used yet
    this.resident = new Int32Array(nvp).fill(-1);
    this.written = new Uint8Array(nvp); // storage holds a copy of this page
    this.seen = new Uint8Array(nvp); // SEEN | INCOMPRESSIBLE
    this.nextUnused = 0;
    this.hand = 0;
    this.lastMajor = -2;
    this.raMax = Math.max(1, Math.min(readahead | 0, Math.floor(poolFrames / 4)));
    this.tmp = new Uint8Array(this.raMax * PAGE);
    this.budget = writeBudgetBytes;
    this.onBudget = onBudget;
    this.onEvent = onEvent;
    this.saveBudget = saveBudget; // (state) => void, for a persistent window
    this.budgetScope = saveBudget ? 'day' : 'run';
    const now = Date.now();
    const fresh = !budgetState || !(now - budgetState.windowStart < 86400000);
    this.budgetWindowStart = fresh ? now : budgetState.windowStart;
    this.budgetUsed = fresh ? 0 : budgetState.used;
    this.budgetSaved = this.budgetUsed;
    this.budgetWarned = false;
    this.broken = null;
    this.inFault = false;
    this.pending = [];
    this.curve = new FaultCurve(nvp, poolFrames, curveMultipliers);
    this.curve.tiered = !!this.tier;
    this.stats = {
      majorRead: 0, zeroFill: 0, minor: 0, readaheadPages: 0,
      readOps: 0, readBytes: 0, writeOps: 0, writeBytes: 0,
      evictClean: 0, evictDirty: 0, refCleared: 0, zeroElided: 0,
      readaheadUnused: 0, // prefetched pages evicted before their first use
      // Compressed tier: faults served from it; pages put in, their bytes
      // before compression, after it, and in the tier's blocks (entry header
      // and rounding included); pages that bypassed it (did not compress to
      // the limit, or did not last time and are unchanged); entries written
      // to storage (spilled when full, or flushed); clean entries dropped
      // when full. None of these count as storage writes: writeOps and
      // writeBytes (and the write budget) are storage only.
      tierHits: 0, tierStores: 0, tierInBytes: 0, tierOutBytes: 0, tierBlockBytes: 0, tierRejects: 0,
      tierSpills: 0, tierFlushes: 0, tierDrops: 0,
      faultTimeMs: 0, hist: new Array(HIST_BUCKETS).fill(0),
    };
  }

  frameAddr(f) { return this.framesAddr + f * PAGE; }
  entry(f) { return (this.frameAddr(f) | 1 | (this.dirty[f] ? 2 : 0)) >>> 0; }
  frameView(f) { const a = this.frameAddr(f); return this.u8.subarray(a, a + PAGE); }

  // Called from wasm (import vera.fault). Returns the page table entry.
  fault(v, write) {
    if (this.broken) throw this.broken;
    if (this.inFault) throw new Error('vera: re-entrant page fault (host code touched paged memory while a fault was being handled)');
    if (v >= this.nvp) throw new RangeError(`vera: virtual page ${v} is outside the address space`);
    this.inFault = true;
    try {
      const f = this.resident[v];
      if (f >= 0) { // minor: still in a frame, just unmapped or read-only
        this.stats.minor++;
        this.ref[f] = 1;
        this.prefetched[f] = 0;
        if (write) this.dirty[f] = 1;
        const e = this.entry(f);
        this.pt[v] = e;
        return e;
      }
      return this.major(v, write);
    } finally {
      this.inFault = false;
    }
  }

  // Deliver events after the current fault (and wasm call) has returned.
  emit(ev) {
    this.pending.push(ev);
    if (this.pending.length > 1) return;
    queueMicrotask(() => {
      for (const e of this.pending.splice(0)) {
        if (this.onEvent) this.onEvent(e);
        else console.warn(e.message);
      }
    });
  }

  major(v, write) {
    const t0 = performance.now();
    if (this.tier && this.tier.has(v)) return this.tierFault(v, write, t0);
    let count = 1;
    const fromStorage = this.written[v] === 1;
    // Account the fault before allocating a frame: the eviction this fault
    // causes would not happen in a bigger pool.
    this.curve.onMajor(v, !(this.seen[v] & SEEN), fromStorage, this.tier ? this.tier.size : 0);
    this.seen[v] |= SEEN;
    if (fromStorage) {
      if (v === this.lastMajor + 1) {
        // Readahead stops at a page in the compressed tier: its storage copy
        // may be stale, and the tier serves it without I/O anyway.
        while (count < this.raMax && v + count < this.nvp && this.written[v + count] && this.resident[v + count] < 0
          && !(this.tier && this.tier.has(v + count))) count++;
      }
      this.backend.read(v, count, this.tmp);
      this.stats.readOps++;
      this.stats.readBytes += count * PAGE;
      this.stats.majorRead++;
      this.stats.readaheadPages += count - 1;
      const frames = [];
      try {
        for (let i = 0; i < count; i++) {
          const fr = this.allocFrame();
          frames.push(fr);
          this.u8.set(this.tmp.subarray(i * PAGE, (i + 1) * PAGE), this.frameAddr(fr));
          if (i === 0) this.map(v, fr, write, true);
          else { this.map(v + i, fr, false, false); this.seen[v + i] |= SEEN; this.curve.forget(v + i); }
        }
      } finally {
        for (const fr of frames) this.pinned[fr] = 0; // also after a storage error
      }
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

  // Page v is in the compressed tier: decompress it into a frame, no I/O.
  tierFault(v, write, t0) {
    const tier = this.tier;
    this.curve.onMajor(v, !(this.seen[v] & SEEN), false);
    this.seen[v] |= SEEN;
    // Held outside the tier's index while a frame is found, so the eviction
    // that frees one cannot spill this very page to make room.
    const e = tier.take(v);
    let fr;
    try {
      fr = this.allocFrame();
    } catch (err) {
      tier.restore(v, e);
      throw err;
    }
    const clean = tier.isClean(e);
    tier.unpack(e, this.i32, this.frameAddr(fr) >> 2);
    tier.release(e);
    this.map(v, fr, write || !clean, true);
    this.pinned[fr] = 0;
    this.stats.tierHits++;
    this.lastMajor = v; // a sequential run may continue into storage
    this.stats.faultTimeMs += performance.now() - t0;
    return this.pt[v];
  }

  // mapped=true: the faulting page (present in the page table, referenced).
  // mapped=false: a prefetched page (resident, unmapped until first use).
  map(v, f, write, mapped) {
    this.owner[f] = v;
    this.resident[v] = f;
    this.dirty[f] = write ? 1 : 0;
    this.ref[f] = mapped ? 1 : 0;
    this.prefetched[f] = mapped ? 0 : 1;
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

  // Put the page away first (tier or storage): if storage fails, the frame
  // is still owned and dirty, so the state stays consistent.
  evict(f) {
    const v = this.owner[f];
    const dirty = this.dirty[f] === 1;
    const unused = this.prefetched[f] === 1; // read ahead, never touched (so clean)
    // Into the tier: dirty pages, and clean pages storage has that were used
    // (a clean page storage never had is all zeros: nothing to keep; one
    // that was prefetched and never used is dropped as without the tier, not
    // compressed in as the newest entry ahead of pages that were used).
    if (this.tier && (dirty || (this.written[v] && !unused))) this.putAway(v, f, dirty);
    else if (dirty) this.writeBack(v, this.frameView(f));
    if (dirty) this.stats.evictDirty++;
    else this.stats.evictClean++;
    if (unused) this.stats.readaheadUnused++;
    this.pt[v] = 0;
    this.resident[v] = -1;
    this.owner[f] = -1;
    this.dirty[f] = 0;
    this.ref[f] = 0;
    this.prefetched[f] = 0;
    this.curve.onEvict(v);
  }

  // Keep page v (frame f) in the compressed tier if it compresses well
  // enough, spilling the oldest entries to make room. Otherwise a dirty page
  // goes to storage and a clean one is dropped (storage has it).
  putAway(v, f, dirty) {
    const page = this.frameView(f);
    if (dirty && !this.written[v] && isZeroPage(page)) { // still reads as zeros
      this.stats.zeroElided++;
      return;
    }
    const tier = this.tier;
    // A clean page has not changed since it was last put away; if it did
    // not compress then, it will not now (streaming over random data would
    // otherwise pay for a failed compression on every pass). A page changes
    // only while it is dirty: a dirty eviction compresses it again, and
    // flushAll(), which makes a changed page clean, clears the bit.
    const n = !dirty && (this.seen[v] & INCOMPRESSIBLE) ? 0 : tier.compress(this.i32, this.frameAddr(f) >> 2);
    if (n) this.seen[v] &= ~INCOMPRESSIBLE;
    else this.seen[v] |= INCOMPRESSIBLE;
    if (n && tier.canEverFit(n)) {
      while (!tier.fits(n) && tier.size > 0) this.spill(tier.oldest());
      // (Only the entry a tier fault holds can still be in the way.)
      if (tier.fits(n)) {
        tier.store(v, n, !dirty);
        this.stats.tierStores++;
        this.stats.tierInBytes += PAGE;
        this.stats.tierOutBytes += n * 4;
        this.stats.tierBlockBytes += CompressedTier.blockBytes(n);
        return;
      }
    }
    this.stats.tierRejects++;
    if (dirty) this.writeBack(v, page);
  }

  // Remove tier entry e (the oldest): written to storage if storage does not
  // have it, else just dropped. Written before it is removed, so a storage
  // error leaves it in place.
  spill(e) {
    const tier = this.tier, u = tier.pageOf(e);
    if (tier.isClean(e)) {
      this.stats.tierDrops++;
    } else {
      tier.unpack(e, tier.page, 0);
      this.writeBack(u, tier.pageU8);
      this.stats.tierSpills++;
    }
    tier.remove(u);
  }

  writeBack(v, page) {
    if (!this.written[v] && isZeroPage(page)) { // still reads as zeros: nothing to store
      this.stats.zeroElided++;
      return;
    }
    this.backend.write(v, page);
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
      this.budgetSaved = 0;
      this.budgetWarned = false;
    }
    this.budgetUsed += bytes;
    if (this.saveBudget && this.budgetUsed - this.budgetSaved >= 16 * 2 ** 20) this.persistBudget();
    if (this.budgetUsed <= this.budget) return;
    const scope = this.budgetScope === 'day' ? 'daily' : "this run's";
    const msg = `vera: ${scope} storage write budget exceeded (${(this.budgetUsed / 2 ** 20).toFixed(0)} MiB > ${(this.budget / 2 ** 20).toFixed(0)} MiB)`;
    if (this.onBudget === 'throw') {
      this.persistBudget();
      this.broken = new VeraBudgetError(msg);
      throw this.broken;
    }
    if (!this.budgetWarned) {
      this.budgetWarned = true;
      this.emit({ type: 'budget', message: msg, used: this.budgetUsed, budget: this.budget });
    }
  }

  persistBudget() {
    if (!this.saveBudget) return;
    this.budgetSaved = this.budgetUsed;
    try { this.saveBudget({ windowStart: this.budgetWindowStart, used: this.budgetUsed }); } catch { /* best effort */ }
  }

  // Make page v accessible for the host (JS) side; returns the frame address.
  touch(v, write) {
    const e = this.pt[v];
    if (e && (!write || (e & 2))) return e & ~0xfff;
    return this.fault(v, write ? 1 : 0) & ~0xfff;
  }

  // Write every dirty frame and dirty tier entry back to storage (pages stay
  // where they are, now clean).
  flushAll() {
    if (this.broken) throw this.broken;
    if (this.inFault) throw new Error('vera: flush during a page fault');
    for (let f = 0; f < this.P; f++) {
      const v = this.owner[f];
      if (v < 0 || !this.dirty[f]) continue;
      this.writeBack(v, this.frameView(f));
      this.dirty[f] = 0;
      this.seen[v] &= ~INCOMPRESSIBLE; // clean now, but changed since it was last put away
      if (this.pt[v]) this.pt[v] = this.entry(f);
    }
    const tier = this.tier;
    if (tier) {
      for (let e = tier.oldest(); e >= 0; e = tier.newer(e)) {
        if (tier.isClean(e)) continue;
        tier.unpack(e, tier.page, 0);
        this.writeBack(tier.pageOf(e), tier.pageU8);
        tier.markClean(e); // in place: the age order is kept
        this.stats.tierFlushes++;
      }
    }
    this.backend.flush();
    this.persistBudget();
  }

  residentPages() { return Math.min(this.nextUnused, this.P); }
}
