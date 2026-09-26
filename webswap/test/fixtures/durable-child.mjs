// Child process for the SIGKILL test: runs steps.c with a durable file heap,
// checkpointing every CK steps; on restart it resumes from the last checkpoint.
// argv: wasmPath heapPath totalSteps opsPerStep ckEvery
import fs from 'node:fs';
import { createVera } from '../../runtime/vera.mjs';
import { NodeFileStore } from '../../runtime/durable.mjs';

const [wasmPath, heapPath, total, opsPerStep, ck] = process.argv.slice(2);
const vera = await createVera({
  wasm: fs.readFileSync(wasmPath), poolBytes: 1 << 20,
  durableStore: new NodeFileStore(fs, heapPath), resume: true,
});
let steps = 0;
if (vera.resumed) {
  steps = vera.resumed.extra.steps;
  console.log(`resumed epoch ${vera.resumed.epoch} at step ${steps}`);
} else {
  if (vera.exports.init(8, 42) !== 0) throw new Error('init failed');
  vera.checkpoint({ steps: 0 });
  console.log('fresh start');
}
while (steps < +total) {
  vera.exports.step(+opsPerStep);
  steps++;
  if (steps % +ck === 0) vera.checkpoint({ steps });
}
console.log(`DONE ${BigInt.asUintN(64, vera.exports.digest()).toString(16)}`);
vera.close();
