// vera.mjs - public API of v.e.r.a WebSwap.
//
//   import { createVera } from './runtime/vera.mjs';
//   const vera = await createVera({ wasm: bytes, poolBytes: 64 << 20, backend });
//   vera.exports.run(...);            // the program sees ~3.75 GiB of heap
//   console.log(vera.meter('tr'));    // honest summary of what paging cost
//
// Works in Node/Bun/Deno and in browsers (use OPFSSyncBackend in a Worker).

import { Pager, VeraBudgetError } from './pager.mjs';
import { MemoryBackend, PAGE } from './backends.mjs';
import { meter } from './meter.mjs';
import { DurableBackend } from './durable.mjs';
import { CompressedTier } from './compress.mjs';

export { VeraBudgetError };

export class VeraTrapError extends Error {
  constructor(msg) { super(msg); this.name = 'VeraTrapError'; }
}

const WASM_PAGE = 65536;
const MAX_PAGES = 65535; // 4 GiB - 64 KiB: a full 4 GiB Memory overflows u32 sizes
const alignUp = (x, a) => Math.ceil(x / a) * a;

export function readLayout(module) {
  const sec = WebAssembly.Module.customSections(module, 'vera.layout');
  if (!sec.length) throw new Error('vera: module has no vera.layout section (build it with tools/vera-build.mjs)');
  const layout = JSON.parse(new TextDecoder().decode(sec[0]));
  if (layout.format !== 'vera-webswap/1' || layout.vbase % WASM_PAGE !== 0 || layout.vbase <= 0
    || layout.nvp * PAGE !== 2 ** 32 - layout.vbase || layout.heapBase >= layout.vbase) {
    throw new Error('vera: invalid vera.layout section');
  }
  return layout;
}

// Largest WebAssembly.Memory this engine lets us *reserve*, searching
// downwards from `want` with a bisection (64 KiB granularity). This is an
// upper bound, not usable RAM: engines commit memory lazily, so a phone may
// still kill the tab well before this size is actually touched.
export function probeMaxMemoryBytes(want) {
  const ok = (pages) => {
    try { new WebAssembly.Memory({ initial: pages, maximum: pages }); return true; } catch { return false; }
  };
  let hi = Math.min(MAX_PAGES, Math.ceil(want / WASM_PAGE));
  if (ok(hi)) return hi * WASM_PAGE;
  let lo = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (ok(mid)) lo = mid; else hi = mid;
  }
  return lo * WASM_PAGE;
}

// Smallest step of performance.now() in microseconds. Browsers often coarsen
// it to 100 us (or more) unless the page is cross-origin isolated; then
// per-fault latency numbers are meaningless and the meter says so.
export function timerResolutionUs() {
  let min = Infinity, last = performance.now(), steps = 0;
  for (let i = 0; i < 200000 && steps < 20; i++) {
    const t = performance.now();
    if (t > last) { min = Math.min(min, t - last); last = t; steps++; }
  }
  return min === Infinity ? Infinity : min * 1000;
}

