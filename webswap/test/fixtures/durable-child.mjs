// Child process for the crash tests: runs steps.c with a durable file heap,
// checkpointing every CK steps; on restart it resumes from the last checkpoint.
// argv: wasmPath heapPath totalSteps opsPerStep ckEvery
// Prints "CK <steps>" after each checkpoint has returned (so it is durable),
// "resumed epoch <e> at step <s>" or "fresh start", and "DONE <digest>".
// VERA_CRASH=<epoch>:<phase> makes the process SIGKILL itself at that phase
// of that checkpoint (phases: meta, low, flushed, half-header, committed).
import fs from 'node:fs';
import { createVera } from '../../runtime/vera.mjs';
import { NodeFileStore } from '../../runtime/durable.mjs';

const [wasmPath, heapPath, total, opsPerStep, ck] = process.argv.slice(2);
const vera = await createVera({
  wasm: fs.readFileSync(wasmPath), poolBytes: 1 << 20,
  durableStore: new NodeFileStore(fs, heapPath), resume: true, writeBudgetBytes: 2 ** 40,
});
if (process.env.VERA_CRASH) {
  const [epoch, phase] = process.env.VERA_CRASH.split(':');
  vera.pager.backend.onPhase = (ph, ep) => { if (ph === phase && ep === +epoch) process.kill(process.pid, 'SIGKILL'); };
}
const say = (line) => fs.writeSync(1, `${line}\n`); // synchronous: printed before we go on
let steps = 0;
if (vera.resumed) {
  steps = vera.resumed.extra.steps;
  say(`resumed epoch ${vera.resumed.epoch} at step ${steps}`);
} else {
  if (vera.exports.init(8, 42) !== 0) throw new Error('init failed');
  vera.checkpoint({ steps: 0 });
  say('fresh start');
}
while (steps < +total) {
  vera.exports.step(+opsPerStep);
  steps++;
  if (steps % +ck === 0) { vera.checkpoint({ steps }); say(`CK ${steps}`); }
}
say(`DONE ${BigInt.asUintN(64, vera.exports.digest()).toString(16)}`);
vera.close();
