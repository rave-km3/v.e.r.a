// compress.mjs - the compressed page tier (zswap-like) for the WebSwap pager.
//
// Pages evicted from the frame pool are compressed and kept in a fixed JS
// memory budget; a later fault on such a page decompresses it instead of
// reading storage. When the budget is full the oldest pages spill to the
// storage backend (dirty ones are written, clean ones are simply dropped).
// The pager (pager.mjs) owns the policy; this file has the compressor and the
// store.
//
// Compressor: WK-style, word-based (the WKdm family, used for compressed
// memory on macOS/iOS), because heap pages hold numbers and pointers rather
// than text: an array of distinct counters has no repeated byte strings for
// an LZ compressor to find, but its words share their upper bits. Each
// 32-bit word is one of:
//   zero            tag 0
//   exact match     tag 1 + 4-bit index into a 16-entry dictionary of recent words
//   partial match   tag 2 + 4-bit index + low 10 bits (the upper 22 bits match)
//   miss            tag 3 + the full word
// The dictionary slot is chosen by a hash of the word's upper 22 bits, so
// arrays of nearby values (counters, indices, sorted keys, pointers into one
// region) mostly become partial matches. A page whose words are all equal
// (all zeros, or a memset pattern) is stored as that one word.
// Cost in V8 (Node 22) on the test VM, per page: 4-6 us to compress one that
// compresses (counters, a half-empty hash table), 1.5 us to give up on
// random data, 4-5 us to decompress. Pages that mix partial matches and
// misses take about twice as long: sorted random u32 keys ~256 apart
// compress 1.5:1 in 10 us, just too little to be kept, and that is found
// out only near the end of the page.
//
// Format (32-bit words, host byte order; data never leaves this process):
//   [0]            header: kind (bits 0-1), nIdx (bits 2-12), nLow (bits 13-23)
//   SAME:          [1] the word
//   WK:            [1..64]  2-bit tags, 16 per word
//                  then nIdx 4-bit indices, 8 per word
//                  then nLow 10-bit low parts, 3 per word
//                  then the missed words, in order
// Worst case: a page that does not compress grows by 6.4% (1090 words for
// 1024: the header, the tags, a miss for every word but one partial match,
// whose index and low bits take a word each). The tier never keeps such a
// page: it asks compressPage for at most limitWords (5/8 of a page), and the
// compressor gives up as soon as a page cannot fit, usually after a quarter
// of it.

import { PAGE } from './backends.mjs';

const WORDS = PAGE / 4;
const TAG_WORDS = WORDS / 16;
const KIND_SAME = 1, KIND_WK = 2;
// The largest output of compressPage without a limit (see "Worst case").
export const MAX_COMPRESSED_WORDS = 1 + TAG_WORDS + 1 + 1 + (WORDS - 1);

const dictC = new Int32Array(16);
const dictD = new Int32Array(16);
// The index, low-bits and missed-word streams are packed as they are
// produced and copied behind the tags at the end.
const idxW = new Int32Array(WORDS / 8);
const lowW = new Int32Array(Math.ceil(WORDS / 3));
const fullW = new Int32Array(WORDS);

const slotOf = (w) => Math.imul(w >>> 10, 0x9e3779b1) >>> 28;

