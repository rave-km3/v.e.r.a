// Shared helpers for the WebSwap tests: build apps once, fresh instances.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildApp, haveClang } from '../tools/vera-build.mjs';
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
  const stale = !outs.every((f) => fs.existsSync(f)) || Math.min(...outs.map((f) => fs.statSync(f).mtimeMs)) < newest(inputs);
  if (stale && haveClang()) buildApp([path.join(ROOT, src)], out); // else: use the prebuilt files
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

// A hostile pager for tests: before every fault it moves every resident page
// to another frame (as if it had evicted and reloaded all of them). Any
// translation kept across a fault then reads or writes the wrong page.
export function shufflePagesOnEveryFault(pager) {
  const PAGE = 4096;
  const tmp = new Uint8Array(PAGE * pager.P);
  const fault = pager.fault.bind(pager);
  pager.fault = (v, write) => {
    const n = Math.min(pager.nextUnused, pager.P);
    if (n > 1) {
      tmp.set(pager.u8.subarray(pager.framesAddr, pager.framesAddr + n * PAGE));
      const owner = pager.owner.slice(), dirty = pager.dirty.slice(), ref = pager.ref.slice();
      for (let f = 0; f < n; f++) {
        const g = (f + 1) % n; // frame f's page moves to frame g
        pager.u8.set(tmp.subarray(f * PAGE, (f + 1) * PAGE), pager.framesAddr + g * PAGE);
        pager.owner[g] = owner[f];
        pager.dirty[g] = dirty[f];
        pager.ref[g] = ref[f];
        const u = owner[f];
        if (u >= 0) {
          pager.resident[u] = g;
          if (pager.pt[u]) pager.pt[u] = pager.entry(g);
        }
      }
    }
    return fault(v, write);
  };
}

// A C program with `loops` streaming loops, each with `perLoop` blocks of
// `fields` read-modify-writes through one random pointer (a merged group
// each, with a fallback copy), next to streaming accesses (TLB entries).
export function groupsSource(perLoop, loops, fields = 64) {
  let body = '';
  for (let l = 0; l < loops; l++) {
    let st = '';
    for (let g = 0; g < perLoop; g++) {
      st += `      { S *p = (S *)((u8 *)A + ((r ^ ${g * 977 + l}u) * ${4 * (g + 1) + 4}u) % (n * sizeof(S) - sizeof(S))); r = r * 1103515245u + 12345u; u32 x = B[i] + ${g}u;`;
      for (let f = 0; f < fields; f++) st += ` p->f[${f}] += x;`;
      st += ' }\n';
    }
    body += `    for (u32 i = 0; i < m; i++) { B[i] += B[i + 1] ^ (u32)r; C[i * 2] = B[i] + C[i * 2 + 1]; D[i] ^= C[i]; E[i] += D[i + 1];\n${st}    }\n`;
  }
  return `#include "vera.h"
typedef struct { u32 f[${fields}]; } S;
VERA_EXPORT("run") u64 run(u32 n, u32 m, u32 seed)
{
  vera_app_status = 0;
  S *A = malloc(n * sizeof(S)); u32 *B = malloc((m + 2) * 4), *C = malloc((2 * m + 2) * 4), *D = malloc((m + 2) * 4), *E = malloc((m + 2) * 4);
  if (!A || !B || !C || !D || !E) { vera_app_status = 1; return 0; }
  for (u32 i = 0; i < n * ${fields}; i++) ((u32 *)A)[i] = i * 2654435761u;
  for (u32 i = 0; i < m + 2; i++) { B[i] = i; D[i] = i * 5; E[i] = i ^ 77; }
  for (u32 i = 0; i < 2 * m + 2; i++) C[i] = i * 3;
  u64 h = seed; u32 r = seed;
${body}
  for (u32 i = 0; i < n * ${fields}; i++) h = vera_mix(h, ((u32 *)A)[i]);
  for (u32 i = 0; i < m + 2; i++) h = vera_mix(h, B[i] + D[i] + E[i]);
  for (u32 i = 0; i < 2 * m + 2; i++) h = vera_mix(h, C[i]);
  return h;
}
`;
}
