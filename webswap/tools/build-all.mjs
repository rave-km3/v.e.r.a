#!/usr/bin/env node
// Build every demo app and test fixture into build/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { buildApp, haveClang } from './vera-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['fuzz', 'sort', 'blur', 'hash', 'rand', 'chase', 'packed'].map((a) => `apps/${a}.c`)
  .concat(['test/fixtures/straddle.c', 'test/fixtures/steps.c', 'test/fixtures/rmw.c', 'test/fixtures/stack.c', 'test/fixtures/alloc.c']);
if (!haveClang()) {
  const missing = SOURCES.map((s) => path.join(ROOT, 'build', path.basename(s, '.c')))
    .filter((o) => !fs.existsSync(`${o}.vera.wasm`) || !fs.existsSync(`${o}.base.wasm`));
  if (missing.length) {
    console.error(`clang with the wasm32 target was not found, and prebuilt files are missing: ${missing.map((m) => path.basename(m)).join(', ')}`);
    process.exit(1);
  }
  console.log('clang (wasm32) not found: using the prebuilt files in build/');
  process.exit(0);
}
for (const src of SOURCES) {
  const name = path.basename(src, '.c');
  const info = buildApp([path.join(ROOT, src)], path.join(ROOT, 'build', name));
  const r = info.instrument;
  console.log(`${name.padEnd(9)} fast ${r.loadsFast + r.storesFast}, byte-wise ${r.loadsSlow + r.storesSlow}, ordered stores ${r.storesWithTemps}, helper calls left ${r.remainingHelperCalls}`);
}
