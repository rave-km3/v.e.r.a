import test from 'node:test';
import assert from 'node:assert/strict';
import { built, makeBackend } from './helpers.mjs';
import { createVera } from '../runtime/vera.mjs';

test('host read/write/readCString work across pages and after eviction', async () => {
  const { vera: bytes } = built('apps/fuzz.c');
  const v = await createVera({ wasm: bytes, poolBytes: 64 << 10, backend: makeBackend('file') });
  const p = v.exports.vera_malloc(5 * 4096);
  assert.ok(p >>> 0 >= v.layout.vbase);
  const data = new Uint8Array(5 * 4096 - 7).map((_, i) => (i * 31 + 7) & 255);
  v.write(p + 3, data);
  // Push everything out of the 16-frame pool.
  const q = v.exports.vera_malloc(64 * 4096);
  v.write(q, new Uint8Array(64 * 4096).fill(9));
  assert.ok(v.stats().evictDirty > 0);
  assert.deepEqual(v.read(p + 3, data.length), data);
  v.write(p + 4090, new TextEncoder().encode('merhaba dünya\0'));
  assert.equal(v.readCString(p + 4090), 'merhaba dünya');
  v.close();
});