// Compress the page src[off .. off+1024) (Int32Array or Uint32Array words)
// into out[0..). Returns the compressed length in words, or 0 if it would
// need more than limitWords (the page does not compress well enough).
// Writes at most max(limitWords, 65) words of out.
export function compressPage(src, off, out, limitWords = MAX_COMPRESSED_WORDS) {
  const w0 = src[off];
  let k = 1;
  while (k < WORDS && src[off + k] === w0) k++;
  if (k === WORDS) {
    out[0] = KIND_SAME;
    out[1] = w0;
    return 2;
  }
  dictC.fill(0);
  let nIdx = 0, nLow = 0, nFull = 0;
  let tagAcc = 0, idxAcc = 0, idxN = 0, lowAcc = 0, lowSh = 0;
  // Output words so far, without the fixed header and tags, are checked
  // every 64 words: a page is given up on as soon as it cannot fit, and
  // also when its first quarter (half) projects to more than 1.2 (1.1)
  // times the budget. Heap pages are mostly uniform arrays, so the
  // projection is a good guess, and rejecting a page costs a quarter of
  // compressing it; a page that would just have fitted with a bad first
  // quarter goes to storage instead, as it would without the tier.
  const budget = limitWords - 1 - TAG_WORDS;
  const early1 = (budget * 0.3) | 0, early2 = (budget * 0.55) | 0;
  for (k = 0; k < WORDS; k++) {
    const w = src[off + k] | 0;
    if (w !== 0) {
      const h = slotOf(w);
      const d = dictC[h];
      if (d === w) {
        tagAcc |= 1 << ((k & 15) << 1);
        idxAcc |= h << (nIdx++ << 2);
      } else {
        dictC[h] = w;
        if (((d ^ w) >>> 10) === 0) {
          tagAcc |= 2 << ((k & 15) << 1);
          idxAcc |= h << (nIdx++ << 2);
          lowAcc |= (w & 1023) << lowSh;
          lowSh += 10;
          if (lowSh === 30) { lowW[nLow++] = lowAcc; lowAcc = 0; lowSh = 0; }
        } else {
          tagAcc |= 3 << ((k & 15) << 1);
          fullW[nFull++] = w;
        }
      }
      if (nIdx === 8) { idxW[idxN++] = idxAcc; idxAcc = 0; nIdx = 0; }
    }
    if ((k & 15) === 15) {
      out[1 + (k >> 4)] = tagAcc;
      tagAcc = 0;
      if ((k & 63) === 63) {
        const used = idxN + nLow + nFull;
        if (used > budget || (k === 255 && used > early1) || (k === 511 && used > early2)) return 0;
      }
    }
  }
  if (nIdx) idxW[idxN++] = idxAcc;
  const idxCount = (idxN - (nIdx ? 1 : 0)) * 8 + nIdx;
  const lowCount = nLow * 3 + lowSh / 10;
  if (lowSh) lowW[nLow++] = lowAcc;
  const n = 1 + TAG_WORDS + idxN + nLow + nFull;
  if (n > limitWords) return 0;
  out[0] = KIND_WK | (idxCount << 2) | (lowCount << 13);
  let p = 1 + TAG_WORDS;
  for (let i = 0; i < idxN; i++) out[p++] = idxW[i];
  for (let i = 0; i < nLow; i++) out[p++] = lowW[i];
  for (let i = 0; i < nFull; i++) out[p++] = fullW[i];
  return n;
}

// Inverse of compressPage: inp[inOff ..] -> dst[off .. off+1024).
export function decompressPage(inp, inOff, dst, off) {
  const hdr = inp[inOff];
  const kind = hdr & 3;
  if (kind === KIND_SAME) {
    dst.fill(inp[inOff + 1], off, off + WORDS);
    return;
  }
  if (kind !== KIND_WK) throw new Error('vera: corrupt compressed page');
  const nIdx = (hdr >>> 2) & 2047, nLow = (hdr >>> 13) & 2047;
  dictD.fill(0);
  let ip = inOff + 1 + TAG_WORDS; // next index word
  let lp = ip + ((nIdx + 7) >> 3); // next low-bits word
  let fp = lp + (((nLow + 2) / 3) | 0); // next missed word
  let iw = 0, ib = 8, lw = 0, lb = 3;
  let k = 0;
  for (let t = 1; t <= TAG_WORDS; t++) {
    let tw = inp[inOff + t];
    for (let j = 0; j < 16; j++, k++, tw >>>= 2) {
      const tag = tw & 3;
      if (tag === 0) { dst[off + k] = 0; continue; }
      if (tag === 3) {
        const w = inp[fp++] | 0;
        dictD[slotOf(w)] = w;
        dst[off + k] = w;
        continue;
      }
      if (ib === 8) { iw = inp[ip++]; ib = 0; }
      const h = iw & 15;
      iw >>>= 4;
      ib++;
      if (tag === 1) { dst[off + k] = dictD[h]; continue; }
      if (lb === 3) { lw = inp[lp++]; lb = 0; }
      const w = (dictD[h] & ~1023) | (lw & 1023);
      lw >>>= 10;
      lb++;
      dictD[h] = w;
      dst[off + k] = w;
    }
  }
}

