#!/usr/bin/env node
// compress.mjs - does a compressed page tier beat a bigger frame pool with
// the same memory?
//
//   node --expose-gc bench/compress.mjs [--backend delay:50:100] [--apps sort,rand]
//                                       [--reps 2] [--quick] [--out results/compress]
//   node bench/compress.mjs --render-only   (rebuild the .md from the .json)
//   node --expose-gc bench/compress.mjs --sweep 5:10,10:20,20:40
//        (adds A/B at those SIMULATED read:write latencies, rand and hash
//        only, to the existing .json: where the tier starts to pay off)
//
// Writes results/compress.json and results/COMPRESS.md (with --quick:
// results/compress-quick.json, COMPRESS-quick.md). About 4 minutes per rep
// (--quick: 1).
//
// For each app, three measurements:
//  1. SIMULATED slow storage (default: in-memory pages + 50 us per read call
//     and 100 us per page written, as busy-waits): configuration A (pool =
//     25% of the heap, no tier) against B (pool 12.5% + compressed tier
//     12.5%), the same page memory. Wall time, storage reads and writes,
//     tier hits, how many evicted pages the tier kept, and their ratio.
//  2. The same two configurations with no storage latency (in-memory
//     backend): the tier's CPU cost when there is almost nothing to save.
//  3. Compressibility probe: every page configuration A writes to storage,
//     compressed with no limit (not timed). This is the data, not the tier:
//     how many pages would fit in the 5/8 of a page the tier asks for, and
//     the overall ratio.
// Every run's checksum must equal the ordinary build's. Times are the
// minimum over --reps runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce } from '../host/node-run.mjs';
import { MemoryBackend, PAGE } from '../runtime/backends.mjs';
import { compressPage, MAX_COMPRESSED_WORDS, CompressedTier } from '../runtime/compress.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MB = 2 ** 20;
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const SLOW = opt('--backend', 'delay:50:100');
const REPS = +opt('--reps', 2);
const quick = argv.includes('--quick');
const OUT = opt('--out', path.join(ROOT, 'results', quick ? 'compress-quick' : 'compress'));
const renderOnly = argv.includes('--render-only');
const SWEEP = opt('--sweep', null); // 'R:W,R:W,...' in us
const LIMIT_WORDS = new CompressedTier(1 << 20).limitWords; // what the tier keeps (5/8 of a page)

// [app, data MiB (argument), heap MiB actually used, ops]. hash's table
// build does random inserts all over the heap, so on slow storage it is
// measured at a smaller size.
const ALL = quick
  ? [['sort', 16, 32, 0], ['blur', 16, 32, 1], ['rand', 32, 32, 50_000], ['hash', 4, 4, 50_000]]
  : [['sort', 64, 128, 0], ['blur', 64, 128, 1], ['rand', 128, 128, 200_000], ['hash', 8, 8, 100_000]];
const only = opt('--apps', null);
const APPS = only ? ALL.filter(([a]) => only.split(',').includes(a)) : ALL;

// Counts what a run writes to storage and how it compresses (no limit).
class ProbeBackend extends MemoryBackend {
  constructor() {
    super();
    this.kind = 'mem+probe';
    this.out = new Int32Array(MAX_COMPRESSED_WORDS);
    this.probe = { pages: 0, words: 0, same: 0, kept: 0, keptWords: 0 };
  }
  write(v, u8) {
    const n = compressPage(new Int32Array(u8.buffer, u8.byteOffset, PAGE / 4), 0, this.out);
    const p = this.probe;
    p.pages++;
    p.words += n;
    if (n === 2) p.same++;
    if (n <= LIMIT_WORDS) { p.kept++; p.keptWords += n; }
    super.write(v, u8);
  }
}

const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc(); } };
const fmt = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));
const pctOf = (x) => (x === null || x === undefined ? '—' : `${fmt(100 * x, x < 0.1 && x > 0 ? 1 : 0)}%`);
let rows = [], probes = [], sweep = [];
let env;
if (renderOnly || SWEEP) ({ env, rows, probes, sweep = [] } = JSON.parse(fs.readFileSync(`${OUT}.json`, 'utf8')));

