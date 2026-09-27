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

// Reference digest: an uninterrupted run of the ordinary build.
async function referenceDigest(base, total, ops) {
  const b = await instantiateBase(base);
  b.exports.init(8, 42);
  for (let i = 0; i < total; i++) b.exports.step(ops);
  return BigInt.asUintN(64, b.exports.digest()).toString(16);
}

// Runs the child once. killWhen(line) is called for every stdout line; when
// it returns a delay in ms, the child is SIGKILLed that long afterwards.
function runChild(args, { env = {}, killWhen = () => null } = {}) {
  const child = path.join(ROOT, 'test', 'fixtures', 'durable-child.mjs');
  const p = spawn(process.execPath, [child, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const lines = [];
  let buf = '', err = '', timer = null;
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const delay = timer === null ? killWhen(line) : null;
      if (delay !== null && delay !== undefined) timer = setTimeout(() => p.kill('SIGKILL'), delay);
    }
  });
  p.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => p.on('exit', (code, sig) => {
    clearTimeout(timer);
    const ck = lines.filter((l) => l.startsWith('CK ')).map((l) => +l.slice(3));
    const res = /^resumed epoch (\d+) at step (\d+)$/.exec(lines.find((l) => l.startsWith('resumed')) ?? '');
    const done = /^DONE ([0-9a-f]+)$/.exec(lines.find((l) => l.startsWith('DONE')) ?? '');
    resolve({ exit: sig || code, lines, err, lastCk: ck.length ? ck[ck.length - 1] : null,
      resumed: res ? { epoch: +res[1], step: +res[2] } : null, digest: done ? done[1] : null });
  }));
}

test('program state survives 20 SIGKILLs spread over the run; every checkpoint that returned survives', async () => {
  const { vera: veraWasm, base } = built('test/fixtures/steps.c');
  const TOTAL = 75, OPS = 5000, CK = 3, KILLS = 20;
  const expected = await referenceDigest(base, TOTAL, OPS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-durable-'));
  const wasmPath = path.join(dir, 'steps.vera.wasm');
  fs.writeFileSync(wasmPath, veraWasm);
  const args = [wasmPath, path.join(dir, 'heap.bin'), `${TOTAL}`, `${OPS}`, `${CK}`];
  let lastDurable = 0; // newest checkpoint the child reported as returned
  const resumedAt = [];
  for (let k = 0; k < KILLS; k++) {
    // Kill k waits for a checkpoint at or past step 3(k+1), so kills move
    // through the whole run, then lands 0-129 ms later (a checkpoint period is
    // ~120 ms here): inside a step, a page write-back or the next checkpoint.
    // Crashes at each checkpoint phase are forced in the next test.
    const target = CK * (k + 1);
    const r = await runChild(args, { killWhen: (l) => (l.startsWith('CK ') && +l.slice(3) >= target ? (k * 29) % 130 : null) });
    assert.equal(r.exit, 'SIGKILL', `attempt ${k} was killed (lines: ${r.lines.join(' | ')}; ${r.err})`);
    if (k > 0) {
      assert.ok(r.resumed, `attempt ${k} resumed instead of starting over`);
      assert.ok(r.resumed.step > 0, 'resumed past step 0');
      assert.ok(r.resumed.step >= lastDurable, `resumed at step ${r.resumed.step}, but checkpoint ${lastDurable} had returned`);
      resumedAt.push(r.resumed.step);
    }
    lastDurable = Math.max(lastDurable, r.lastCk ?? 0);
  }
  const fin = await runChild(args);
  assert.equal(fin.exit, 0, fin.err);
  assert.ok(fin.resumed && fin.resumed.step >= lastDurable);
  resumedAt.push(fin.resumed.step);
  assert.equal(fin.digest, expected, 'digest after 20 kills and resumes equals the uninterrupted run');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`# ${KILLS} SIGKILLs; resumed at steps ${resumedAt.join(', ')}; final digest matches`);
});

test('a crash inside each phase of a checkpoint resumes from the right checkpoint', async () => {
  const { vera: veraWasm, base } = built('test/fixtures/steps.c');
  const TOTAL = 15, OPS = 5000, CK = 3;
  const expected = await referenceDigest(base, TOTAL, OPS);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-durable-phase-'));
  const wasmPath = path.join(dir, 'steps.vera.wasm');
  fs.writeFileSync(wasmPath, veraWasm);
  // Epoch 1 is step 0, epoch 2 step 3, epoch 3 step 6, epoch 4 step 9.
  for (const phase of ['meta', 'low', 'flushed', 'half-header', 'committed']) {
    const heap = path.join(dir, `heap-${phase}.bin`);
    const args = [wasmPath, heap, `${TOTAL}`, `${OPS}`, `${CK}`];
    const crashed = await runChild(args, { env: { VERA_CRASH: `4:${phase}` } });
    assert.equal(crashed.exit, 'SIGKILL', `${phase}: the child killed itself`);
    assert.equal(crashed.lastCk, 6, `${phase}: died during the checkpoint for step 9`);
    const fin = await runChild(args);
    assert.equal(fin.exit, 0, fin.err);
    const want = phase === 'committed' ? { epoch: 4, step: 9 } : { epoch: 3, step: 6 };
    assert.deepEqual(fin.resumed, want, `${phase}: resumed from the newest complete checkpoint`);
    assert.equal(fin.digest, expected, `${phase}: final digest equals the uninterrupted run`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
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
