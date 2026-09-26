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
  // fs: node:fs module (passed in so this file also loads in browsers)
  constructor(fs, path, { keep = false } = {}) {
    this.kind = 'file';
    this.fs = fs;
    this.path = path;
    this.keep = keep;
    this.fd = fs.openSync(path, 'w+');
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

export class OPFSSyncBackend {
  // handle: FileSystemSyncAccessHandle (from createSyncAccessHandle())
  constructor(handle, { dir = null, name = null, keep = false } = {}) {
    this.kind = 'opfs';
    this.h = handle;
    this.dir = dir;
    this.name = name;
    this.keep = keep;
  }
  static async open(name = 'vera-heap.bin', { keep = false } = {}) {
    const dir = await navigator.storage.getDirectory();
    const fh = await dir.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(0);
    return new OPFSSyncBackend(h, { dir, name, keep });
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
  async closeAsync() {
    this.h.close();
    if (!this.keep && this.dir) await this.dir.removeEntry(this.name).catch(() => {});
  }
  close() { this.h.close(); }
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