async function measure(app, mb, heap, ops, backend, base, into = rows) {
  const configs = [
    ['A pool 25%', { pool: heap * MB / 4, compress: 0 }],
    ['B pool 12.5% + tier 12.5%', { pool: heap * MB / 8, compress: heap * MB / 8 }],
  ];
  for (const [label, cfg] of configs) {
    let best = null;
    for (let i = 0; i < REPS; i++) {
      gc();
      const r = await runOnce({ app, mb, ops, seed: 1, backend, ...cfg });
      r.vera.close();
      delete r.vera;
      if (r.status !== 0) throw new Error(`${app} ${label}: status ${r.status} ${r.error ?? ''}`);
      if (r.value !== base.value) throw new Error(`${app} ${label}: checksum ${r.value} != ${base.value}`);
      if (!best || r.ms < best.ms) best = r;
    }
    const s = best.stats;
    const offered = s.tierStores + s.tierRejects;
    const row = {
      app, heapMiB: heap, label, backend, poolMiB: cfg.pool / MB, tierMiB: cfg.compress / MB,
      pageMemMiB: (cfg.pool + s.tierMemoryBytes) / MB, ms: best.ms,
      readOps: s.readOps, readMiB: s.readBytes / MB, writeOps: s.writeOps, writtenMiB: s.writeBytes / MB,
      tierHits: s.tierHits, tierStores: s.tierStores, tierRejects: s.tierRejects,
      tierSpills: s.tierSpills, tierDrops: s.tierDrops, readaheadUnused: s.readaheadUnused,
      ratio: s.tierOutBytes ? s.tierInBytes / s.tierOutBytes : null,
      blockRatio: s.tierBlockBytes ? s.tierInBytes / s.tierBlockBytes : null,
      accepted: offered ? s.tierStores / offered : null,
      faultTimeMs: s.faultTimeMs, checksum: best.value,
    };
    into.push(row);
    console.log(`${app.padEnd(5)} ${backend.padEnd(13)} ${label.padEnd(26)} ${fmt(row.ms).padStart(7)} ms  reads ${String(row.readOps).padStart(7)} (${fmt(row.readMiB)} MiB)` +
      `  written ${fmt(row.writtenMiB).padStart(5)} MiB` +
      (cfg.compress ? `  tier hits ${row.tierHits}, ${pctOf(row.accepted)} of evicted pages kept, ${fmt(row.ratio, 2)}:1 (${fmt(row.blockRatio, 2)}:1 in blocks)` : ''));
  }
  const [a, b] = into.slice(-2);
  console.log(`${app.padEnd(5)} ${backend.padEnd(13)} B vs A: time ${fmt(100 * (b.ms / a.ms - 1), 0)}%, storage reads ${fmt(100 * (b.readOps / a.readOps - 1), 0)}%, written ${fmt(100 * (b.writtenMiB / a.writtenMiB - 1), 0)}%`);
}

if (SWEEP) {
  sweep = [];
  for (const [app, mb, heap, ops] of APPS.filter(([a]) => only || a === 'rand' || a === 'hash')) {
    const base = await runOnce({ app, mb, ops, seed: 1, baseline: true });
    for (const lat of SWEEP.split(',')) await measure(app, mb, heap, ops, `delay:${lat}`, base, sweep);
  }
  env.sweep = { date: new Date().toISOString(), reps: REPS, loadavg: os.loadavg().map((x) => +x.toFixed(2)) };
  fs.writeFileSync(`${OUT}.json`, JSON.stringify({ env, rows, probes, sweep }, null, 1) + '\n');
}

