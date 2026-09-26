// The value demo: a job that needs more memory than the (capped) Memory can
// have crashes as an ordinary build and completes as a paged build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { built, runBase, runVera } from './helpers.mjs';

test('sort of 256 MiB keys (512 MiB heap): baseline capped at 128 MiB fails, paged run with a 32 MiB pool completes', async () => {
  const { vera, base } = built('apps/sort.c');
  const capped = await runBase(base, [256, 0, 3], { maxBytes: 128 << 20 });
  assert.equal(capped.status, 1, 'malloc failed in the capped baseline');

  let t = performance.now();
  const ref = await runBase(base, [256, 0, 3]); // uncapped reference
  const baseMs = performance.now() - t;
  assert.equal(ref.status, 0);

  t = performance.now();
  const r = await runVera(vera, [256, 0, 3], { poolBytes: 32 << 20, backend: 'file' });
  const veraMs = performance.now() - t;
  assert.equal(r.status, 0);
  assert.equal(r.value, ref.value, 'same sorted checksum');
  assert.ok(r.stats.memoryBytes < 48 << 20, 'real Memory stayed small');
  console.log(`# baseline (uncapped, ${(ref.memoryBytes / 2 ** 20) | 0} MiB Memory): ${baseMs.toFixed(0)} ms; ` +
    `paged (${(r.stats.memoryBytes / 2 ** 20) | 0} MiB Memory): ${veraMs.toFixed(0)} ms (${(veraMs / baseMs).toFixed(1)}x)`);
});
