// worker.mjs - runs WebSwap programs in a browser Worker, paging to OPFS.
// FileSystemSyncAccessHandle (synchronous OPFS I/O) only exists in Workers,
// and page faults must be served synchronously, so everything happens here.
import { createVera, instantiateBase, probeMaxMemoryBytes } from '../../runtime/vera.mjs';
import { OPFSSyncBackend, MemoryBackend, PAGE } from '../../runtime/backends.mjs';
import { OPFSStore } from '../../runtime/durable.mjs';

const BUILD = new URL('../../build/', import.meta.url);
const hex = (v) => (v === null || v === undefined ? null : BigInt.asUintN(64, BigInt(v)).toString(16));

async function wasmBytes(app, kind) {
  const r = await fetch(new URL(`${app}.${kind}.wasm`, BUILD));
  if (!r.ok) throw new Error(`cannot load ${app}.${kind}.wasm (${r.status}); run "npm run build" first`);
  return new Uint8Array(await r.arrayBuffer());
}

async function runVera({ app, mb, ops, seed, pool, backend }) {
  const store = backend === 'opfs'
    ? await OPFSSyncBackend.open(`vera-${app}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`)
    : new MemoryBackend();
  const v = await createVera({ wasm: await wasmBytes(app, 'vera'), poolBytes: pool, backend: store });
  const t0 = performance.now();
  let value = null, error = null;
  try { value = v.exports.run(mb, ops, seed); } catch (e) { error = String(e && e.message || e); }
  const ms = performance.now() - t0;
  const status = error ? -1 : v.exports.status();
  const out = {
    ok: status === 0, mode: 'vera', value: hex(value), status, error, ms,
    stats: v.stats(), curve: v.faultCurve(),
    meterTr: v.meter('tr', { wallMs: ms }), meterEn: v.meter('en', { wallMs: ms }),
  };
  if (store.closeAsync) await store.closeAsync(); else store.close();
  return out;
}

async function runBase({ app, mb, ops, seed, cap }) {
  let b;
  try {
    b = await instantiateBase(await wasmBytes(app, 'base'), cap ? { maxBytes: cap } : {});
  } catch (e) {
    return { ok: false, mode: 'baseline', error: `could not allocate Memory: ${e.message}` };
  }
  const t0 = performance.now();
  let value = null, error = null;
  try { value = b.exports.run(mb, ops, seed); } catch (e) { error = String(e && e.message || e); }
  const ms = performance.now() - t0;
  const status = error ? -1 : b.exports.status();
  return { ok: status === 0, mode: 'baseline', value: hex(value), status, error, ms, memoryBytes: b.memory.buffer.byteLength };
}

// Device facts that matter for paging: OPFS 4 KiB sync latency and the
// largest WebAssembly.Memory this browser will give us. Browsers coarsen
// performance.now() (often to 100 us), so we time batches of operations and
// report the mean per operation plus the slowest batch.
async function probe() {
  const store = await OPFSSyncBackend.open(`vera-probe-${Date.now()}.bin`);
  const buf = new Uint8Array(PAGE).fill(7);
  const N = 4000, BATCH = 100;
  const measure = (op) => {
    const per = [];
    for (let b = 0; b < N / BATCH; b++) {
      const t = performance.now();
      for (let i = 0; i < BATCH; i++) op(b * BATCH + i);
      per.push(((performance.now() - t) * 1000) / BATCH);
    }
    const mean = per.reduce((a, x) => a + x, 0) / per.length;
    return { meanUs: +mean.toFixed(1), worstBatchMeanUs: +Math.max(...per).toFixed(1) };
  };
  const write = measure((i) => store.write(i, buf));
  store.flush();
  const read = measure((i) => store.read((i * 7919) % N, 1, buf));
  await store.closeAsync();
  return {
    ok: true, mode: 'probe', opfs4kWrite: write, opfs4kRead: read,
    maxMemoryMiB: probeMaxMemoryBytes(4 * 2 ** 30 - 65536) / 2 ** 20,
    userAgent: navigator.userAgent,
  };
}

// Checkpoint/resume demo with test/fixtures/steps.c: run until `stopAt`
// steps, checkpointing every `ck`; do one extra step that is NOT
// checkpointed (it is lost if the page dies), and return. After the page is
// reloaded or killed, the next call resumes from the last checkpoint.
async function openStoreWithRetry(name) {
  for (let i = 0; ; i++) {
    try { return await OPFSStore.open(name); } catch (e) {
      // The previous (killed) worker may still hold the exclusive lock briefly.
      if (i >= 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
async function durable({ name, mb, seed, ops, ck, total, stopAt, reset }) {
  if (reset) {
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(name).catch(() => {});
    return { ok: true, mode: 'durable-reset' };
  }
  const store = await openStoreWithRetry(name);
  const v = await createVera({ wasm: await wasmBytes('steps', 'vera'), poolBytes: 1 << 20, durableStore: store, resume: true });
  let steps = 0;
  if (v.resumed) steps = v.resumed.extra.steps;
  else { if (v.exports.init(mb, seed) !== 0) throw new Error('init failed'); v.checkpoint({ steps: 0 }); }
  const resumedFrom = v.resumed ? steps : null;
  let lastCheckpoint = steps;
  const end = Math.min(stopAt, total);
  while (steps < end) {
    v.exports.step(ops);
    steps++;
    if (steps % ck === 0) { v.checkpoint({ steps }); lastCheckpoint = steps; }
  }
  if (steps < total) {
    v.exports.step(ops); // work that will be lost: no checkpoint follows
    return { ok: true, mode: 'durable', resumedFrom, lastCheckpoint, finished: false };
  }
  const digest = hex(v.exports.digest());
  store.close();
  return { ok: true, mode: 'durable', resumedFrom, lastCheckpoint, finished: true, digest };
}

self.onmessage = async ({ data: { id, req } }) => {
  let res;
  try {
    if (req.mode === 'probe') res = await probe();
    else if (req.mode === 'durable') res = await durable(req);
    else if (req.mode === 'baseline') res = await runBase(req);
    else res = await runVera(req);
  } catch (e) {
    res = { ok: false, error: String(e && e.stack || e) };
  }
  self.postMessage({ id, res });
};
