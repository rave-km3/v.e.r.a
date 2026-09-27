#!/usr/bin/env node
// cross-runtime.mjs - run the same WebSwap programs under every JS runtime
// found on this machine (Node/V8, Bun/JavaScriptCore, Deno/V8) and check
// that all of them produce the checksum of the ordinary (non-paged) build.
//
//   node test/cross-runtime.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'host', 'node-run.mjs');
const which = (cmd, extra = []) => {
  for (const c of [cmd, ...extra]) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch { /* not found */ }
  }
  return null;
};
const runtimes = [
  ['node', process.execPath, []],
  ['bun', which('bun', [path.join(os.homedir(), '.bun', 'bin', 'bun')]), []],
  ['deno', which('deno'), ['run', '-A']],
].filter(([, bin]) => bin);

// [app, MiB, ops, pool, backend, compressed tier]
const cases = [
  ['fuzz', 8, 100000, '256K', 'file', '0'],
  ['sort', 32, 0, '8M', 'file', '0'],
  ['packed', 8, 50000, '1M', 'mem', '0'],
  ['fuzz', 8, 100000, '64K', 'file', '64K'],
  ['rand', 16, 100000, '2M', 'mem', '2M'],
];
let failed = 0;
for (const [app, mb, ops, pool, backend, tier] of cases) {
  const ref = JSON.parse(execFileSync(process.execPath, [CLI, '--app', app, '--mb', `${mb}`, '--ops', `${ops}`, '--baseline', '--json'])).value;
  for (const [name, bin, pre] of runtimes) {
    let got;
    try {
      got = JSON.parse(execFileSync(bin, [...pre, CLI, '--app', app, '--mb', `${mb}`, '--ops', `${ops}`, '--pool', pool, '--compress', tier, '--backend', backend, '--json'])).value;
    } catch (e) {
      got = `error: ${String(e.stderr || e.message).split('\n')[0]}`;
    }
    const ok = got === ref;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(5)} ${app} ${mb} MiB, pool ${pool}${tier !== '0' ? ` + tier ${tier}` : ''}, ${backend}: ${got}${ok ? '' : ` (expected ${ref})`}`);
  }
}
console.log(`runtimes: ${runtimes.map(([n]) => n).join(', ')}`);
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
process.exit(failed ? 1 : 0);
