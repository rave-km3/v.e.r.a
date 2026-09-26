#!/usr/bin/env node
// overhead.mjs - how much slower is the paged build than the ordinary one?
//
//   node --expose-gc bench/overhead.mjs [--reps 7] [--json out.json] [--no-paged]
//
// For each app, runs the ordinary build (RAM) and the paged build, alternating
// and repeated, and reports the fastest time of each:
//   fit    pool = the whole heap: nothing is evicted, so this is the cost of
//          address translation alone
//   paged  pool = 25% of the heap, in-memory backend: translation plus the
//          pager (only for the apps where this takes seconds, not minutes)
// Every run's checksum must equal the ordinary build's. Times are the minimum
// over the repetitions (the least disturbed run; the ordinary build's time
// varies a lot with how fast the OS hands out fresh memory), with a garbage
// collection before each run when --expose-gc is given.
import fs from 'node:fs';
import { runOnce } from '../host/node-run.mjs';

const MB = 2 ** 20;
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const REPS = +opt('--reps', 7);
const JSON_OUT = opt('--json', null);
const PAGED = !argv.includes('--no-paged');

// [app, data MiB (argument), heap MiB, ops, measure the paged config too]
const APPS = [
  ['sort', 64, 128, 0, true],
  ['blur', 64, 128, 1, true],
  ['hash', 128, 128, 1_000_000, false],
  ['rand', 128, 128, 200_000, true],
  ['chase', 128, 128, 200_000, false],
];

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const min = (xs) => Math.min(...xs);
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc(); } };
if (!globalThis.gc) console.log('(run with node --expose-gc for steadier numbers)');
const out = { reps: REPS, node: process.version, apps: [] };

for (const [app, mb, heap, ops, paged] of APPS) {
  const t = { base: [], fit: [], paged: [] };
  let expected = null;
  const check = (r, what) => {
    if (r.status !== 0) throw new Error(`${app} ${what}: status ${r.status} ${r.error ?? ''}`);
    if (expected === null) expected = r.value;
    else if (r.value !== expected) throw new Error(`${app} ${what}: checksum ${r.value} != ${expected}`);
  };
  for (let i = 0; i < REPS; i++) {
    gc();
    const b = await runOnce({ app, mb, ops, seed: 1, baseline: true });
    check(b, 'baseline'); t.base.push(b.ms);
    gc();
    const f = await runOnce({ app, mb, ops, seed: 1, pool: (heap + 4) * MB, backend: 'mem' });
    check(f, 'fit'); t.fit.push(f.ms); f.vera.close();
    if (PAGED && paged) {
      gc();
      const p = await runOnce({ app, mb, ops, seed: 1, pool: (heap / 4) * MB, backend: 'mem' });
      check(p, 'paged'); t.paged.push(p.ms); p.vera.close();
    }
  }
  const row = {
    app, baseMs: min(t.base), fitMs: min(t.fit), pagedMs: t.paged.length ? min(t.paged) : null,
    fitMedianMs: median(t.fit), checksum: expected, times: t,
  };
  row.fit = row.fitMs / row.baseMs;
  row.paged = row.pagedMs ? row.pagedMs / row.baseMs : null;
  out.apps.push(row);
  console.log(`${app.padEnd(6)} RAM ${row.baseMs.toFixed(0).padStart(6)} ms   fit ${row.fitMs.toFixed(0).padStart(6)} ms ${row.fit.toFixed(2)}x` +
    (row.paged ? `   paged(25%) ${row.pagedMs.toFixed(0).padStart(6)} ms ${row.paged.toFixed(2)}x` : ''));
}

const geo = (xs) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);
out.fitGeomean = geo(out.apps.map((r) => r.fit));
const pagedRows = out.apps.filter((r) => r.paged);
out.pagedGeomean = pagedRows.length ? geo(pagedRows.map((r) => r.paged)) : null;
console.log(`geomean  fit ${out.fitGeomean.toFixed(3)}x` + (out.pagedGeomean ? `   paged ${out.pagedGeomean.toFixed(3)}x` : ''));
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1) + '\n');
