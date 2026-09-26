import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { built, ROOT } from './helpers.mjs';
import { instantiateBase, createVera } from '../runtime/vera.mjs';
import { DurableBackend, MemStore, NodeFileStore, crc32 } from '../runtime/durable.mjs';

const PAGE = 4096;
const page = (x) => new Uint8Array(PAGE).fill(x);

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('resume sees the last checkpoint, not later uncommitted writes', () => {
  const store = new MemStore();
  const a = new DurableBackend(store, { nvp: 64, lowBytes: 100 });
  a.write(3, page(1));
  a.checkpoint(new Uint8Array(100).fill(7), { n: 1 });
  a.write(3, page(2)); // after the checkpoint: must not be visible on resume
  a.write(4, page(3));
  const b = new DurableBackend(store, { nvp: 64, lowBytes: 100 }); // "after a crash"
  const st = b.resume();
  assert.equal(st.epoch, 1);
  assert.deepEqual(st.extra, { n: 1 });
  assert.equal(st.low[0], 7);
  const buf = new Uint8Array(2 * PAGE);
  b.read(3, 2, buf);
  assert.equal(buf[0], 1, 'page 3 has its checkpointed content');
  assert.equal(buf[PAGE], 0, 'page 4 was never checkpointed');
});

test('a torn or corrupt newest checkpoint falls back to the previous one', () => {
  for (const damage of ['header', 'meta', 'low']) {
    const store = new MemStore();
    const a = new DurableBackend(store, { nvp: 64, lowBytes: 100 });
    a.write(1, page(1));
    a.checkpoint(new Uint8Array(100).fill(1), { e: 1 });
    a.write(1, page(2));
    a.checkpoint(new Uint8Array(100).fill(2), { e: 2 });
    const s = 2 & 1; // area used by epoch 2
    const off = damage === 'header' ? s * PAGE + 8 : damage === 'meta' ? a.META[s] * PAGE + 1 : a.LOW[s] * PAGE + 5;
    const b1 = new Uint8Array(1);
    store.readAt(off, b1);
    store.writeAt(off, new Uint8Array([b1[0] ^ 0xff]));
    const b = new DurableBackend(store, { nvp: 64, lowBytes: 100 });
    const st = b.resume();
    assert.equal(st.epoch, 1, `fell back after damaged ${damage}`);
    const buf = new Uint8Array(PAGE);
    b.read(1, 1, buf);
    assert.equal(buf[0], 1, 'epoch-1 page content intact');
    assert.equal(st.low[0], 1);
  }
});

test('program state survives SIGKILL at random moments (20 kills)', async () => {
  const { vera: veraWasm, base } = built('test/fixtures/steps.c');
  const TOTAL = 60, OPS = 20000, CK = 4;
  // Reference: uninterrupted run of the ordinary build.
  const b = await instantiateBase(base);
  b.exports.init(8, 42);
  for (let i = 0; i < TOTAL; i++) b.exports.step(OPS);
  const expected = BigInt.asUintN(64, b.exports.digest()).toString(16);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-durable-'));
  const wasmPath = path.join(dir, 'steps.vera.wasm');
  fs.writeFileSync(wasmPath, veraWasm);
  const heap = path.join(dir, 'heap.bin');
  const child = path.join(ROOT, 'test', 'fixtures', 'durable-child.mjs');
  let kills = 0, resumes = 0, final = null;
  for (let attempt = 0; attempt < 200 && final === null; attempt++) {
    const p = spawn(process.execPath, [child, wasmPath, heap, `${TOTAL}`, `${OPS}`, `${CK}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const killAfter = kills < 20 ? 40 + ((attempt * 37) % 160) : null; // ms
    const timer = killAfter === null ? null : setTimeout(() => p.kill('SIGKILL'), killAfter);
    const code = await new Promise((r) => p.on('exit', (c, sig) => r(sig || c)));
    if (timer) clearTimeout(timer);
    if (/resumed epoch/.test(out)) resumes++;
    const m = /DONE ([0-9a-f]+)/.exec(out);
    if (m) final = m[1];
    else if (code === 'SIGKILL') kills++;
    else assert.fail(`child exited with ${code}: ${err}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(final, expected, 'digest after kills and resumes equals the uninterrupted run');
  assert.ok(kills >= 5, `the child was really killed (${kills} kills)`);
  assert.ok(resumes >= 1, 'the child really resumed');
  console.log(`# ${kills} SIGKILLs, ${resumes} resumes, final digest matches`);
});

test('checkpoint/resume in-process: heap and allocator state come back', async () => {
  const { vera: veraWasm } = built('test/fixtures/steps.c');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-durable2-'));
  const heap = path.join(dir, 'heap.bin');
  const v1 = await createVera({ wasm: veraWasm, poolBytes: 1 << 20, durableStore: new NodeFileStore(fs, heap), resume: true });
  assert.equal(v1.resumed, null);
  v1.exports.init(8, 7);
  v1.exports.step(50000);
  v1.checkpoint({ steps: 1 });
  const d1 = v1.exports.digest();
  v1.exports.step(12345); // lost: no checkpoint after this
  v1.close();
  const v2 = await createVera({ wasm: veraWasm, poolBytes: 1 << 20, durableStore: new NodeFileStore(fs, heap), resume: true });
  assert.deepEqual(v2.resumed.extra, { steps: 1 });
  assert.equal(v2.exports.digest(), d1);
  v2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
