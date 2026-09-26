#!/usr/bin/env node
// browser.mjs - run WebSwap in a real browser (Chromium via Playwright),
// paging to OPFS from a Worker, and check results against Node.
//
//   node test/browser.mjs
//
// Needs Playwright (npm i -D playwright, or a global install) and a Chromium
// it can launch. Uses a persistent profile because OPFS in a throwaway
// context can behave differently.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '../host/web/serve.mjs';
import { runOnce } from '../host/node-run.mjs';
import { instantiateBase } from '../runtime/vera.mjs';
import { built } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* try the global install */ }
  const req = createRequire(path.join(String(execSync('npm root -g')).trim(), 'noop.js'));
  return req('playwright');
}

const MB = 2 ** 20;
const { chromium } = await loadPlaywright();
const server = await serve(0);
const url = `http://127.0.0.1:${server.address().port}/host/web/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vera-chromium-'));
const ctx = await chromium.launchPersistentContext(profile, { headless: true });
const results = { browser: `chromium ${ctx.browser()?.version() ?? ''}`.trim(), cases: [] };
let failed = 0;

try {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => typeof window.veraRun === 'function');
  results.userAgent = await page.evaluate(() => navigator.userAgent);

  const cases = [
    { app: 'fuzz', mb: 16, ops: 200_000, seed: 1, pool: 1 * MB },
    { app: 'sort', mb: 64, ops: 0, seed: 1, pool: 16 * MB },
    { app: 'hash', mb: 32, ops: 200_000, seed: 1, pool: 8 * MB },
  ];
  for (const c of cases) {
    const ref = await runOnce({ ...c, baseline: true });
    const r = await page.evaluate((req) => window.veraRun(req), { ...c, mode: 'vera', backend: 'opfs' });
    const row = { ...c, pool: c.pool / MB, ok: r.ok, ms: r.ms && +r.ms.toFixed(0), value: r.value, expected: ref.value,
      backend: r.stats?.backend, readMiB: r.stats && +(r.stats.readBytes / MB).toFixed(1), writtenMiB: r.stats && +(r.stats.writeBytes / MB).toFixed(1),
      memoryMiB: r.stats && +(r.stats.memoryBytes / MB).toFixed(1), error: r.error };
    results.cases.push(row);
    try {
      assert.equal(r.ok, true, r.error);
      assert.equal(r.stats.backend, 'opfs');
      assert.equal(r.value, ref.value, 'same result as Node baseline');
      assert.ok(r.stats.readBytes > 0 && r.stats.writeBytes > 0, 'pages really went through OPFS');
      console.log(`ok   ${c.app} ${c.mb} MiB, pool ${c.pool / MB} MiB, OPFS: ${row.ms} ms, read ${row.readMiB} MiB, wrote ${row.writtenMiB} MiB, checksum matches Node`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${c.app}: ${e.message}`);
    }
  }

  // The ordinary build with its Memory capped at the pool size must fail.
  const cap = await page.evaluate((req) => window.veraRun(req), { app: 'sort', mb: 64, ops: 0, seed: 1, mode: 'baseline', cap: 16 * MB });
  results.cappedBaseline = { ok: cap.ok, error: cap.error ?? null, status: cap.status ?? null };
  if (cap.ok) { failed++; console.log('FAIL capped baseline unexpectedly succeeded'); }
  else console.log('ok   ordinary build capped at 16 MiB fails on the same job (as expected)');

  // Checkpoint, lose some work, reload the page (the worker dies with it),
  // resume from OPFS and finish: the digest must equal an uninterrupted run.
  {
    const req = { mode: 'durable', name: 'vera-durable-test.bin', mb: 8, seed: 42, ops: 20000, ck: 5, total: 40 };
    const b = await instantiateBase(built('test/fixtures/steps.c').base);
    b.exports.init(req.mb, req.seed);
    for (let i = 0; i < req.total; i++) b.exports.step(req.ops);
    const expected = BigInt.asUintN(64, b.exports.digest()).toString(16);
    await page.evaluate((r) => window.veraRun(r), { ...req, reset: true });
    const first = await page.evaluate((r) => window.veraRun(r), { ...req, stopAt: 23 });
    await page.reload();
    await page.waitForFunction(() => typeof window.veraRun === 'function');
    const second = await page.evaluate((r) => window.veraRun(r), { ...req, stopAt: req.total });
    results.durable = { first, second, expected };
    const ok = first.ok && !first.finished && first.lastCheckpoint === 20 && second.ok && second.resumedFrom === 20 && second.digest === expected;
    if (!ok) { failed++; console.log(`FAIL durable resume: ${JSON.stringify(results.durable)}`); }
    else console.log('ok   checkpoint at step 20, page reloaded mid-work, resumed from OPFS at step 20, final digest matches Node');
  }

  const probe = await page.evaluate(() => window.veraRun({ mode: 'probe' }));
  results.probe = probe;
  console.log(`info OPFS 4 KiB sync read mean ${probe.opfs4kRead?.meanUs} µs (worst batch ${probe.opfs4kRead?.worstBatchMeanUs}); write mean ${probe.opfs4kWrite?.meanUs} µs; max Memory ${probe.maxMemoryMiB} MiB`);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results', 'browser.json'), JSON.stringify(results, null, 1) + '\n');
console.log(failed ? `${failed} browser check(s) FAILED` : 'all browser checks passed');
process.exit(failed ? 1 : 0);