// ---- the store ----------------------------------------------------------------
// Everything the tier holds lives in typed arrays allocated once, when it is
// created, and their sizes add up to at most the budget it was given, so the
// JS memory it uses is known and fixed (a Map would have been simpler, but
// its memory per entry depends on the engine and on how many deletions it
// has seen, and it grows by reallocating):
//   arena   128-byte blocks. A compressed page takes a chain of them; its
//           first block starts with a 4-word header (virtual page, words * 2
//           + clean, older entry, newer entry), so per-entry bookkeeping is
//           paid out of the arena like the data itself.
//   link    per block, the next block of its chain (free blocks form one
//           more chain): no fragmentation to manage.
//   slots   the index from virtual page to first block: open addressing with
//           linear probing, 1.5 slots per block. An entry has at least one
//           block, so the index is at most 2/3 full.
//   out, gather, page   scratch: compressor output, an entry's words made
//           contiguous for the decompressor, a page on its way to storage.
// The codec's own scratch above (dictionaries and streams, 6 KiB) is
// shared by every tier in the process.
//
// Entries form a doubly linked list in the order they came in. A page leaves
// the tier when it is faulted back in (the tier and the frame pool never hold
// the same page) and comes back as the newest when it is evicted again, so
// the oldest entry is the least recently evicted page: the one to spill.
// An entry is named by its first block. clean means storage already holds
// exactly this content (it can be dropped without a write).

const BLOCK_WORDS = 32;
const BLOCK_BYTES = BLOCK_WORDS * 4;
const HEAD = 4; // header words in an entry's first block
const H_PAGE = 0, H_INFO = 1, H_OLDER = 2, H_NEWER = 3;
const SLOTS_PER_BLOCK = 1.5;
const BYTES_PER_BLOCK = BLOCK_BYTES + 4 + 4 * SLOTS_PER_BLOCK; // arena + link + index
export const MIN_COMPRESS_BYTES = 16 << 10;

const blocksFor = (n) => Math.ceil((n + HEAD) / BLOCK_WORDS);
const DEFAULT_LIMIT_RATIO = 0.625;
const limitWordsFor = (limitRatio) => Math.max(2, Math.floor(WORDS * limitRatio));
// Bytes of the scratch arrays (out, gather, page) for this limit.
const scratchBytes = (limitWords) => 4 * (Math.max(limitWords, 1 + TAG_WORDS) + limitWords + WORDS);

export class CompressedTier {
  // The smallest budget a tier with this limitRatio accepts: its scratch
  // arrays and room for at least two pages of the largest size kept, and
  // never below MIN_COMPRESS_BYTES (which is what the default needs).
  static minBytes(limitRatio = DEFAULT_LIMIT_RATIO) {
    const lw = limitWordsFor(limitRatio);
    return Math.max(MIN_COMPRESS_BYTES, Math.ceil((scratchBytes(lw) + 2 * blocksFor(lw) * BYTES_PER_BLOCK) / 1024) * 1024);
  }
  // Throws the RangeError the constructor would, without allocating
  // anything (createVera checks its options with this before it compiles).
  static checkBytes(bytes, limitRatio = DEFAULT_LIMIT_RATIO) {
    const min = CompressedTier.minBytes(limitRatio);
    if (!(Math.floor(bytes) >= min)) throw new RangeError(`vera: compressBytes must be 0 (no compressed tier) or at least ${min >> 10} KiB (got ${bytes})`);
  }

