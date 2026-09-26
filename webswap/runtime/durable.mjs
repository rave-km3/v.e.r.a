// durable.mjs - crash-consistent checkpoints for a WebSwap heap.
//
// DurableBackend is a page backend (same read/write interface as the ones in
// backends.mjs) that can also take checkpoints and resume from the last one
// after the process, tab or app was killed.
//
// Shadow paging with two slots per page: after a checkpoint, a page is
// never overwritten in the slot the checkpoint refers to; new versions go to
// the other slot. A checkpoint writes the slot map and the program's low
// memory (globals, allocator state) into the A or B area (alternating), then
// flips a CRC-protected header. If a crash tears any of these writes, resume
// falls back to the previous valid header, whose data was never touched.
//
// File layout (4 KiB units):
//   [0]            header A        [1]  header B
//   [META_A..]     slot map A      [META_B..]  slot map B   (1 byte per page)
//   [LOW_A..]      low memory A    [LOW_B..]   low memory B
//   [PAGES..]      page v, slot s at PAGES + 2v + s
//
// Raw stores (random access by byte offset): MemStore, NodeFileStore,
// OPFSStore. Checkpoint only between calls into the program (no wasm frame
// on the stack); vera.checkpoint() enforces nothing about that - the caller
// does.

import { assertSyncAccessHandle } from './backends.mjs';

const PAGE = 4096;
const MAGIC = 0x4a524556; // 'VERJ'
const HDR_WORDS = 16;

