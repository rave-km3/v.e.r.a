import test from 'node:test';
import assert from 'node:assert/strict';
import { built, runBase, runVera } from './helpers.mjs';

// [app, MiB, ops] - small sizes; the pool is 25% of the data.
for (const [app, mb, ops] of [
  ['sort', 8, 0], ['blur', 8, 1], ['hash', 8, 200_000], ['rand', 8, 200_000],
  ['chase', 8, 200_000], ['packed', 8, 100_000],
]) {
  test(`${app}: paged result equals baseline with a 25% pool`, async () => {
    const { vera, base } = built(`apps/${app}.c`);
    const ref = await runBase(base, [mb, ops, 7]);
    assert.equal(ref.status, 0);
    const r = await runVera(vera, [mb, ops, 7], { poolBytes: (mb << 20) / 4, backend: 'file' });
    assert.equal(r.status, 0);
    assert.equal(r.value, ref.value);
  });
}
