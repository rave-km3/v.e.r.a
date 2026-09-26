// backends.mjs - synchronous page stores for the WebSwap pager.
//
// Interface (all synchronous, because a page fault happens in the middle of a
// wasm load/store and cannot await):
//   read(vpage, count, u8)  fill u8 (count * 4096 bytes) with pages vpage..;
//                           pages never written read as zeros
//   write(vpage, u8)        store one 4096-byte page
//   flush()                 make writes durable where that means something
//   close()
//   kind                    short label used in stats
//
// OPFSSyncBackend only works in a dedicated Worker (FileSystemSyncAccessHandle
// is Worker-only). NodeFileBackend works in Node, Bun and Deno.

export const PAGE = 4096;

export class MemoryBackend {
  constructor() {
    this.kind = 'mem';
    this.pages = new Map();
  }
  read(vpage, count, u8) {
    for (let i = 0; i < count; i++) {
      const p = this.pages.get(vpage + i);
      if (p) u8.set(p, i * PAGE);
      else u8.fill(0, i * PAGE, (i + 1) * PAGE);
    }
  }
  write(vpage, u8) {
    let p = this.pages.get(vpage);
    if (!p) { p = new Uint8Array(PAGE); this.pages.set(vpage, p); }
    p.set(u8);
  }
  flush() {}
  close() { this.pages.clear(); }
}

export class NodeFileBackend {
  // fs: node:fs module (passed in so this file also loads in browsers).
  // The file is private to this backend: it is created with mode 0600, an
  // existing file is refused unless overwrite:true (so two runs can never
  // share one swap file by accident), and it is deleted on close unless
  // keep:true. The contents are the program's heap, unencrypted.
  constructor(fs, path, { keep = false, overwrite = false } = {}) {
    this.kind = 'file';
    this.fs = fs;
    this.path = path;
    this.keep = keep;
    this.fd = fs.openSync(path, overwrite ? 'w+' : 'wx+', 0o600);
  }
  read(vpage, count, u8) {
    const want = count * PAGE;
    let got = 0;
    while (got < want) {
      const n = this.fs.readSync(this.fd, u8, got, want - got, vpage * PAGE + got);
      if (n === 0) break; // past end of file: never written
      got += n;
    }
    if (got < want) u8.fill(0, got, want);
  }
  write(vpage, u8) {
    let done = 0;
    while (done < PAGE) done += this.fs.writeSync(this.fd, u8, done, PAGE - done, vpage * PAGE + done);
  }
  flush() { this.fs.fsyncSync(this.fd); }
  close() {
    if (this.fd === null) return;
    this.fs.closeSync(this.fd);
    this.fd = null;
    if (!this.keep) this.fs.rmSync(this.path, { force: true });
  }
}

// Chromium 102-107 had asynchronous flush/close/truncate on sync access
// handles; ordering would silently break there, so refuse to run.
export async function assertSyncAccessHandle(h) {
  const r = h.flush();
  if (r && typeof r.then === 'function') {
    await r;
    throw new Error('vera: this browser has asynchronous OPFS access-handle methods (e.g. Chromium < 108); not supported');
  }
}

// Swap files made by OPFSSyncBackend.open() are named vera-swap-*.bin, so a
// sweep can find the ones a killed tab left behind.
export const OPFS_SWAP_PREFIX = 'vera-swap-';