for (const [app, mb, heap, ops] of renderOnly || SWEEP ? [] : APPS) {
  const base = await runOnce({ app, mb, ops, seed: 1, baseline: true });
  if (base.status !== 0) throw new Error(`${app}: ordinary build failed`);
  await measure(app, mb, heap, ops, SLOW, base);
  await measure(app, mb, heap, ops, 'mem', base);
  const probe = new ProbeBackend();
  const r = await runOnce({ app, mb, ops, seed: 1, backend: probe, pool: heap * MB / 4 });
  r.vera.close();
  if (r.value !== base.value) throw new Error(`${app} probe: checksum ${r.value} != ${base.value}`);
  const p = probe.probe;
  probes.push({ app, heapMiB: heap, pages: p.pages, same: p.same / p.pages, kept: p.kept / p.pages,
    ratio: (p.pages * PAGE) / (p.words * 4), keptRatio: p.kept ? (p.kept * PAGE) / (p.keptWords * 4) : null });
  console.log(`${app.padEnd(5)} probe: ${p.pages} pages written by A; ${pctOf(p.kept / p.pages)} compress to <= 5/8 of a page; all of them together ${fmt((p.pages * PAGE) / (p.words * 4), 2)}:1`);
}

if (!renderOnly && !SWEEP) {
  env = {
    date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
    backend: SLOW, reps: REPS, quick, loadavg: os.loadavg().map((x) => +x.toFixed(2)),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(`${OUT}.json`, JSON.stringify({ env, rows, probes, sweep }, null, 1) + '\n');
}

// ---- COMPRESS.md ---------------------------------------------------------------
const [, rdUs, wrUs] = /^delay:(\d+):(\d+)$/.exec(env.backend) ?? [];
const pct = (b, a) => (a ? `${b >= a ? '+' : ''}${fmt(100 * (b / a - 1))}%` : '—');
const L = [];
L.push(`# Compressed page tier${env.quick ? ' (quick)' : ''}`, '');
L.push('Optional and off by default (`createVera({ compressBytes })`, `node-run --compress`). ' +
  (rdUs ? `**Storage in table 1 is SIMULATED**: pages kept in memory plus a fixed busy-wait of ${rdUs} µs per read call and ${wrUs} µs per page written; no disk, flash or OPFS was involved, and real storage has queues, variance and caches that this does not. ` : `Storage in table 1: \`${env.backend}\`. `) +
  'Table 2 is the same runs with no storage latency, i.e. what the tier costs in CPU.', '');
L.push('**Same page memory** in both configurations: **A** = frame pool of 25% of the heap; **B** = pool of 12.5% plus a compressed tier of 12.5%. ' +
  'The tier\'s memory is typed arrays allocated up front and at most its budget (entry bookkeeping included), so the *page memory* column is the real total; the pager\'s other metadata is the same in A and B. ' +
  `Every run returned the ordinary build's checksum. ${env.cpu}, ${env.cores} vCPU (shared with other work: load average ${env.loadavg?.join(' / ') ?? 'n/a'} at the end), Node ${env.node}, ${env.date.slice(0, 10)}; ` +
  `${env.reps > 1 ? `fastest of ${env.reps} runs per cell` : 'single run per cell'}; expect a few % of noise.`, '');

function table(backendFilter, title) {
  const rs = rows.filter(backendFilter);
  if (!rs.length) return;
  L.push(`## ${title}`, '');
  L.push('| Workload | Heap MiB | Configuration | Page memory MiB | Time ms | B vs A | Storage reads (MiB) | Written MiB | Tier hits | Evicted pages kept in tier | Ratio (in blocks) |');
  L.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i], a = r.tierMiB ? rs[i - 1] : null;
    L.push(`| ${r.app} | ${r.heapMiB} | ${r.label} | ${fmt(r.pageMemMiB, 2)} | ${fmt(r.ms)} | ${a ? `time **${pct(r.ms, a.ms)}**, reads ${pct(r.readOps, a.readOps)}, written ${pct(r.writtenMiB, a.writtenMiB)}` : ''} | ` +
      `${r.readOps} (${fmt(r.readMiB)}) | ${fmt(r.writtenMiB)} | ${r.tierMiB ? r.tierHits : '—'} | ` +
      `${r.tierMiB ? pctOf(r.accepted) : '—'} | ${r.tierMiB && r.ratio ? `${fmt(r.ratio, 2)}:1 (${fmt(r.blockRatio, 2)}:1)` : '—'} |`);
  }
  L.push('');
}
table((r) => r.backend !== 'mem', rdUs ? `1. SIMULATED slow storage (${rdUs} µs per read, ${wrUs} µs per write)` : `1. Storage \`${env.backend}\``);
table((r) => r.backend === 'mem', '2. No storage latency (in-memory backend): the tier\'s CPU cost');

