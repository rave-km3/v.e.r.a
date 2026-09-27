// The key correctness test: the paged build must compute exactly what the
// ordinary build computes, for any pool size and storage backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { built, runBase, runVera } from './helpers.mjs';

const { vera, base } = built('apps/fuzz.c');
const MB = 16, OPS = 200_000;

for (const seed of [1, 2, 3]) {
  test(`fuzz seed ${seed}: identical results for every pool and backend`, async () => {
    const ref = await runBase(base, [MB, OPS, seed]);
    assert.equal(ref.status, 0);
    for (const [poolBytes, backend] of [
      [64 << 10, 'mem'], [64 << 10, 'file'], [1 << 20, 'delay'], [4 << 20, 'mem'], [32 << 20, 'mem'],
    ]) {
      const r = await runVera(vera, [MB, OPS, seed], { poolBytes, backend });
      assert.equal(r.status, 0);
      assert.equal(r.value, ref.value, `pool ${poolBytes >> 10} KiB, ${backend}`);
      if (poolBytes < 1 << 20) assert.ok(r.stats.evictDirty > 0 && r.stats.majorRead > 0, 'really paged');
    }
  });
}