  // bytes: memory budget (at least minBytes(limitRatio)). limitRatio: keep only
  // pages that compress to at most this fraction of a page (zswap likewise
  // refuses pages that do not shrink); it must be below 1, so a kept page is
  // always smaller than the page. A page that barely compresses would
  // displace several that do, and costs as much CPU to compress and
  // decompress (several microseconds each way) as a storage read it might
  // save: with the demo apps on 50 us storage, keeping 1.5:1 pages made the
  // sort slower, not faster.
  constructor(bytes, { limitRatio = DEFAULT_LIMIT_RATIO } = {}) {
    if (!(limitRatio > 0 && limitRatio < 1)) throw new RangeError(`vera: compressed tier limitRatio must be above 0 and below 1 (got ${limitRatio})`);
    CompressedTier.checkBytes(bytes, limitRatio);
    this.budget = Math.floor(bytes);
    this.limitWords = limitWordsFor(limitRatio);
    this.out = new Int32Array(Math.max(this.limitWords, 1 + TAG_WORDS));
    this.gather = new Int32Array(this.limitWords);
    this.page = new Int32Array(WORDS);
    this.pageU8 = new Uint8Array(this.page.buffer); // a view: no memory of its own
    const fixed = this.out.byteLength + this.gather.byteLength + this.page.byteLength; // = scratchBytes(limitWords)
    const nblocks = Math.floor((this.budget - fixed) / BYTES_PER_BLOCK);
    this.nblocks = nblocks;
    this.arena = new Int32Array(nblocks * BLOCK_WORDS);
    this.link = new Int32Array(nblocks);
    for (let b = 0; b < nblocks; b++) this.link[b] = b + 1 < nblocks ? b + 1 : -1;
    this.slots = new Int32Array(Math.floor(nblocks * SLOTS_PER_BLOCK)); // first block + 1; 0 = empty
    this.freeHead = 0;
    this.nfree = nblocks;
    this.count = 0;
    this.oldestE = -1;
    this.newestE = -1;
  }

  // JS memory this tier allocated (every typed array it owns): <= budget.
  memoryBytes() {
    return this.arena.byteLength + this.link.byteLength + this.slots.byteLength
      + this.out.byteLength + this.gather.byteLength + this.page.byteLength;
  }
  get size() { return this.count; }
  // Bytes of blocks in use (compressed words, entry headers, rounding).
  get used() { return (this.nblocks - this.nfree) * BLOCK_BYTES; }
  static blockBytes(n) { return blocksFor(n) * BLOCK_BYTES; }

  // ---- index: virtual page -> entry
  home(v) { return (Math.imul(v, 0x9e3779b1) >>> 0) % this.slots.length; }
  find(v) { // slot index, or -1
    const s = this.slots, S = s.length, A = this.arena;
    for (let i = this.home(v); ; i = i + 1 === S ? 0 : i + 1) {
      const h = s[i];
      if (h === 0) return -1;
      if (A[(h - 1) * BLOCK_WORDS + H_PAGE] === v) return i;
    }
  }
  index(v, e) {
    const s = this.slots, S = s.length;
    let i = this.home(v);
    while (s[i] !== 0) i = i + 1 === S ? 0 : i + 1;
    s[i] = e + 1;
  }
  unindex(i) { // backward-shift deletion keeps every probe run unbroken
    const s = this.slots, S = s.length, A = this.arena;
    for (let j = i; ;) {
      j = j + 1 === S ? 0 : j + 1;
      const h = s[j];
      if (h === 0) break;
      const k = this.home(A[(h - 1) * BLOCK_WORDS + H_PAGE]);
      // The entry at j stays unless its home is outside (i, j] (cyclically).
      if (i <= j ? (i < k && k <= j) : (i < k || k <= j)) continue;
      s[i] = h;
      i = j;
    }
    s[i] = 0;
  }