// Options beyond the basics:
//   writeBudgetBytes: storage write budget over a 24 h window (default 1 GiB).
//   budgetStore:  {load(), save(state)} (backends.mjs: FileBudgetStore,
//                 OPFSBudgetStore) to keep that window across runs, so it
//                 really is a daily budget; without it the window is per run.
//   onBudget:     'warn' (onEvent, or console.warn; delivered after the
//                 fault returns) or 'throw' (the program aborts).
//   durableStore: a raw store from durable.mjs (MemStore, NodeFileStore,
//                 OPFSStore). Pages then go through a DurableBackend, and
//                 vera.checkpoint(extra) commits a crash-consistent snapshot.
//   resume:       with durableStore, continue from the newest valid
//                 checkpoint if there is one (vera.resumed tells which).
//   compressBytes: size of a compressed page tier in JS memory, between the
//                 pool and storage (default 0 = none; otherwise at least
//                 16 KiB; see compress.mjs). Evicted pages that compress well
//                 stay there and fault back in without storage I/O. The tier
//                 allocates exactly this much (less a few bytes) up front and
//                 never more. It pays off only when storage is slow (the codec
//                 costs several us per page, more than a read from the OS file
//                 cache) and the heap's pages compress; for random data it
//                 costs a little CPU (such pages bypass it). With durableStore
//                 it is as volatile as the frame pool: checkpoint() writes its
//                 dirty pages before committing, and pages it spills between
//                 checkpoints go to the uncommitted slots like any other.
export async function createVera({
  wasm, poolBytes = 64 << 20, backend = new MemoryBackend(), imports = {},
  readahead = 16, writeBudgetBytes, writeBudgetBytesPerDay, budgetStore = null,
  onBudget = 'warn', onEvent = null,
  curveMultipliers = [2, 4], durableStore = null, resume = false, compressBytes = 0,
}) {
  const budgetBytes = writeBudgetBytes ?? writeBudgetBytesPerDay ?? 2 ** 30;
  // Sizes are refused before anything is compiled, instantiated or resumed
  // (the caller's backend is untouched then). Only 'auto' and the pool's
  // upper bound need the module's layout.
  if (typeof compressBytes !== 'number' || !Number.isFinite(compressBytes) || compressBytes < 0) {
    throw new TypeError(`vera: compressBytes must be a number of bytes, 0 for no compressed tier (got ${String(compressBytes)})`);
  }
  if (compressBytes > 0) CompressedTier.checkBytes(compressBytes);
  const roundPool = (bytes) => {
    const b = Math.floor(bytes / WASM_PAGE) * WASM_PAGE;
    if (b < 16 * PAGE) throw new Error('vera: pool too small (need at least 64 KiB)');
    return b;
  };
  if (poolBytes !== 'auto') poolBytes = roundPool(poolBytes);
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const layout = readLayout(module);
  const framesAddr = alignUp(Math.max(layout.heapBase, layout.minPages * WASM_PAGE), WASM_PAGE);
  const maxPool = layout.vbase - framesAddr;

  if (poolBytes === 'auto') {
    // Half of the largest Memory this device lets us reserve, capped at 128 MiB.
    const got = probeMaxMemoryBytes(Math.min(maxPool, 256 << 20) + framesAddr);
    poolBytes = roundPool(Math.min(128 << 20, Math.floor((got - framesAddr) / 2)));
  }
  if (poolBytes > maxPool) throw new Error(`vera: pool too large for this build (max ${maxPool >> 20} MiB below VBASE)`);

  const pages = (framesAddr + poolBytes) / WASM_PAGE;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });

  let pager = null;
  const veraImports = {
    fault: (v, write) => pager.fault(v, write),
    trap: (code, addr) => {
      const a = `0x${(addr >>> 0).toString(16)}`;
      throw new VeraTrapError(
        code === 1 ? `vera: aligned access at ${a} crosses a page boundary (a misaligned pointer used with an aligned load/store)`
          : code === 2 ? `vera: stack overflow (stack pointer would become ${a}); build with a larger --stack-size or use less recursion`
            : `vera: trap ${code} at ${a}`);
    },
  };
  const instance = await WebAssembly.instantiate(module, {
    ...imports,
    env: { ...(imports.env || {}), memory },
    vera: veraImports,
  });
  const ex = instance.exports;
  if (ex.__vera_info(0) >>> 0 !== layout.vbase || ex.__vera_info(2) >>> 0 !== layout.nvp) {
    throw new Error('vera: layout section does not match the module');
  }
  const ptAddr = ex.__vera_info(1) >>> 0;
  const ptEnd = ptAddr + layout.nvp * 4;
  // Low memory saved in checkpoints: everything below the heap base except
  // the page table (which must be empty on resume anyway).
  const lowBytes = layout.heapBase - (ptEnd - ptAddr);
  let resumed = null;
  if (durableStore) {
    if (ptEnd > layout.heapBase) throw new Error('vera: unexpected page table placement');
    backend = new DurableBackend(durableStore, { nvp: layout.nvp, lowBytes });
    if (resume) {
      const st = backend.resume();
      if (st) {
        const mem = new Uint8Array(memory.buffer);
        mem.set(st.low.subarray(0, ptAddr), 0);
        mem.set(st.low.subarray(ptAddr), ptEnd);
        resumed = { epoch: st.epoch, extra: st.extra };
      }
    }
  }
  const budgetState = budgetStore ? await budgetStore.load() : null;
  pager = new Pager({
    memory, ptAddr, nvp: layout.nvp, framesAddr,
    poolFrames: poolBytes / PAGE, backend, readahead, writeBudgetBytes: budgetBytes, onBudget, onEvent,
    budgetState, saveBudget: budgetStore ? (s) => budgetStore.save(s) : null, curveMultipliers,
    compressBytes,
  });
  if (resumed) for (const v of backend.writtenPages()) { pager.written[v] = 1; pager.seen[v] = 1; }

  const u8 = () => new Uint8Array(memory.buffer);
  const vbase = layout.vbase;

  // Copy bytes out of / into the program's address space (virtual or not).
  function access(vaddr, len, cb, write) {
    vaddr >>>= 0;
    if (vaddr + len > 2 ** 32) throw new RangeError('vera: access beyond the 4 GiB address space');
    let done = 0;
    while (done < len) {
      const a = vaddr + done;
      if (a < vbase) {
        const n = Math.min(len - done, vbase - a);
        if (a + n > memory.buffer.byteLength) throw new RangeError(`vera: address 0x${a.toString(16)} is outside the program's memory`);
        cb(a, done, n);
        done += n;
      } else {
        const off = (a - vbase) % PAGE;
        const n = Math.min(len - done, PAGE - off);
        const frame = pager.touch(Math.floor((a - vbase) / PAGE), write);
        cb(frame + off, done, n);
        done += n;
      }
    }
  }

  const vera = {
    instance, exports: ex, memory, pager, layout,
    poolBytes, framesAddr, backend: backend.kind,
    read(vaddr, len) {
      const out = new Uint8Array(len);
      access(vaddr, len, (phys, at, n) => out.set(u8().subarray(phys, phys + n), at), false);
      return out;
    },
    write(vaddr, bytes) {
      access(vaddr, bytes.length, (phys, at, n) => u8().set(bytes.subarray(at, at + n), phys), true);
    },
    readCString(vaddr, max = 1 << 20) {
      const parts = [];
      for (let i = 0; i < max; i += 256) {
        const chunk = vera.read(vaddr + i, Math.min(256, 2 ** 32 - (vaddr >>> 0) - i));
        const z = chunk.indexOf(0);
        parts.push(z >= 0 ? chunk.subarray(0, z) : chunk);
        if (z >= 0 || chunk.length < 256) break;
      }
      const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      return new TextDecoder().decode(all);
    },
    timerResolutionUs: timerResolutionUs(),
    stats() {
      return {
        backend: backend.kind, poolBytes, poolFrames: pager.P, memoryBytes: memory.buffer.byteLength,
        timerResolutionUs: vera.timerResolutionUs,
        residentPages: pager.residentPages(), ...pager.stats, budgetUsedBytes: pager.budgetUsed,
        writeBudgetBytes: budgetBytes, budgetScope: pager.budgetScope,
        compressBytes: pager.tier ? pager.tier.budget : 0,
        tierMemoryBytes: pager.tier ? pager.tier.memoryBytes() : 0, // allocated, <= compressBytes
        tierPages: pager.tier ? pager.tier.size : 0, tierUsedBytes: pager.tier ? pager.tier.used : 0,
      };
    },
    faultCurve() { return pager.curve.report(); },
    meter(lang = 'tr', extra = {}) { return meter(vera.stats(), vera.faultCurve(), lang, extra); },
    flush() { pager.flushAll(); },
    resumed,
    // Crash-consistent snapshot (needs durableStore). Call it only between
    // calls into the program, never from inside an import it calls.
    checkpoint(extra = {}) {
      if (!durableStore) throw new Error('vera: checkpoint() needs createVera({ durableStore })');
      pager.flushAll();
      const mem = u8();
      const low = new Uint8Array(lowBytes);
      low.set(mem.subarray(0, ptAddr), 0);
      low.set(mem.subarray(ptEnd, layout.heapBase), ptAddr);
      return backend.checkpoint(low, extra);
    },
    // Releases the backend (the default swap files are deleted). It writes
    // no pages: what changed since the last flush() or checkpoint(), in the
    // frame pool or in the compressed tier alike, is discarded, so with a
    // backend that outlives it (keep: true) call flush() first.
    close() {
      pager.persistBudget();
      backend.close();
    },
  };
  return vera;
}

