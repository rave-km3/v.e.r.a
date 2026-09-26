#!/usr/bin/env node
// vera-build.mjs - build a C program for v.e.r.a WebSwap.
//
//   node tools/vera-build.mjs apps/sort.c -o build/sort
//
// Produces:
//   build/sort.vera.wasm  paged build: heap in the virtual region, every
//                         load/store instrumented (runs with a small Memory)
//   build/sort.base.wasm  baseline: ordinary wasm heap that grows with
//                         memory.grow (for comparisons and OOM demos)
//   build/sort.info.json  layout and instrumentation report
//
// Needs clang with the wasm32 target and wasm-ld (LLVM >= 16). Set CLANG to
// use a specific binary.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrument, checkFeatures } from './instrument.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'runtime');

// Is a usable clang (with the wasm32 target) available?
export function haveClang() {
  try {
    execFileSync(process.env.CLANG || 'clang', ['--target=wasm32', '-print-prog-name=wasm-ld'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function buildApp(sources, outBase, { vbase = 0x10000000, stackSize = 1 << 20, base = true, cflags = [], quiet = true, instrumentOptions = {} } = {}) {
  if (!Number.isInteger(vbase) || vbase <= 0 || vbase >= 2 ** 32 || vbase % 65536 !== 0) {
    throw new Error(`vera-build: --vbase must be a non-zero multiple of 64 KiB below 4 GiB (got ${vbase})`);
  }
  if (!Number.isInteger(stackSize) || stackSize < 65536 || stackSize % 16 !== 0) {
    throw new Error(`vera-build: --stack-size must be a multiple of 16 and at least 64 KiB (got ${stackSize})`);
  }
  const clang = process.env.CLANG || 'clang';
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const exec = (cmd, args) => execFileSync(cmd, args, { stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  // Compile with clang -c and link with wasm-ld ourselves: when clang links,
  // it silently runs any wasm-opt found on PATH, which strips the names the
  // instrumentation pass relies on.
  const wasmLd = process.env.WASM_LD || String(execFileSync(clang, ['--target=wasm32', '-print-prog-name=wasm-ld'])).trim();
  const cc = [
    '--target=wasm32', '-O2', '-ffreestanding', '-fno-builtin', '-nostdlib', '-mcpu=mvp',
    '-Wall', '-Wno-unused-function', `-I${RUNTIME}`, `-DVERA_VBASE=${vbase >>> 0}u`, ...cflags,
  ];
  const ld = ['--no-entry', '--import-memory', '--stack-first', '-z', `stack-size=${stackSize}`, '--export=__heap_base'];
  let objCount = 0;
  const run = (paged, files, out) => {
    const objs = files.map((f) => {
      const o = `${out}.${objCount++}.o`;
      exec(clang, [...cc, `-DVERA_PAGED=${paged}`, '-c', f, '-o', o]);
      return o;
    });
    try {
      exec(wasmLd, [...ld, ...objs, '-o', out]);
    } finally {
      for (const o of objs) fs.rmSync(o, { force: true });
    }
  };

  // Paged build: app + libc + soft-MMU in ONE link, so there is one memory layout.
  // Intermediate files go to a private directory next to the output (so
  // parallel builds never collide and renames stay on one file system) under
  // the output's own base name: wasm-ld records the file name as the module
  // name, and a fixed name keeps the build reproducible.
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(path.resolve(outBase)), '.vera-tmp-'));
  const tmp = path.join(tmpDir, path.basename(outBase));
  try {
    const linked = `${tmp}.linked.wasm`;
    run(1, [...sources, path.join(RUNTIME, 'vera-libc.c'), path.join(RUNTIME, 'softmmu.c')], linked);
    const { binary, report } = instrument(fs.readFileSync(linked), { vbase, ...instrumentOptions });
    fs.writeFileSync(`${tmp}.vera.wasm`, binary);
    fs.renameSync(`${tmp}.vera.wasm`, `${outBase}.vera.wasm`);

    const info = {
      vbase: vbase >>> 0, stackSize, pageSize: 4096,
      sources: sources.map((s) => path.relative(ROOT, path.resolve(s))), instrument: report,
    };
    if (base) {
      run(0, [...sources, path.join(RUNTIME, 'vera-libc.c')], `${tmp}.base.wasm`);
      const bad = checkFeatures(fs.readFileSync(`${tmp}.base.wasm`));
      if (bad.length) throw new Error(`baseline uses unsupported features: ${bad.join(', ')}`);
      fs.renameSync(`${tmp}.base.wasm`, `${outBase}.base.wasm`);
    }
    fs.writeFileSync(`${tmp}.info.json`, JSON.stringify(info, null, 2) + '\n');
    fs.renameSync(`${tmp}.info.json`, `${outBase}.info.json`);
    return info;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sources = [];
  let out = null, vbase = 0x10000000, stackSize = 1 << 20, base = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') out = args[++i];
    else if (args[i] === '--vbase') vbase = Number(args[++i]);
    else if (args[i] === '--stack-size') stackSize = Number(args[++i]);
    else if (args[i] === '--no-base') base = false;
    else if (args[i] === '-h' || args[i] === '--help') { sources.length = 0; out = null; break; }
    else sources.push(args[i]);
  }
  if (!sources.length || !out) {
    console.error('usage: vera-build.mjs <file.c>... -o <out-base> [--vbase 0x10000000] [--stack-size 1048576] [--no-base]');
    process.exit(2);
  }
  try {
    const info = buildApp(sources, out, { vbase, stackSize, base, quiet: false });
    console.log(JSON.stringify(info.instrument));
  } catch (e) {
    console.error(String(e.stderr || '') + e.message);
    process.exit(1);
  }
}