export class OPFSSyncBackend {
  // handle: FileSystemSyncAccessHandle (from createSyncAccessHandle())
  constructor(handle, { dir = null, name = null, keep = false } = {}) {
    this.kind = 'opfs';
    this.h = handle;
    this.dir = dir;
    this.name = name;
    this.keep = keep;
  }
  static async open(name = `${OPFS_SWAP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.bin`, { keep = false } = {}) {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    try {
      await assertSyncAccessHandle(h);
      h.truncate(0);
    } catch (e) {
      h.close();
      throw e;
    }
    return new OPFSSyncBackend(h, { dir, name, keep });
  }
  // Delete swap files left behind by tabs or workers that were killed. A
  // file whose access handle we can take is not in use by anyone.
  static async sweep() {
    const dir = await navigator.storage.getDirectory();
    let removed = 0;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.startsWith(OPFS_SWAP_PREFIX)) continue;
      try {
        const h = await handle.createSyncAccessHandle();
        h.close();
        await dir.removeEntry(name);
        removed++;
      } catch { /* in use by a live worker */ }
    }
    return removed;
  }
  read(vpage, count, u8) {
    const want = count * PAGE;
    const n = this.h.read(u8.subarray(0, want), { at: vpage * PAGE });
    if (n < want) u8.fill(0, n, want);
  }
  write(vpage, u8) {
    this.h.write(u8.subarray(0, PAGE), { at: vpage * PAGE });
  }
  flush() { this.h.flush(); }
  // Closes the handle and (unless keep) deletes the file in the background.
  close() {
    if (!this.h) return;
    this.h.close();
    this.h = null;
    if (!this.keep && this.dir) this.removal = this.dir.removeEntry(this.name).catch(() => {});
  }
  async closeAsync() {
    this.close();
    await this.removal;
  }
}

// Adds a fixed latency to every backend call. Used to simulate slower storage
// (e.g. phone flash). Results that use it must be labelled SIMULATED.
export class DelayBackend {
  constructor(inner, { readUs = 100, writeUs = 200 } = {}) {
    this.inner = inner;
    this.kind = `${inner.kind}+delay(${readUs}/${writeUs}us, SIMULATED)`;
    this.readUs = readUs;
    this.writeUs = writeUs;
  }
  static spin(us) {
    const end = performance.now() + us / 1000;
    while (performance.now() < end) { /* busy wait: sub-ms sleeps are not available synchronously */ }
  }
  read(vpage, count, u8) { DelayBackend.spin(this.readUs); this.inner.read(vpage, count, u8); }
  write(vpage, u8) { DelayBackend.spin(this.writeUs); this.inner.write(vpage, u8); }
  flush() { this.inner.flush(); }
  close() { this.inner.close(); }
}

// ---- write-budget stores ----------------------------------------------------
// Keep the pager's write budget across runs, so it really is per 24 hours.
// load() returns {windowStart, used} or null; save(state) persists it.

export class FileBudgetStore {
  constructor(fs, path) { this.fs = fs; this.path = path; }
  load() {
    try { return JSON.parse(this.fs.readFileSync(this.path, 'utf8')); } catch { return null; }
  }
  save(state) { this.fs.writeFileSync(this.path, JSON.stringify(state), { mode: 0o600 }); }
}

// Browser (works in Workers): a small JSON file in OPFS. save() cannot block
// (the pager calls it from inside a page fault), so writes happen in the
// background, one at a time, always writing the newest state: parallel
// writes could finish out of order and leave an older total on disk.
// Await idle() before reading the file or closing the worker.
export class OPFSBudgetStore {
  constructor(name = 'vera-budget.json') { this.name = name; this.pending = null; this.writing = null; }
  async load() {
    await this.idle();
    try {
      const dir = await navigator.storage.getDirectory();
      const f = await (await dir.getFileHandle(this.name)).getFile();
      return JSON.parse(await f.text());
    } catch { return null; }
  }
  save(state) {
    this.pending = state;
    if (!this.writing) this.writing = this.drain();
  }
  async drain() {
    try {
      while (this.pending) {
        const state = this.pending;
        this.pending = null;
        try {
          const dir = await navigator.storage.getDirectory();
          const w = await (await dir.getFileHandle(this.name, { create: true })).createWritable();
          await w.write(JSON.stringify(state));
          await w.close();
        } catch { /* best effort: the next save tries again */ }
      }
    } finally {
      this.writing = null;
    }
  }
  idle() { return this.writing ?? Promise.resolve(); }
}
