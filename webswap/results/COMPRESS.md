# Compressed page tier

Optional and off by default (`createVera({ compressBytes })`, `node-run --compress`). **Storage in table 1 is SIMULATED**: pages kept in memory plus a fixed busy-wait of 50 µs per read call and 100 µs per page written; no disk, flash or OPFS was involved, and real storage has queues, variance and caches that this does not. Table 2 is the same runs with no storage latency, i.e. what the tier costs in CPU.

**Same page memory** in both configurations: **A** = frame pool of 25% of the heap; **B** = pool of 12.5% plus a compressed tier of 12.5%. The tier's memory is typed arrays allocated up front and at most its budget (entry bookkeeping included), so the *page memory* column is the real total; the pager's other metadata is the same in A and B. Every run returned the ordinary build's checksum. Intel(R) Xeon(R) Processor @ 2.10GHz, 4 vCPU (shared with other work: load average 1.97 / 1.75 / 1.38 at the end), Node v22.22.2, 2026-09-26; fastest of 2 runs per cell; expect a few % of noise.

## 1. SIMULATED slow storage (50 µs per read, 100 µs per write)

| Workload | Heap MiB | Configuration | Page memory MiB | Time ms | B vs A | Storage reads (MiB) | Written MiB | Tier hits | Evicted pages kept in tier | Ratio (in blocks) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| sort | 128 | A pool 25% | 32.00 | 13476 |  | 68863 (754) | 324 | — | — | — |
| sort | 128 | B pool 12.5% + tier 12.5% | 32.00 | 13845 | time **+3%**, reads -1%, written -0% | 68497 (767) | 323 | 131 | 0.1% | 2.78:1 (2.63:1) |
| blur | 128 | A pool 25% | 32.00 | 5034 |  | 17411 (128) | 128 | — | — | — |
| blur | 128 | B pool 12.5% + tier 12.5% | 32.00 | 5095 | time **+1%**, reads -0%, written -0% | 17409 (128) | 128 | 2 | 0.0% | 15.28:1 (10.67:1) |
| rand | 128 | A pool 25% | 32.00 | 27692 |  | 153290 (709) | 714 | — | — | — |
| rand | 128 | B pool 12.5% + tier 12.5% | 32.00 | 22753 | time **-18%**, reads -31%, written -27% | 105328 (504) | 523 | 78579 | 100% | 3.34:1 (3.19:1) |
| hash | 8 | A pool 25% | 2.00 | 32541 |  | 255246 (1001) | 711 | — | — | — |
| hash | 8 | B pool 12.5% + tier 12.5% | 2.00 | 20201 | time **-38%**, reads -43%, written -52% | 146706 (575) | 338 | 167202 | 100% | 3.34:1 (3.14:1) |

## 2. No storage latency (in-memory backend): the tier's CPU cost

| Workload | Heap MiB | Configuration | Page memory MiB | Time ms | B vs A | Storage reads (MiB) | Written MiB | Tier hits | Evicted pages kept in tier | Ratio (in blocks) |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| sort | 128 | A pool 25% | 32.00 | 1294 |  | 68863 (754) | 324 | — | — | — |
| sort | 128 | B pool 12.5% + tier 12.5% | 32.00 | 1583 | time **+22%**, reads -1%, written -0% | 68497 (767) | 323 | 131 | 0.1% | 2.78:1 (2.63:1) |
| blur | 128 | A pool 25% | 32.00 | 717 |  | 17411 (128) | 128 | — | — | — |
| blur | 128 | B pool 12.5% + tier 12.5% | 32.00 | 761 | time **+6%**, reads -0%, written -0% | 17409 (128) | 128 | 2 | 0.0% | 15.28:1 (10.67:1) |
| rand | 128 | A pool 25% | 32.00 | 809 |  | 153290 (709) | 714 | — | — | — |
| rand | 128 | B pool 12.5% + tier 12.5% | 32.00 | 3394 | time **+320%**, reads -31%, written -27% | 105328 (504) | 523 | 78579 | 100% | 3.34:1 (3.19:1) |
| hash | 8 | A pool 25% | 2.00 | 422 |  | 255246 (1001) | 711 | — | — | — |
| hash | 8 | B pool 12.5% + tier 12.5% | 2.00 | 3362 | time **+697%**, reads -43%, written -52% | 146706 (575) | 338 | 167202 | 100% | 3.34:1 (3.14:1) |

## 3. How compressible each app's data is (measured)

