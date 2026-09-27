#!/usr/bin/env node
// run-all.mjs - WebSwap benchmark matrix. Writes results/bench.json and
// results/BENCH.md. Every cell is published, including the bad ones.
//
//   node bench/run-all.mjs            (about 5-10 minutes)
//   node bench/run-all.mjs --quick    (smaller sizes, for a smoke test)
//
// Configurations per workload:
//   RAM        ordinary build, uncapped Memory (reference speed)
//   RAM-cap    ordinary build with Memory capped at half the heap (expected to fail)
//   V100       WebSwap, pool larger than the data (translation overhead only)
//   V25 / V6   WebSwap, pool = 25% / 6.25% of the data
// Backends: mem (pages kept in JS memory: pure paging-policy cost), file (a
// real file; the OS page cache may serve reads), delay (mem + fixed latency,
// SIMULATED slower storage).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runOnce } from '../host/node-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const renderOnly = process.argv.includes('--render-only'); // rebuild BENCH.md from results/bench.json
const MB = 2 ** 20;

// [app, data MiB (argument), heap MiB actually used, ops]
const WORKLOADS = quick
  ? [['sort', 16, 32, 0], ['blur', 16, 32, 1], ['hash', 32, 32, 200_000], ['rand', 32, 32, 100_000], ['chase', 32, 32, 50_000]]
  : [['sort', 64, 128, 0], ['blur', 64, 128, 1], ['hash', 128, 128, 1_000_000], ['rand', 128, 128, 200_000], ['chase', 128, 128, 200_000]];
const DELAY = 'delay:50:100';

const results = [];
function record(r, label, heapMiB, baseMs, baseValue) {
  const { vera, ...rest } = r;
  const row = {
    label, heapMiB, ...rest,
    slowdown: baseMs && r.status === 0 ? r.ms / baseMs : null,
    correct: r.status === 0 && baseValue !== undefined ? r.value === baseValue : null,
  };
  if (vera) vera.close();
  results.push(row);
  const s = r.stats;
  console.log(`${r.app.padEnd(6)} ${label.padEnd(20)} ${r.status === 0 ? `${r.ms.toFixed(0).padStart(7)} ms` : '  FAILED  '}` +
    `${row.slowdown ? ` ${row.slowdown.toFixed(1).padStart(6)}x` : ''}` +
    `${s ? `  major ${s.majorRead + s.zeroFill}  read ${(s.readBytes / MB).toFixed(0)} MiB  written ${(s.writeBytes / MB).toFixed(0)} MiB` : ''}` +
    `${row.correct === false ? '  CHECKSUM MISMATCH' : ''}`);
  return row;
}

let env;
if (renderOnly) {
  const saved = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', quick ? 'bench-quick.json' : 'bench.json'), 'utf8'));
  env = saved.env;
  results.push(...saved.results);
} else {
  for (const [app, mb, heap, ops] of WORKLOADS) {
    const base = await runOnce({ app, mb, ops, seed: 1, baseline: true });
    record(base, 'RAM', heap);
    const cap = Math.max(16, heap / 2);
    record(await runOnce({ app, mb, ops, seed: 1, baseline: true, cap: cap * MB }), `RAM-cap ${cap} MiB`, heap, base.ms, base.value);
    const v100 = Math.min(240, heap + 32) * MB;
    record(await runOnce({ app, mb, ops, seed: 1, pool: v100, backend: 'mem' }), 'V100 mem', heap, base.ms, base.value);
    for (const [frac, name] of [[0.25, 'V25'], [0.0625, 'V6']]) {
      const pool = Math.max(1, Math.round(heap * frac)) * MB;
      for (const backend of ['mem', 'file']) {
        record(await runOnce({ app, mb, ops, seed: 1, pool, backend }), `${name} ${backend}`, heap, base.ms, base.value);
      }
    }
    // Measured with simulated latency only for the streaming workloads; the
    // random ones would take many minutes. For every mem row the report also
    // gives a projection (mem time + reads x 50 us + writes x 100 us), and the
    // measured delay rows show how close that projection is.
    if (app === 'sort' || app === 'blur') {
      record(await runOnce({ app, mb, ops, seed: 1, pool: Math.round(heap * 0.25) * MB, backend: DELAY }), 'V25 delay SIMULATED', heap, base.ms, base.value);
    }
  }

  // Headline: a heap far bigger than the real Memory.
  const hl = quick ? { mb: 128, pool: 32 } : { mb: 1024, pool: 64 };
  console.log(`\nheadline: sort ${hl.mb} MiB of keys (${hl.mb * 2} MiB heap) with a ${hl.pool} MiB pool`);
  const hbase = await runOnce({ app: 'sort', mb: hl.mb, seed: 2, baseline: true });
  record(hbase, 'HEADLINE RAM', hl.mb * 2);
  record(await runOnce({ app: 'sort', mb: hl.mb, seed: 2, baseline: true, cap: 256 * MB }), 'HEADLINE RAM-cap 256 MiB', hl.mb * 2, hbase.ms, hbase.value);
  record(await runOnce({ app: 'sort', mb: hl.mb, seed: 2, pool: hl.pool * MB, backend: 'file' }), `HEADLINE V file ${hl.pool} MiB`, hl.mb * 2, hbase.ms, hbase.value);

  env = {
    date: new Date().toISOString(),
    node: process.version,
    cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    kernel: os.release(),
    disk: (() => { try { return execSync(`df -T ${os.tmpdir()} | tail -1`).toString().trim().replace(/\s+/g, ' '); } catch { return '?'; } })(),
    note: 'Cloud VM (Firecracker/KVM) with a virtio disk; file-backend reads may be served by the OS page cache. Numbers are indicative.',
    quick,
  };
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', quick ? 'bench-quick.json' : 'bench.json'), JSON.stringify({ env, results }, null, 1));

}

