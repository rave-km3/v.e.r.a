#!/usr/bin/env node
// Build every demo app and test fixture into build/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './vera-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['fuzz', 'sort', 'blur', 'hash', 'rand', 'chase', 'packed'].map((a) => `apps/${a}.c`)
  .concat(['test/fixtures/straddle.c']);
for (const src of SOURCES) {
  const name = path.basename(src, '.c');
  const info = buildApp([path.join(ROOT, src)], path.join(ROOT, 'build', name));
  const r = info.instrument;
  console.log(`${name.padEnd(9)} fast ${r.loadsFast + r.storesFast}, byte-wise ${r.loadsSlow + r.storesSlow}, ordered stores ${r.storesWithTemps}, helper calls left ${r.remainingHelperCalls}`);
}
