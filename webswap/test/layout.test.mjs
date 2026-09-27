// The inlined page-table lookup indexes a table base moved down by
// VBASE / 4096 entries (PTE() in runtime/softmmu.c), and the build step folds
// that constant into the load offset only when the sum cannot wrap. With a
// high VBASE and a small stack the moved-down base is "negative" and the
// lookup relies on u32 wrap-around instead; both layouts must compute what
// the ordinary build computes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBase, runVera, ROOT } from './helpers.mjs';
import { buildApp, haveClang } from '../tools/vera-build.mjs';
import { readLayout } from '../runtime/vera.mjs';

for (const [vbase, stackSize] of [[0x40000000, 65536], [0x01000000, 65536]]) {
  test(`fuzz matches the ordinary build with VBASE 0x${vbase.toString(16)} and a ${stackSize >> 10} KiB stack`,
    { skip: !haveClang() && 'needs clang' }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-layout-'));
      try {
        const info = buildApp([path.join(ROOT, 'apps/fuzz.c')], path.join(dir, 'fuzz'), { vbase, stackSize });
        const vera = fs.readFileSync(path.join(dir, 'fuzz.vera.wasm'));
        const base = fs.readFileSync(path.join(dir, 'fuzz.base.wasm'));
        assert.equal(readLayout(new WebAssembly.Module(vera)).vbase, vbase);
        assert.equal(info.instrument.remainingHelperCalls, 0);
        for (const seed of [1, 2]) {
          const ref = await runBase(base, [4, 50_000, seed]);
          assert.equal(ref.status, 0);
          for (const poolBytes of [64 << 10, 1 << 20]) {
            const r = await runVera(vera, [4, 50_000, seed], { poolBytes });
            assert.equal(r.status, 0);
            assert.equal(r.value, ref.value, `seed ${seed}, pool ${poolBytes >> 10} KiB`);
          }
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
}