// Minimum pages of the module's imported memory, read from the binary.
function readLeb(u8, pos) {
  let result = 0, shift = 0, byte;
  do { byte = u8[pos++]; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return [result, pos];
}
export function memoryImportMinPages(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pos = 8;
  while (pos < u8.length) {
    const id = u8[pos++];
    let size;
    [size, pos] = readLeb(u8, pos);
    const end = pos + size;
    if (id === 2) { // import section
      let n, len;
      [n, pos] = readLeb(u8, pos);
      for (let i = 0; i < n; i++) {
        [len, pos] = readLeb(u8, pos); pos += len; // module name
        [len, pos] = readLeb(u8, pos); pos += len; // field name
        const kind = u8[pos++];
        if (kind === 0) [, pos] = readLeb(u8, pos); // function: type index
        else if (kind === 1) { pos++; const fl = u8[pos++]; [, pos] = readLeb(u8, pos); if (fl & 1) [, pos] = readLeb(u8, pos); }
        else if (kind === 2) { pos++; return readLeb(u8, pos)[0]; } // memory: flags, min
        else if (kind === 3) pos += 2; // global: type, mutability
        else return null;
      }
      return null;
    }
    pos = end;
  }
  return null;
}

// Instantiate a baseline build (ordinary heap growing with memory.grow).
// maxBytes caps how far the heap may grow, to emulate a device/tab limit.
export async function instantiateBase(wasm, { maxBytes = MAX_PAGES * WASM_PAGE, imports = {} } = {}) {
  const bytes = wasm instanceof WebAssembly.Module ? null : wasm;
  const module = bytes ? await WebAssembly.compile(bytes) : wasm;
  const maximum = Math.min(MAX_PAGES, Math.floor(maxBytes / WASM_PAGE));
  const minPages = bytes ? memoryImportMinPages(bytes) : null;
  if (minPages !== null && minPages > maximum) {
    throw new RangeError(`vera: the program needs ${minPages * 64} KiB of memory to start, above the ${maximum * 64} KiB cap`);
  }
  // Start at 16 MiB (or the module's minimum, within the cap); malloc grows it.
  let initial = Math.min(maximum, Math.max(256, minPages ?? 0));
  for (;;) {
    const memory = new WebAssembly.Memory({ initial, maximum });
    try {
      const instance = await WebAssembly.instantiate(module, { ...imports, env: { ...(imports.env || {}), memory } });
      return { instance, exports: instance.exports, memory };
    } catch (e) {
      // Only a too-small memory is worth retrying (when we could not read the minimum).
      if (!(e instanceof WebAssembly.LinkError) || !/memory/i.test(e.message) || initial >= maximum) throw e;
      initial = Math.min(maximum, initial * 2);
    }
  }
}