  // ---- age list
  linkNewest(e) {
    const A = this.arena, b = e * BLOCK_WORDS;
    A[b + H_OLDER] = this.newestE;
    A[b + H_NEWER] = -1;
    if (this.newestE >= 0) A[this.newestE * BLOCK_WORDS + H_NEWER] = e; else this.oldestE = e;
    this.newestE = e;
    this.count++;
  }
  unlink(e) {
    const A = this.arena, b = e * BLOCK_WORDS;
    const o = A[b + H_OLDER], n = A[b + H_NEWER];
    if (o >= 0) A[o * BLOCK_WORDS + H_NEWER] = n; else this.oldestE = n;
    if (n >= 0) A[n * BLOCK_WORDS + H_OLDER] = o; else this.newestE = o;
    this.count--;
  }
  oldest() { return this.oldestE; } // entry, or -1 when empty
  newer(e) { return this.arena[e * BLOCK_WORDS + H_NEWER]; }

  // ---- entries
  has(v) { return this.find(v) >= 0; }
  get(v) { const i = this.find(v); return i < 0 ? -1 : this.slots[i] - 1; }
  pageOf(e) { return this.arena[e * BLOCK_WORDS + H_PAGE]; }
  wordsOf(e) { return this.arena[e * BLOCK_WORDS + H_INFO] >>> 1; }
  isClean(e) { return (this.arena[e * BLOCK_WORDS + H_INFO] & 1) === 1; }
  markClean(e) { this.arena[e * BLOCK_WORDS + H_INFO] |= 1; }

  // Compress a page into this.out; returns its length in words, 0 if it does
  // not compress well enough to be kept.
  compress(src, off) { return compressPage(src, off, this.out, this.limitWords); }

  // Would an n-word page fit now / in an otherwise empty tier?
  fits(n) { return this.nfree >= blocksFor(n); }
  canEverFit(n) { return n <= this.limitWords && this.nblocks >= blocksFor(n); }

  // Store the n words in this.out as page v, the newest entry (the caller
  // made room). Returns the entry.
  store(v, n, clean) {
    const need = blocksFor(n);
    if (!(n > 0 && n <= this.out.length) || this.nfree < need) throw new Error('vera: compressed tier store without room');
    const A = this.arena, out = this.out, link = this.link;
    const e = this.freeHead;
    let b = e, p = 0, k = HEAD;
    for (let i = 1; ; i++) {
      const base = b * BLOCK_WORDS, m = Math.min(BLOCK_WORDS - k, n - p);
      for (let j = 0; j < m; j++) A[base + k + j] = out[p + j];
      p += m;
      if (i === need) break;
      b = link[b];
      k = 0;
    }
    this.freeHead = link[b];
    link[b] = -1;
    this.nfree -= need;
    A[e * BLOCK_WORDS + H_PAGE] = v;
    A[e * BLOCK_WORDS + H_INFO] = n * 2 + (clean ? 1 : 0);
    this.index(v, e);
    this.linkNewest(e);
    return e;
  }

  // Take page v's entry out of the index and the age list but keep its
  // blocks: the fault path holds it while it looks for a frame, so that
  // making room for the page that eviction puts here cannot spill this one.
  // Give it back with restore() (as the newest) or free it with release().
  take(v) {
    const i = this.find(v);
    if (i < 0) return -1;
    const e = this.slots[i] - 1;
    this.unindex(i);
    this.unlink(e);
    return e;
  }
  restore(v, e) { this.index(v, e); this.linkNewest(e); }
  release(e) {
    const link = this.link;
    let last = e, nb = 1;
    while (link[last] >= 0) { last = link[last]; nb++; }
    link[last] = this.freeHead;
    this.freeHead = e;
    this.nfree += nb;
  }
  remove(v) { const e = this.take(v); if (e >= 0) this.release(e); }

  // Decompress entry e into dst[off .. off+1024).
  unpack(e, dst, off) {
    const A = this.arena, g = this.gather, link = this.link;
    const n = this.wordsOf(e);
    let b = e, p = 0, k = HEAD;
    while (p < n) {
      const base = b * BLOCK_WORDS, m = Math.min(BLOCK_WORDS - k, n - p);
      for (let j = 0; j < m; j++) g[p + j] = A[base + k + j];
      p += m;
      b = link[b];
      k = 0;
    }
    decompressPage(g, 0, dst, off);
  }
}
