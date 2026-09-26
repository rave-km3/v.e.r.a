import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { built, ROOT } from './helpers.mjs';
import { readLayout } from '../runtime/vera.mjs';

test('build: translation helpers are fully inlined and layout is embedded', () => {
  const { vera, base } = built('apps/fuzz.c');
  const info = JSON.parse(fs.readFileSync(path.join(ROOT, 'build/fuzz.info.json'), 'utf8'));
  assert.ok(info.instrument.loadsFast > 0 && info.instrument.storesFast > 0);
  assert.ok(info.instrument.loadsSlow > 0, 'packed accesses take the byte-wise path');
  assert.equal(info.instrument.remainingHelperCalls, 0);
  const layout = readLayout(new WebAssembly.Module(vera));
  assert.equal(layout.format, 'vera-webswap/1');
  assert.equal(layout.vbase, 0x10000000);
  assert.ok(layout.heapBase < layout.vbase);
  assert.ok(vera.length < 200_000, 'no multi-MiB zero page-table segment in the binary');
  assert.ok(base.length > 0);
});