Every page configuration A wrote to storage, compressed with no size limit (not timed). *Kept* is the share the tier would keep (at most 5/8 of a page, 1.6:1 or better).

| Workload | Pages written by A | All-equal pages (zeros, fills) | Would be kept (≤ 5/8 page) | Ratio, all pages | Ratio, kept pages | The data |
|---|---:|---:|---:|---:|---:|---|
| sort | 82942 | 0% | 0.2% | 1.03:1 | 2.78:1 | random 32-bit keys (and a scratch copy), reordered by one byte per pass: incompressible until the last pass; sorted, keys this dense (~256 apart) compress ~1.5:1 (measured on synthetic pages), below what the tier asks for |
| blur | 32770 | 0% | 0.0% | 0.94:1 | 15.28:1 | random RGBA pixels and their 3x3 averages: incompressible for a word-based compressor |
| rand | 182698 | 0% | 100% | 3.34:1 | 3.34:1 | a u64 array initialised to a[i] = i, then randomly updated: each page is counters plus a few random words |
| hash | 182060 | 0% | 100% | 4.02:1 | 4.02:1 | an open-addressing table at load 0.5: empty slots are zeros, keys small integers, values one random-looking word each |

## 4. Where it starts to pay off (SIMULATED latencies)

The compressible workloads at several SIMULATED read/write latencies (µs per read call / per page written), plus the two above. Measured 2026-09-26, fastest of 2.

| Workload | Read / write µs | A ms | B ms | B vs A |
|---|---:|---:|---:|---:|
| rand | 0 / 0 | 809 | 3394 | **+320%** |
| rand | 5 / 10 | 3704 | 5608 | **+51%** |
| rand | 10 / 20 | 6496 | 7311 | **+13%** |
| rand | 20 / 40 | 11865 | 11497 | **-3%** |
| rand | 50 / 100 | 27692 | 22753 | **-18%** |
| hash | 0 / 0 | 422 | 3362 | **+697%** |
| hash | 5 / 10 | 3943 | 5350 | **+36%** |
| hash | 10 / 20 | 7106 | 6952 | **-2%** |
| hash | 20 / 40 | 13631 | 10181 | **-25%** |
| hash | 50 / 100 | 32541 | 20201 | **-38%** |

## Reading

- Time of B against A: **sort** +3% on SIMULATED slow storage, +22% with no storage latency; **blur** +1% on SIMULATED slow storage, +6% with no storage latency; **rand** -18% on SIMULATED slow storage, +320% with no storage latency; **hash** -38% on SIMULATED slow storage, +697% with no storage latency.
- The tier only pays off when the data compresses (table 3) **and** storage is slow: a page kept compressed saves a storage read and often a write, but compressing and decompressing it costs several µs of CPU each way in JS, and B has half the frames of A, so more of its faults go to the tier. With no storage latency (table 2) B is slower everywhere.
- Where B catches up with A (table 4, SIMULATED): **rand** about even at 20/40 µs per read/write, clearly ahead (5% or more) from 50/100 µs; **hash** about even at 10/20 µs per read/write, clearly ahead (5% or more) from 20/40 µs. On faster storage, the CPU the tier spends is more than the storage time it saves.
- Real storage is not simulated storage. The browser test measured OPFS reads from a warm cache at ~2 µs per 4 KiB page (`results/browser.json`), and Node's file backend reads from the OS page cache: at those speeds a decompression costs more than the read it saves, so keep the tier off. Where storage really is slow (a cold phone flash, a network-backed store) the SIMULATED numbers are the kind of gain to expect, not a measurement of it.
- Random data (sort, blur) does not compress, so B is a smaller pool plus a failed compression attempt per dirty eviction (~1.5 µs: given up after a quarter of the page; ~10 µs for sorted keys, which look compressible until near the end); a clean page that did not compress is not tried again until it changes.
- Fewer storage writes in B (spills are written only when the tier is full, and a page faulted back in before that is never written) also help flash wear and the write budget, which counts storage writes only.

Columns: *page memory* = pool + the bytes the tier allocated; *storage reads* are backend read calls (readahead batches up to 16 pages into one), with the MiB they returned; *tier hits* are faults served by decompression instead of storage; *evicted pages kept in tier* is the share of pages offered to the tier (dirty evictions, and used clean pages storage already had) that compressed to at most 5/8 of a page; *ratio* is their average compression ratio, and in brackets the ratio in the tier's 128-byte blocks (entry header and rounding included), which is what decides how many pages fit.