// ---- CRC-32 (IEEE) --------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(u8, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) crc = CRC_TABLE[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// ---- raw stores -------------------------------------------------------------
export class MemStore {
  constructor() { this.kind = 'mem'; this.buf = new Uint8Array(1 << 20); this.len = 0; }
  ensure(n) {
    if (n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  readAt(off, u8) {
    const n = Math.max(0, Math.min(u8.length, this.len - off));
    if (n > 0) u8.set(this.buf.subarray(off, off + n));
    if (n < u8.length) u8.fill(0, Math.max(n, 0));
  }
  writeAt(off, u8) { this.ensure(off + u8.length); this.buf.set(u8, off); this.len = Math.max(this.len, off + u8.length); }
  flush() {}
  close() {}
}

export class NodeFileStore {
  constructor(fs, path, { reset = false } = {}) {
    this.kind = 'file';
    this.fs = fs;
    this.path = path;
    this.fd = fs.openSync(path, reset || !fs.existsSync(path) ? 'w+' : 'r+');
  }
  readAt(off, u8) {
    let got = 0;
    while (got < u8.length) {
      const n = this.fs.readSync(this.fd, u8, got, u8.length - got, off + got);
      if (n === 0) break;
      got += n;
    }
    if (got < u8.length) u8.fill(0, got);
  }
  writeAt(off, u8) {
    let done = 0;
    while (done < u8.length) done += this.fs.writeSync(this.fd, u8, done, u8.length - done, off + done);
  }
  flush() { this.fs.fsyncSync(this.fd); }
  close() { if (this.fd !== null) { this.fs.closeSync(this.fd); this.fd = null; } }
}

export class OPFSStore {
  constructor(handle) { this.kind = 'opfs'; this.h = handle; }
  // Opens (or creates) a persistent heap file; does NOT truncate it.
  static async open(name) {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    try { await assertSyncAccessHandle(h); } catch (e) { h.close(); throw e; }
    return new OPFSStore(h);
  }
  readAt(off, u8) {
    const n = this.h.read(u8, { at: off });
    if (n < u8.length) u8.fill(0, n);
  }
  writeAt(off, u8) { this.h.write(u8, { at: off }); }
  flush() { this.h.flush(); }
  close() { this.h.close(); }
}

// ---- durable page backend ----------------------------------------------------
const pagesFor = (bytes) => Math.ceil(bytes / PAGE);

export class DurableBackend {
  // store: raw store; nvp: virtual pages; lowBytes: size of the saved low
  // memory image (must be the same on resume).
  constructor(store, { nvp, lowBytes }) {
    this.store = store;
    this.kind = `${store.kind}+durable`;
    this.nvp = nvp;
    this.lowBytes = lowBytes;
    this.metaPages = pagesFor(nvp);
    this.lowPages = pagesFor(lowBytes);
    this.META = [2, 2 + this.metaPages];
    this.LOW = [2 + 2 * this.metaPages, 2 + 2 * this.metaPages + this.lowPages];
    this.PAGES = 2 + 2 * this.metaPages + 2 * this.lowPages;
    this.committed = new Uint8Array(nvp); // 0 = none, 1 = slot 0, 2 = slot 1
    this.current = new Uint8Array(nvp);
    this.epoch = 0;
    this.onPhase = null; // test hook: (phase, epoch) => void, e.g. to crash mid-checkpoint
  }

  phase(name) { if (this.onPhase) this.onPhase(name, this.epoch + 1); }

  pageOff(v, slot) { return (this.PAGES + 2 * v + slot) * PAGE; }

  read(vpage, count, u8) {
    for (let i = 0; i < count; i++) {
      const cur = this.current[vpage + i];
      const dst = u8.subarray(i * PAGE, (i + 1) * PAGE);
      if (cur === 0) dst.fill(0);
      else this.store.readAt(this.pageOff(vpage + i, cur - 1), dst);
    }
  }

  write(vpage, u8) {
    let cur = this.current[vpage];
    if (cur === 0 || cur === this.committed[vpage]) cur = this.committed[vpage] === 1 ? 2 : 1;
    this.store.writeAt(this.pageOff(vpage, cur - 1), u8.subarray(0, PAGE));
    this.current[vpage] = cur;
  }

  flush() { this.store.flush(); }
  close() { this.store.close(); }

  // Pages that hold data (so the pager reads instead of zero-filling them).
  writtenPages() {
    const out = [];
    for (let v = 0; v < this.nvp; v++) if (this.current[v]) out.push(v);
    return out;
  }

  // Commit: every dirty page must already be written (pager.flushAll()).
  // low: Uint8Array(lowBytes); extra: small JSON-serialisable object.
  checkpoint(low, extra = {}) {
    if (low.length !== this.lowBytes) throw new Error('vera: low memory image has the wrong size');
    const epoch = this.epoch + 1;
    const s = epoch & 1;
    const meta = this.current.slice();
    const extraBytes = new TextEncoder().encode(JSON.stringify(extra));
    if (extraBytes.length > PAGE - HDR_WORDS * 4) throw new Error('vera: checkpoint extra data too large');
    this.store.writeAt(this.META[s] * PAGE, meta);
    this.phase('meta');
    this.store.writeAt(this.LOW[s] * PAGE, low);
    this.phase('low');
    this.store.flush(); // data before header
    this.phase('flushed');
    const hdr = new Uint8Array(PAGE);
    const w = new Uint32Array(hdr.buffer, 0, HDR_WORDS);
    w[0] = MAGIC; w[1] = 1; w[2] = epoch >>> 0; w[3] = Math.floor(epoch / 2 ** 32);
    w[4] = this.nvp; w[5] = this.lowBytes; w[6] = crc32(meta); w[7] = crc32(low); w[8] = extraBytes.length;
    hdr.set(extraBytes, HDR_WORDS * 4);
    w[15] = crc32(hdr.subarray(0, 60)) ^ crc32(extraBytes);
    // Written in two parts so a test can tear it: the first 32 bytes (magic,
    // epoch, CRCs of meta and low) and then the rest (extra length, header CRC,
    // extra data). A header torn between them fails its CRC.
    this.store.writeAt(s * PAGE, hdr.subarray(0, 32));
    this.phase('half-header');
    this.store.writeAt(s * PAGE + 32, hdr.subarray(32));
    this.store.flush();
    this.phase('committed');
    this.committed.set(meta);
    this.epoch = epoch;
    return { epoch, bytesWritten: meta.length + low.length + PAGE };
  }

  // Load the newest valid checkpoint. Returns null if there is none.
  resume() {
    const cands = [];
    for (const s of [0, 1]) {
      const hdr = new Uint8Array(PAGE);
      this.store.readAt(s * PAGE, hdr);
      const w = new Uint32Array(hdr.buffer, 0, HDR_WORDS);
      if (w[0] !== MAGIC || w[1] !== 1 || w[4] !== this.nvp || w[5] !== this.lowBytes || w[8] > PAGE - HDR_WORDS * 4) continue;
      const extraBytes = hdr.slice(HDR_WORDS * 4, HDR_WORDS * 4 + w[8]);
      if ((crc32(hdr.subarray(0, 60)) ^ crc32(extraBytes)) >>> 0 !== w[15]) continue;
      cands.push({ s, epoch: w[2] + w[3] * 2 ** 32, crcMeta: w[6], crcLow: w[7], extraBytes });
    }
    cands.sort((a, b) => b.epoch - a.epoch);
    for (const c of cands) {
      if ((c.epoch & 1) !== c.s) continue;
      const meta = new Uint8Array(this.nvp);
      this.store.readAt(this.META[c.s] * PAGE, meta);
      if (crc32(meta) !== c.crcMeta) continue;
      const low = new Uint8Array(this.lowBytes);
      this.store.readAt(this.LOW[c.s] * PAGE, low);
      if (crc32(low) !== c.crcLow) continue;
      if (meta.some((x) => x > 2)) continue;
      this.committed.set(meta);
      this.current.set(meta);
      this.epoch = c.epoch;
      return { epoch: c.epoch, low, extra: JSON.parse(new TextDecoder().decode(c.extraBytes) || '{}') };
    }
    return null;
  }
}
