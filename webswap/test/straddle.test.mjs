import test from 'node:test';
import assert from 'node:assert/strict';
import { built, runVera } from './helpers.mjs';
import { VeraTrapError } from '../runtime/vera.mjs';

test('a misaligned "aligned" access across a page boundary traps instead of corrupting', async () => {
  const { vera } = built('test/fixtures/straddle.c');
  await assert.rejects(runVera(vera, [0, 0, 0], { poolBytes: 1 << 20 }), (e) => e instanceof VeraTrapError && /crosses a page boundary/.test(e.message));
});
