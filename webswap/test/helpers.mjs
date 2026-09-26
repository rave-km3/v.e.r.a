// Shared helpers for the WebSwap tests: build apps once, fresh instances.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../tools/vera-build.mjs';
import { createVera, instantiateBase } from '../runtime/vera.mjs';
import { MemoryBackend, NodeFileBackend, DelayBackend } from '../runtime/backends.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');

const newest = (files) => Math.max(...files.map((f) => fs.statSync(f).mtimeMs));
const RUNTIME_SRC = ['runtime/vera.h', 'runtime/vera-libc.c', 'runtime/softmmu.c', 'tools/instrument.mjs', 'tools/vera-build.mjs']
  .map((f) => path.join(ROOT, f));

// Build src (relative to ROOT) unless outputs are newer than all inputs.
export function built(src) {
  const name = path.basename(src, '.c');
  const out = path.join(BUILD, name);
  const outs = [`${out}.vera.wasm`, `${out}.base.wasm`];
  const inputs = [path.join(ROOT, src), ...RUNTIME_SRC];
  if (!outs.every((f) => fs.existsSync(f)) || Math.min(...outs.map((f) => fs.statSync(f).mtimeMs)) < newest(inputs)) {
    buildApp([path.join(ROOT, src)], out);
  }
  return { vera: fs.readFileSync(`${out}.vera.wasm`), base: fs.readFileSync(`${out}.base.wasm`) };
}

export function makeBackend(kind) {
  if (kind === 'mem') return new MemoryBackend();
  if (kind === 'file') return new NodeFileBackend(fs, path.join(os.tmpdir(), `vera-test-${process.pid}-${Math.random().toString(36).slice(2)}.bin`));
  if (kind.startsWith('delay')) return new DelayBackend(new MemoryBackend(), { readUs: 3, writeUs: 3 });
  throw new Error(kind);
}

export async function runBase(bytes, args, opts = {}) {
  const b = await instantiateBase(bytes, opts);
  const value = b.exports.run(...args);
  return { value, status: b.exports.status(), memoryBytes: b.memory.buffer.byteLength };
}

export async function runVera(bytes, args, { poolBytes, backend = 'mem', ...rest } = {}) {
  const v = await createVera({ wasm: bytes, poolBytes, backend: makeBackend(backend), ...rest });
  try {
    const value = v.exports.run(...args);
    return { value, status: v.exports.status(), stats: v.stats(), curve: v.faultCurve(), vera: v };
  } finally {
    v.close();
  }
}