// Markdown report
const fmt = (x, d = 0) => (x === null || x === undefined ? '—' : x.toFixed(d));
const lines = [];
lines.push(`# WebSwap benchmark${quick ? ' (quick)' : ''}`, '');
lines.push('**Every WebSwap configuration is slower than RAM. The value is finishing instead of crashing.**', '');
lines.push(`Environment: ${env.cpu}, ${env.cores} vCPU, ${env.ramGiB} GiB RAM, Linux ${env.kernel}, Node ${env.node}. ${env.note}`, '');
const [, RD_US, WR_US] = DELAY.split(':').map(Number);
const projected = (r) => (r.stats && r.stats.backend === 'mem' && r.status === 0
  ? r.ms + (r.stats.readOps * RD_US + r.stats.writeOps * WR_US) / 1000 : null);
const baseMsOf = Object.fromEntries(results.filter((r) => r.label === 'RAM' || r.label === 'HEADLINE RAM').map((r) => [r.app + (r.label.startsWith('HEADLINE') ? '!' : ''), r.ms]));
lines.push('| Workload | Configuration | Heap MiB | Real Memory MiB | Time ms | vs RAM | Projected on slower storage | Storage reads | Read MiB | Written MiB | Result |');
lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
for (const r of results) {
  const s = r.stats;
  const result = r.status === 0 ? (r.correct === false ? 'WRONG CHECKSUM' : r.correct ? 'ok, same checksum' : 'ok') : (r.error ? `failed: ${r.error}` : 'failed: out of memory');
  const pj = projected(r);
  const bms = baseMsOf[r.app + (r.label.startsWith('HEADLINE') ? '!' : '')];
  const pjCell = pj === null ? '—' : `${fmt(pj)} ms (${fmt(pj / bms, 0)}x)`;
  lines.push(`| ${r.app} | ${r.label} | ${r.heapMiB} | ${r.status === 0 ? fmt(r.memoryBytes / MB) : '—'} | ${r.status === 0 ? fmt(r.ms) : '—'} | ${r.slowdown ? fmt(r.slowdown, 1) + 'x' : r.label.includes('RAM') && !r.label.includes('cap') ? '1x' : '—'} | ${pjCell} | ${s ? s.majorRead : '—'} | ${s ? fmt(s.readBytes / MB) : '—'} | ${s ? fmt(s.writeBytes / MB) : '—'} | ${result} |`);
}
lines.push('', 'Notes:', '- `mem`: pages kept in JS memory; measures the paging policy and translation cost only.',
  '- `file`: a real file; the OS page cache may serve reads, so a cold disk would be slower.',
  `- \`delay\`: \`mem\` plus a fixed ${DELAY.split(':')[1]} µs per read and ${DELAY.split(':')[2]} µs per write (SIMULATED slower storage).`,
  `- "Projected on slower storage" (mem rows only) = measured time + storage reads x ${RD_US} µs + writes x ${WR_US} µs. It is an estimate; compare it with the measured \`delay\` rows of the same workload to see how close it is.`,
  '- Single run per cell (not a median); expect run-to-run noise of 10-30% on a shared VM.');
fs.writeFileSync(path.join(ROOT, 'results', quick ? 'BENCH-quick.md' : 'BENCH.md'), lines.join('\n') + '\n');
console.log(`\nwrote results/${quick ? 'BENCH-quick.md' : 'BENCH.md'}`);