// What the demo apps' heaps hold, i.e. why they do or do not compress.
const DATA = {
  sort: 'random 32-bit keys (and a scratch copy), reordered by one byte per pass: incompressible until the last pass; sorted, keys this dense (~256 apart) compress ~1.5:1 (measured on synthetic pages), below what the tier asks for',
  blur: 'random RGBA pixels and their 3x3 averages: incompressible for a word-based compressor',
  rand: 'a u64 array initialised to a[i] = i, then randomly updated: each page is counters plus a few random words',
  hash: 'an open-addressing table at load 0.5: empty slots are zeros, keys small integers, values one random-looking word each',
  chase: 'a random permutation of indices: pages mix counters and random words',
};
if (probes?.length) {
  L.push('## 3. How compressible each app\'s data is (measured)', '');
  L.push('Every page configuration A wrote to storage, compressed with no size limit (not timed). *Kept* is the share the tier would keep (at most 5/8 of a page, 1.6:1 or better).', '');
  L.push('| Workload | Pages written by A | All-equal pages (zeros, fills) | Would be kept (≤ 5/8 page) | Ratio, all pages | Ratio, kept pages | The data |');
  L.push('|---|---:|---:|---:|---:|---:|---|');
  for (const p of probes) {
    L.push(`| ${p.app} | ${p.pages} | ${pctOf(p.same)} | ${pctOf(p.kept)} | ${fmt(p.ratio, 2)}:1 | ${p.keptRatio ? `${fmt(p.keptRatio, 2)}:1` : '—'} | ${DATA[p.app] ?? ''} |`);
  }
  L.push('');
}
if (sweep?.length) {
  L.push('## 4. Where it starts to pay off (SIMULATED latencies)', '');
  L.push(`The compressible workloads at several SIMULATED read/write latencies (µs per read call / per page written), plus the two above. ${env.sweep ? `Measured ${env.sweep.date.slice(0, 10)}, ${env.sweep.reps > 1 ? `fastest of ${env.sweep.reps}` : 'one run each'}.` : ''}`, '');
  L.push('| Workload | Read / write µs | A ms | B ms | B vs A |');
  L.push('|---|---:|---:|---:|---:|');
  const lat = (b) => (b === 'mem' ? [0, 0] : (/^delay:(\d+):(\d+)$/.exec(b) ?? []).slice(1).map(Number));
  const all = [...rows, ...sweep].filter((r) => sweep.some((x) => x.app === r.app));
  const apps = [...new Set(all.map((r) => r.app))];
  for (const app of apps) {
    const bks = [...new Set(all.filter((r) => r.app === app).map((r) => r.backend))].sort((x, y) => lat(x)[0] - lat(y)[0]);
    for (const b of bks) {
      const A = all.find((r) => r.app === app && r.backend === b && !r.tierMiB), B = all.find((r) => r.app === app && r.backend === b && r.tierMiB);
      if (A && B) L.push(`| ${app} | ${lat(b).join(' / ')} | ${fmt(A.ms)} | ${fmt(B.ms)} | **${pct(B.ms, A.ms)}** |`);
    }
  }
  L.push('');
}
L.push('## Reading', '');
const slow = rows.filter((r) => r.backend !== 'mem'), fast = rows.filter((r) => r.backend === 'mem');
const verdict = [];
for (let i = 1; i < slow.length; i += 2) {
  const a = slow[i - 1], b = slow[i];
  const fa = fast.find((r) => r.app === a.app && !r.tierMiB), fb = fast.find((r) => r.app === a.app && r.tierMiB);
  verdict.push(`**${a.app}** ${pct(b.ms, a.ms)} on SIMULATED slow storage${fa && fb ? `, ${pct(fb.ms, fa.ms)} with no storage latency` : ''}`);
}
L.push(`- Time of B against A: ${verdict.join('; ')}.`);
L.push('- The tier only pays off when the data compresses (table 3) **and** storage is slow: a page kept compressed saves a storage read and often a write, but compressing and decompressing it costs several µs of CPU each way in JS, and B has half the frames of A, so more of its faults go to the tier. With no storage latency (table 2) B is slower everywhere.');
if (sweep?.length) {
  const lat = (b) => (b === 'mem' ? [0, 0] : (/^delay:(\d+):(\d+)$/.exec(b) ?? []).slice(1).map(Number));
  const all = [...rows, ...sweep];
  const parts = [];
  for (const app of [...new Set(sweep.map((r) => r.app))]) {
    const bks = [...new Set(all.filter((r) => r.app === app).map((r) => r.backend))].sort((x, y) => lat(x)[0] - lat(y)[0]);
    const pairs = bks.map((b) => [b, all.find((r) => r.app === app && r.backend === b && !r.tierMiB), all.find((r) => r.app === app && r.backend === b && r.tierMiB)]).filter(([, A, B]) => A && B);
    // Within 5% counts as even: that is about the noise of these runs.
    const even = pairs.filter(([, A, B]) => Math.abs(B.ms / A.ms - 1) < 0.05).map(([b]) => lat(b).join('/'));
    const ahead = pairs.find(([, A, B]) => B.ms < 0.95 * A.ms);
    parts.push(`**${app}** ${even.length ? `about even at ${even.join(' and ')} µs per read/write, ` : ''}` +
      (ahead ? `clearly ahead (5% or more) from ${lat(ahead[0]).join('/')} µs` : 'never clearly ahead in this range'));
  }
  L.push(`- Where B catches up with A (table 4, SIMULATED): ${parts.join('; ')}. On faster storage, the CPU the tier spends is more than the storage time it saves.`);
}
L.push('- Real storage is not simulated storage. The browser test measured OPFS reads from a warm cache at ~2 µs per 4 KiB page (`results/browser.json`), and Node\'s file backend reads from the OS page cache: at those speeds a decompression costs more than the read it saves, so keep the tier off. Where storage really is slow (a cold phone flash, a network-backed store) the SIMULATED numbers are the kind of gain to expect, not a measurement of it.');
L.push('- Random data (sort, blur) does not compress, so B is a smaller pool plus a failed compression attempt per dirty eviction (~1.5 µs: given up after a quarter of the page; ~10 µs for sorted keys, which look compressible until near the end); a clean page that did not compress is not tried again until it changes.');
L.push('- Fewer storage writes in B (spills are written only when the tier is full, and a page faulted back in before that is never written) also help flash wear and the write budget, which counts storage writes only.');
L.push('');
L.push('Columns: *page memory* = pool + the bytes the tier allocated; *storage reads* are backend read calls (readahead batches up to 16 pages into one), with the MiB they returned; *tier hits* are faults served by decompression instead of storage; ' +
  '*evicted pages kept in tier* is the share of pages offered to the tier (dirty evictions, and used clean pages storage already had) that compressed to at most 5/8 of a page; ' +
  '*ratio* is their average compression ratio, and in brackets the ratio in the tier\'s 128-byte blocks (entry header and rounding included), which is what decides how many pages fit.');
const mdPath = path.join(path.dirname(OUT), `${path.basename(OUT).replace(/^compress/, 'COMPRESS')}.md`); // like BENCH.md
fs.writeFileSync(mdPath, L.join('\n') + '\n');
console.log(`wrote ${path.relative(process.cwd(), mdPath)} and ${path.relative(process.cwd(), OUT)}.json`);
