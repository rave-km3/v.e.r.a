#!/usr/bin/env node
// node-run.mjs - run a WebSwap demo app from the command line.
//
//   node host/node-run.mjs --app sort --mb 256 --pool 32M --backend file
//   node host/node-run.mjs --app sort --mb 256 --baseline --cap 128M
//
// Options:
//   --app NAME        fuzz | sort | blur | hash | rand | chase | packed
//   --mb N            data size in MiB (the app decides how it uses it)
//   --ops N           operation count for random apps (0 = app default)
//   --seed N
//   --pool SIZE       page pool (real memory for pages), e.g. 16M, 64M, auto
//   --backend KIND    mem | file | delay:READ_US:WRITE_US (SIMULATED latency on mem)
//   --baseline        run the ordinary (non-paged) build instead
//   --cap SIZE        baseline only: maximum Memory, to emulate a device limit
//   --lang tr|en      meter language
//   --json            machine-readable output
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../tools/vera-build.mjs';
import { createVera, instantiateBase } from '../runtime/vera.mjs';
import { MemoryBackend, NodeFileBackend, DelayBackend } from '../runtime/backends.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseSize(s) {
  if (s === 'auto') return 'auto';
  const m = /^(\d+(?:\.\d+)?)([KMG]?)i?B?$/i.exec(String(s));
  if (!m) throw new Error(`bad size: ${s}`);
  return Math.round(Number(m[1]) * { '': 1, K: 1024, M: 2 ** 20, G: 2 ** 30 }[m[2].toUpperCase()]);
}

export function makeBackend(spec) {
  if (spec === 'mem') return new MemoryBackend();
  if (spec === 'file') return new NodeFileBackend(fs, path.join(os.tmpdir(), `vera-heap-${process.pid}-${Date.now()}.bin`));
  const d = /^delay:(\d+):(\d+)$/.exec(spec);
  if (d) return new DelayBackend(new MemoryBackend(), { readUs: +d[1], writeUs: +d[2] });
  throw new Error(`unknown backend: ${spec}`);
}

export function appWasm(app) {
  const out = path.join(ROOT, 'build', app);
  if (!fs.existsSync(`${out}.vera.wasm`) || !fs.existsSync(`${out}.base.wasm`)) {
    buildApp([path.join(ROOT, 'apps', `${app}.c`)], out);
  }
  return { vera: fs.readFileSync(`${out}.vera.wasm`), base: fs.readFileSync(`${out}.base.wasm`) };
}

// One run; returns a plain result object.
export async function runOnce({ app, mb, ops = 0, seed = 1, pool = 64 << 20, backend = 'mem', baseline = false, cap = null }) {
  const w = appWasm(app);
  const args = [mb, ops, seed];
  if (baseline) {
    const b = await instantiateBase(w.base, cap ? { maxBytes: cap } : {});
    const t0 = performance.now();
    let value = null, error = null;
    try { value = b.exports.run(...args); } catch (e) { error = e.message; }
    const ms = performance.now() - t0;
    const status = error ? -1 : b.exports.status();
    return { app, mb, ops, seed, mode: 'baseline', cap, ms, value: value === null ? null : BigInt.asUintN(64, value).toString(16), status, error, memoryBytes: b.memory.buffer.byteLength };
  }
  const v = await createVera({ wasm: w.vera, poolBytes: pool, backend: makeBackend(backend) });
  const t0 = performance.now();
  let value = null, error = null;
  try { value = v.exports.run(...args); } catch (e) { error = e.message; }
  const ms = performance.now() - t0;
  const status = error ? -1 : v.exports.status();
  const stats = v.stats();
  const curve = v.faultCurve();
  const result = { app, mb, ops, seed, mode: 'vera', backend: stats.backend, pool: stats.poolBytes, ms, value: value === null ? null : BigInt.asUintN(64, value).toString(16), status, error, memoryBytes: stats.memoryBytes, stats, curve, vera: v };
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = { app: 'sort', mb: 64, ops: 0, seed: 1, pool: 64 << 20, backend: 'mem', baseline: false, cap: null, lang: 'tr', json: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--app') o.app = a[++i];
    else if (k === '--mb') o.mb = +a[++i];
    else if (k === '--ops') o.ops = +a[++i];
    else if (k === '--seed') o.seed = +a[++i];
    else if (k === '--pool') o.pool = parseSize(a[++i]);
    else if (k === '--backend') o.backend = a[++i];
    else if (k === '--baseline') o.baseline = true;
    else if (k === '--cap') o.cap = parseSize(a[++i]);
    else if (k === '--lang') o.lang = a[++i];
    else if (k === '--json') o.json = true;
    else { console.error(`unknown option ${k}`); process.exit(2); }
  }
  const r = await runOnce(o);
  if (o.json) {
    const { vera, ...rest } = r;
    console.log(JSON.stringify(rest, null, 2));
  } else if (r.mode === 'baseline') {
    const failed = r.status !== 0;
    console.log(`${r.app} ${r.mb} MiB, ordinary build${r.cap ? `, Memory capped at ${r.cap >> 20} MiB` : ''}: ` +
      (failed ? `FAILED (${r.error || 'out of memory: malloc returned NULL'})` : `ok in ${r.ms.toFixed(0)} ms, checksum ${r.value}, Memory ${r.memoryBytes >> 20} MiB`));
  } else {
    const failed = r.status !== 0;
    console.log(`${r.app} ${r.mb} MiB, WebSwap build: ` + (failed ? `FAILED (${r.error || 'status ' + r.status})` : `ok in ${r.ms.toFixed(0)} ms, checksum ${r.value}`));
    console.log(r.vera.meter(o.lang, { wallMs: r.ms }));
  }
  if (r.vera) r.vera.close();
  process.exit(r.status === 0 ? 0 : 1);
}
