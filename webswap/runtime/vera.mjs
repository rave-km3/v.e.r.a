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

export { VeraBudgetError };

export class VeraTrapError extends Error {
  constructor(msg) { super(msg); this.name = 'VeraTrapError'; }
}

const WASM_PAGE = 65536;
const alignUp = (x, a) => Math.ceil(x / a) * a;

export function readLayout(module) {
  const sec = WebAssembly.Module.customSections(module, 'vera.layout');
  if (!sec.length) throw new Error('vera: module has no vera.layout section (build it with tools/vera-build.mjs)');
  return JSON.parse(new TextDecoder().decode(sec[0]));
}

// Largest Memory we can actually get, trying from `want` downwards.
export function probeMaxMemoryBytes(want) {
  for (let bytes = alignUp(want, WASM_PAGE); bytes >= 16 * WASM_PAGE; bytes = alignUp(Math.floor(bytes / 2), WASM_PAGE)) {
    try {
      const pages = bytes / WASM_PAGE;
      new WebAssembly.Memory({ initial: pages, maximum: pages });
      return bytes;
    } catch { /* RangeError: try smaller */ }
  }
  return 0;
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
//   durableStore: a raw store from durable.mjs (MemStore, NodeFileStore,
//                 OPFSStore). Pages then go through a DurableBackend, and
//                 vera.checkpoint(extra) commits a crash-consistent snapshot.
//   resume:       with durableStore, continue from the newest valid
//                 checkpoint if there is one (vera.resumed tells which).
export async function createVera({
  wasm, poolBytes = 64 << 20, backend = new MemoryBackend(), imports = {},
  readahead = 16, writeBudgetBytesPerDay = 2 ** 30, onBudget = 'warn', onEvent = null,
  curveMultipliers = [2, 4], durableStore = null, resume = false,
}) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const layout = readLayout(module);
  const framesAddr = alignUp(Math.max(layout.heapBase, layout.minPages * WASM_PAGE), WASM_PAGE);
  const maxPool = layout.vbase - framesAddr;

  if (poolBytes === 'auto') {
    // Half of the largest Memory this device lets us allocate, capped at 128 MiB.
    const got = probeMaxMemoryBytes(Math.min(maxPool, 256 << 20) + framesAddr);
    poolBytes = Math.min(128 << 20, Math.floor((got - framesAddr) / 2));
  }
  poolBytes = Math.floor(poolBytes / WASM_PAGE) * WASM_PAGE;
  if (poolBytes < 16 * PAGE) throw new Error('vera: pool too small (need at least 64 KiB)');
  if (poolBytes > maxPool) throw new Error(`vera: pool too large for this build (max ${maxPool >> 20} MiB below VBASE)`);

  const pages = (framesAddr + poolBytes) / WASM_PAGE;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });

  let pager = null;
  const veraImports = {
    fault: (v, write) => pager.fault(v, write),
    trap: (code, addr) => {
      throw new VeraTrapError(code === 1
        ? `vera: aligned access at 0x${(addr >>> 0).toString(16)} crosses a page boundary (a misaligned pointer used with an aligned load/store)`
        : `vera: trap ${code} at 0x${(addr >>> 0).toString(16)}`);
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
  pager = new Pager({
    memory, ptAddr, nvp: layout.nvp, framesAddr,
    poolFrames: poolBytes / PAGE, backend, readahead, writeBudgetBytesPerDay, onBudget, onEvent,
    curveMultipliers,
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
        const chunk = vera.read(vaddr + i, 256);
        const z = chunk.indexOf(0);
        parts.push(z >= 0 ? chunk.subarray(0, z) : chunk);
        if (z >= 0) break;
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
        writeBudgetBytesPerDay,
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
    close() { backend.close(); },
  };
  return vera;
}

// Instantiate a baseline build (ordinary heap growing with memory.grow).
// maxBytes caps how far the heap may grow, to emulate a device/tab limit.
export async function instantiateBase(wasm, { maxBytes = 4 * 2 ** 30 - WASM_PAGE, imports = {} } = {}) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const maximum = Math.floor(maxBytes / WASM_PAGE);
  // The import's minimum is small; start at 16 MiB (or the cap) and let malloc grow it.
  let memory;
  for (let initial = Math.min(256, maximum); ; initial = Math.ceil(initial * 2)) {
    try {
      memory = new WebAssembly.Memory({ initial, maximum });
      const instance = await WebAssembly.instantiate(module, { ...imports, env: { ...(imports.env || {}), memory } });
      return { instance, exports: instance.exports, memory };
    } catch (e) {
      if (!(e instanceof WebAssembly.LinkError) || initial >= maximum) throw e;
    }
  }
}
