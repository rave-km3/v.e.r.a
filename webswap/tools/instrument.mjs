// instrument.mjs - rewrite every load/store of a wasm32 module so it goes
// through the WebSwap software MMU (runtime/softmmu.c).
//
//   aligned load   (align >= size)  : T.load  offset=0 (call __vera_tl(ptr + offset, size))
//   aligned store                   : T.store offset=0 (call __vera_ts(ptr + offset, size)) value
//   possibly unaligned load / store : call __vera_ld_T / __vera_st_T (byte-wise, page-crossing safe)
//
// Ordering rule for stores: a translated address is only valid until the next
// page fault, because the fault may evict that frame. So when the stored value
// itself may touch memory (and therefore fault), we evaluate pointer and value
// into fresh locals first and translate the pointer last:
//
//   (local.set $p ptr+offset) (local.set $v value) (T.store (call __vera_ts $p) $v)
//
// This keeps wasm's evaluation order (pointer, then value) intact.
//
// Stack check: the shadow stack sits at [0, STACK_TOP) (wasm-ld --stack-first).
// An overflow makes __stack_pointer wrap to a huge value, which in the
// ordinary build traps as out of bounds but here would be a valid *virtual*
// address. So every `global.set $__stack_pointer` is checked and traps if the
// new value is above STACK_TOP.
//
// Functions named __vera_* are the MMU itself and are not instrumented.
// Traversal is iterative (explicit stack), so deeply nested code such as
// huge switch statements does not overflow the JS stack.

import binaryen from 'binaryen';

const b = binaryen;
const RUNTIME_PREFIX = '__vera_';
const HELPER_EXPORTS = [
  '__vera_tl', '__vera_ts',
  '__vera_ld_i32', '__vera_ld_i64', '__vera_ld_f32', '__vera_ld_f64',
  '__vera_st_i32', '__vera_st_i64', '__vera_st_f32', '__vera_st_f64',
];

// Expression kinds the paged model cannot support, with an explanation.
function forbiddenReason(id, { allowGrow = false } = {}) {
  switch (id) {
    case b.MemoryCopyId: case b.MemoryFillId: case b.MemoryInitId: case b.DataDropId:
      return 'bulk-memory instruction (build with -mcpu=mvp or -mno-bulk-memory)';
    case b.MemoryGrowId:
      return allowGrow ? null : 'memory.grow (the paged heap has a fixed physical memory; use malloc from vera-libc)';
    case b.AtomicRMWId: case b.AtomicCmpxchgId: case b.AtomicWaitId: case b.AtomicNotifyId:
    case b.AtomicFenceId:
      return 'atomics/threads are not supported yet';
    case b.SIMDExtractId: case b.SIMDReplaceId: case b.SIMDShuffleId: case b.SIMDTernaryId:
    case b.SIMDShiftId: case b.SIMDLoadId: case b.SIMDLoadStoreLaneId:
      return 'SIMD is not supported yet (build with -mno-simd128)';
    default:
      return null;
  }
}

function typeName(t) {
  if (t === b.i32) return 'i32';
  if (t === b.i64) return 'i64';
  if (t === b.f32) return 'f32';
  if (t === b.f64) return 'f64';
  return String(t);
}

// Child slots of an MVP expression as [get, set] pairs in evaluation order.
// Returns null for kinds this tool does not know.
function childSlots(e, id) {
  const one = (get, set) => [[() => get(e), (x) => set(e, x)]];
  switch (id) {
    case b.BlockId: {
      const out = [];
      const n = b.Block.getNumChildren(e);
      for (let i = 0; i < n; i++) out.push([() => b.Block.getChildAt(e, i), (x) => b.Block.setChildAt(e, i, x)]);
      return out;
    }
    case b.IfId: {
      const out = [
        [() => b.If.getCondition(e), (x) => b.If.setCondition(e, x)],
        [() => b.If.getIfTrue(e), (x) => b.If.setIfTrue(e, x)],
      ];
      if (b.If.getIfFalse(e)) out.push([() => b.If.getIfFalse(e), (x) => b.If.setIfFalse(e, x)]);
      return out;
    }
    case b.LoopId: return one(b.Loop.getBody, b.Loop.setBody);
    case b.BreakId: {
      const out = [];
      if (b.Break.getValue(e)) out.push([() => b.Break.getValue(e), (x) => b.Break.setValue(e, x)]);
      if (b.Break.getCondition(e)) out.push([() => b.Break.getCondition(e), (x) => b.Break.setCondition(e, x)]);
      return out;
    }
    case b.SwitchId: {
      const out = [];
      if (b.Switch.getValue(e)) out.push([() => b.Switch.getValue(e), (x) => b.Switch.setValue(e, x)]);
      out.push([() => b.Switch.getCondition(e), (x) => b.Switch.setCondition(e, x)]);
      return out;
    }
    case b.CallId: {
      const out = [];
      const n = b.Call.getNumOperands(e);
      for (let i = 0; i < n; i++) out.push([() => b.Call.getOperandAt(e, i), (x) => b.Call.setOperandAt(e, i, x)]);
      return out;
    }
    case b.CallIndirectId: {
      const out = [];
      const n = b.CallIndirect.getNumOperands(e);
      for (let i = 0; i < n; i++) out.push([() => b.CallIndirect.getOperandAt(e, i), (x) => b.CallIndirect.setOperandAt(e, i, x)]);
      out.push([() => b.CallIndirect.getTarget(e), (x) => b.CallIndirect.setTarget(e, x)]);
      return out;
    }
    case b.LocalSetId: return one(b.LocalSet.getValue, b.LocalSet.setValue);
    case b.GlobalSetId: return one(b.GlobalSet.getValue, b.GlobalSet.setValue);
    case b.LoadId: return one(b.Load.getPtr, b.Load.setPtr);
    case b.StoreId:
      return [[() => b.Store.getPtr(e), (x) => b.Store.setPtr(e, x)], [() => b.Store.getValue(e), (x) => b.Store.setValue(e, x)]];
    case b.UnaryId: return one(b.Unary.getValue, b.Unary.setValue);
    case b.BinaryId:
      return [[() => b.Binary.getLeft(e), (x) => b.Binary.setLeft(e, x)], [() => b.Binary.getRight(e), (x) => b.Binary.setRight(e, x)]];
    case b.SelectId:
      return [
        [() => b.Select.getIfTrue(e), (x) => b.Select.setIfTrue(e, x)],
        [() => b.Select.getIfFalse(e), (x) => b.Select.setIfFalse(e, x)],
        [() => b.Select.getCondition(e), (x) => b.Select.setCondition(e, x)],
      ];
    case b.DropId: return one(b.Drop.getValue, b.Drop.setValue);
    case b.ReturnId: return b.Return.getValue(e) ? one(b.Return.getValue, b.Return.setValue) : [];
    case b.MemoryGrowId: return one(b.MemoryGrow.getDelta, b.MemoryGrow.setDelta);
    case b.ConstId: case b.LocalGetId: case b.GlobalGetId: case b.NopId:
    case b.UnreachableId: case b.MemorySizeId:
      return [];
    default:
      return null;
  }
}

// Iterative post-order traversal. onEnter(e, id) may return false to skip
// the children; onExit(e, id) returns the expression to put in its place.
function transform(root, { onEnter = () => true, onExit = (e) => e, onUnknown = () => {} }) {
  if (!root) return root;
  let result = root;
  const stack = [{ e: root, id: b.getExpressionId(root), slots: null, i: 0, set: null }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.slots === null) {
      top.slots = onEnter(top.e, top.id) === false ? [] : childSlots(top.e, top.id);
      if (top.slots === null) { onUnknown(top.id); top.slots = []; }
    }
    if (top.i < top.slots.length) {
      const [get, set] = top.slots[top.i++];
      const c = get();
      if (c) stack.push({ e: c, id: b.getExpressionId(c), slots: null, i: 0, set });
      continue;
    }
    stack.pop();
    const r = onExit(top.e, top.id);
    if (top.set) { if (r !== top.e) top.set(r); } else result = r;
  }
  return result;
}

function checkVbase(vbase) {
  if (!Number.isInteger(vbase) || vbase <= 0 || vbase >= 2 ** 32 || vbase % 65536 !== 0) {
    throw new Error(`instrument: vbase must be a non-zero multiple of 64 KiB below 4 GiB (got ${vbase})`);
  }
}

// unsafeTranslateFirstForTesting: deliberately break the store-ordering rule
// (translate the address before evaluating the value). Only the test suite
// uses it, to prove the differential tests can detect that bug.
export function instrument(bytes, { vbase = 0x10000000, optimize = true, unsafeTranslateFirstForTesting = false } = {}) {
  checkVbase(vbase);
  const m = b.readBinary(bytes);
  m.setFeatures(b.Features.MVP | b.Features.MutableGlobals);

  const report = {
    loadsFast: 0, storesFast: 0, storesWithTemps: 0, loadsSlow: 0, storesSlow: 0,
    skippedConst: 0, stackChecks: 0, functions: 0, runtimeFunctions: 0, remainingHelperCalls: 0,
    sharedTemps: 0, outOfLine: [],
  };

  if (!m.getFunction('__vera_tl') || !m.getFunction('__vera_ts')) {
    throw new Error('instrument: __vera_tl/__vera_ts not found by name. Link runtime/softmmu.c and keep the name section (do not strip).');
  }
  if (!m.getFunction('__vera_trap')) throw new Error('instrument: the __vera_trap import is missing (link runtime/softmmu.c)');

  // Shadow stack: with --stack-first it occupies [0, initial __stack_pointer).
  const spGlobal = m.getGlobal('__stack_pointer');
  let spName = null, stackTop = 0;
  if (spGlobal) {
    const gi = b.getGlobalInfo(spGlobal);
    spName = gi.name;
    stackTop = b.getExpressionInfo(gi.init).value >>> 0;
  }
  report.stackTop = stackTop;

  const errors = [];
  let curFunc = null;
  let curName = '';

  // Can evaluating e touch memory (and so fault)? Iterative, like the walk.
  const isMemoryFree = (root) => {
    const todo = [root];
    while (todo.length) {
      const e = todo.pop();
      switch (b.getExpressionId(e)) {
        case b.ConstId: case b.LocalGetId: case b.GlobalGetId:
          break;
        case b.UnaryId: todo.push(b.Unary.getValue(e)); break;
        case b.BinaryId: todo.push(b.Binary.getLeft(e), b.Binary.getRight(e)); break;
        case b.SelectId: todo.push(b.Select.getIfTrue(e), b.Select.getIfFalse(e), b.Select.getCondition(e)); break;
        case b.LocalSetId: todo.push(b.LocalSet.getValue(e)); break; // local.tee
        default: return false;
      }
    }
    return true;
  };

  // Does evaluating e run a store? (Rewritten stores keep their Store node.)
  const containsStore = (root) => {
    const todo = [root];
    while (todo.length) {
      const e = todo.pop();
      if (!e) continue;
      const id = b.getExpressionId(e);
      if (id === b.StoreId) return true;
      const slots = childSlots(e, id);
      if (slots === null) return true; // unknown kind: assume the worst
      for (const [get] of slots) todo.push(get());
    }
    return false;
  };

  // Temps for ordered stores. A store whose operands run no other store
  // (almost all of them) uses one shared pair per function: nothing can
  // overwrite the pair between its local.set and the store. Others get fresh
  // temps. Without sharing, a 6000-case switch had 12000 locals, which made
  // binaryen's optimizer take minutes.
  let shared = new Map(); // reset per function
  const sharedTemp = (key, type) => {
    if (!shared.has(key)) shared.set(key, b._BinaryenFunctionAddVar(curFunc, type));
    return shared.get(key);
  };

  const constIdentity = (ptr, offset) => {
    if (b.getExpressionId(ptr) !== b.ConstId) return false;
    const v = b.getExpressionInfo(ptr).value >>> 0;
    return v + offset < vbase;
  };

  const addrOf = (ptr, offset) => (offset ? m.i32.add(ptr, m.i32.const(offset | 0)) : ptr);

  function rewriteLoad(e) {
    const info = b.getExpressionInfo(e);
    if (info.isAtomic) { errors.push(`${curName}: atomics/threads are not supported yet`); return e; }
    if (info.type === b.v128) { errors.push(`${curName}: SIMD is not supported yet (build with -mno-simd128)`); return e; }
    const { ptr, offset, bytes: n, align, isSigned, type } = info;
    if (constIdentity(ptr, offset)) { report.skippedConst++; return e; }
    const addr = addrOf(ptr, offset);
    if (align >= n) {
      b.Load.setPtr(e, m.call('__vera_tl', [addr, m.i32.const(n)], b.i32));
      b.Load.setOffset(e, 0);
      report.loadsFast++;
      return e;
    }
    report.loadsSlow++;
    if (type === b.i32) return m.call('__vera_ld_i32', [addr, m.i32.const(n), m.i32.const(isSigned ? 1 : 0)], b.i32);
    if (type === b.i64) return m.call('__vera_ld_i64', [addr, m.i32.const(n), m.i32.const(isSigned ? 1 : 0)], b.i64);
    if (type === b.f32) return m.call('__vera_ld_f32', [addr], b.f32);
    if (type === b.f64) return m.call('__vera_ld_f64', [addr], b.f64);
    errors.push(`${curName}: unsupported load type ${typeName(type)}`);
    return e;
  }

  function rewriteStore(e) {
    const info = b.getExpressionInfo(e);
    if (info.isAtomic) { errors.push(`${curName}: atomics/threads are not supported yet`); return e; }
    if (info.valueType === b.v128) { errors.push(`${curName}: SIMD is not supported yet (build with -mno-simd128)`); return e; }
    const { ptr, value, offset, bytes: n, align, valueType } = info;
    if (constIdentity(ptr, offset)) { report.skippedConst++; return e; }
    const addr = addrOf(ptr, offset);
    if (align < n) {
      report.storesSlow++;
      if (valueType === b.i32) return m.call('__vera_st_i32', [addr, m.i32.const(n), value], b.none);
      if (valueType === b.i64) return m.call('__vera_st_i64', [addr, m.i32.const(n), value], b.none);
      if (valueType === b.f32) return m.call('__vera_st_f32', [addr, value], b.none);
      if (valueType === b.f64) return m.call('__vera_st_f64', [addr, value], b.none);
      errors.push(`${curName}: unsupported store type ${typeName(valueType)}`);
      return e;
    }
    report.storesFast++;
    if (isMemoryFree(value)) {
      // Value cannot fault: translate while evaluating the pointer operand.
      b.Store.setPtr(e, m.call('__vera_ts', [addr, m.i32.const(n)], b.i32));
      b.Store.setOffset(e, 0);
      return e;
    }
    // Value may fault: evaluate pointer, then value, then translate.
    report.storesWithTemps++;
    let tp, tv;
    if (containsStore(ptr) || containsStore(value)) {
      tp = b._BinaryenFunctionAddVar(curFunc, b.i32);
      tv = b._BinaryenFunctionAddVar(curFunc, valueType);
    } else {
      report.sharedTemps++;
      tp = sharedTemp('ptr', b.i32);
      tv = sharedTemp(`value ${valueType}`, valueType);
    }
    if (unsafeTranslateFirstForTesting) { // the bug the ordering rule prevents
      b.Store.setPtr(e, m.local.get(tp, b.i32));
      b.Store.setValue(e, m.local.get(tv, valueType));
      b.Store.setOffset(e, 0);
      return m.block(null, [m.local.set(tp, m.call('__vera_ts', [addr, m.i32.const(n)], b.i32)), m.local.set(tv, value), e], b.none);
    }
    b.Store.setPtr(e, m.call('__vera_ts', [m.local.get(tp, b.i32), m.i32.const(n)], b.i32));
    b.Store.setValue(e, m.local.get(tv, valueType));
    b.Store.setOffset(e, 0);
    return m.block(null, [m.local.set(tp, addr), m.local.set(tv, value), e], b.none);
  }

  function stackCheck(e) {
    const value = b.GlobalSet.getValue(e);
    const t = b._BinaryenFunctionAddVar(curFunc, b.i32);
    report.stackChecks++;
    return m.block(null, [
      m.local.set(t, value),
      m.if(m.i32.gt_u(m.local.get(t, b.i32), m.i32.const(stackTop | 0)),
        m.call('__vera_trap', [m.i32.const(2), m.local.get(t, b.i32)], b.none)),
      m.global.set(spName, m.local.get(t, b.i32)),
    ], b.none);
  }

  const hooks = {
    onEnter: (e, id) => {
      const why = forbiddenReason(id);
      if (why) { errors.push(`${curName}: ${why}`); return false; }
      return true;
    },
    onExit: (e, id) => {
      if (id === b.LoadId) return rewriteLoad(e);
      if (id === b.StoreId) return rewriteStore(e);
      if (id === b.GlobalSetId && spName && b.GlobalSet.getName(e) === spName) return stackCheck(e);
      return e;
    },
    onUnknown: (id) => errors.push(`${curName}: unsupported expression kind ${id} (only MVP wasm is supported)`),
  };

  // Inlining the translation into a function with many hundreds of memory
  // accesses makes binaryen's optimizer superlinear (1000 accesses: ~70 s at
  // -O3). Such functions call out-of-line copies of the helpers instead; the
  // copies are marked no-inline. Correctness is the same, each access costs a
  // call.
  const OUT_OF_LINE_SITES = 400;
  const outOfLine = { onExit: (e, id) => {
    if (id === b.CallId) {
      const t = b.Call.getTarget(e);
      if (t === '__vera_tl' || t === '__vera_ts') b.Call.setTarget(e, `${t}_call`);
    }
    return e;
  } };

  for (let i = 0; i < m.getNumFunctions(); i++) {
    const f = m.getFunctionByIndex(i);
    const fi = b.getFunctionInfo(f);
    if (fi.module) continue; // imported
    if (fi.name.startsWith(RUNTIME_PREFIX)) { report.runtimeFunctions++; continue; }
    report.functions++;
    curFunc = f;
    curName = fi.name;
    shared = new Map();
    const before = report.loadsFast + report.storesFast;
    let body = transform(fi.body, hooks);
    if (optimize && report.loadsFast + report.storesFast - before > OUT_OF_LINE_SITES) {
      body = transform(body, outOfLine);
      report.outOfLine.push(fi.name);
    }
    b.Function.setBody(f, body);
  }
  if (report.outOfLine.length) {
    const params = b.createType([b.i32, b.i32]);
    for (const h of ['__vera_tl', '__vera_ts']) {
      m.addFunction(`${h}_call`, params, b.i32, [], m.call(h, [m.local.get(0, b.i32), m.local.get(1, b.i32)], b.i32));
    }
    for (const h of ['__vera_tl_call', '__vera_ts_call']) {
      b.setPassArgument('no-inline', h); // exact names (a '?' pattern did not match)
      m.runPasses(['no-inline']);
    }
    b.setPassArgument('no-inline', null);
  }

  if (errors.length) {
    const uniq = [...new Set(errors)];
    throw new Error(`instrument: module uses features WebSwap cannot page:\n  ${uniq.slice(0, 20).join('\n  ')}`);
  }

  for (const name of HELPER_EXPORTS) {
    if (m.getExport(name)) m.removeExport(name);
  }

  if (!m.validate()) throw new Error('instrument: output failed validation');

  if (optimize) {
    b.setOptimizeLevel(3);
    b.setShrinkLevel(0);
    b.setZeroFilledMemory(true); // our Memory is always fresh (all zeros)
    b.setAlwaysInlineMaxSize(64);
    b.setFlexibleInlineMaxSize(200);
    m.optimize();
    if (!m.validate()) throw new Error('instrument: optimized output failed validation');
  }

  // How many translate calls survived inlining (0 is ideal; -1 = could not tell).
  let remaining = 0;
  for (let i = 0; i < m.getNumFunctions() && remaining >= 0; i++) {
    const fi = b.getFunctionInfo(m.getFunctionByIndex(i));
    if (fi.module || fi.name.startsWith(RUNTIME_PREFIX)) continue;
    transform(fi.body, {
      onExit: (e, id) => {
        if (id === b.CallId) {
          const t = b.Call.getTarget(e);
          if (t === '__vera_tl' || t === '__vera_ts') remaining++;
        }
        return e;
      },
      onUnknown: () => { remaining = -1; },
    });
  }
  report.remainingHelperCalls = remaining;

  // Layout facts the runtime needs before instantiation (memory size).
  const heapExport = m.getExport('__heap_base');
  if (!heapExport) throw new Error('instrument: __heap_base is not exported (link with --export=__heap_base)');
  const heapGlobal = m.getGlobal(b.getExportInfo(heapExport).value);
  const heapBase = b.getExpressionInfo(b.getGlobalInfo(heapGlobal).init).value >>> 0;
  const mem = m.getMemoryInfo();
  const layout = {
    format: 'vera-webswap/1', vbase: vbase >>> 0, pageSize: 4096,
    nvp: Math.floor((2 ** 32 - (vbase >>> 0)) / 4096), heapBase, minPages: mem.initial,
  };
  if (heapBase >= vbase) throw new Error(`instrument: static data/stack/page table end at 0x${heapBase.toString(16)}, above VBASE`);
  m.addCustomSection('vera.layout', new TextEncoder().encode(JSON.stringify(layout)));
  report.layout = layout;

  b.setDebugInfo(true); // keep function names: readable stack traces when a program traps
  const binary = m.emitBinary();
  b.setDebugInfo(false);
  m.dispose();
  return { binary, report };
}

// Validate a baseline (non-paged) module: same restrictions except memory.grow.
export function checkFeatures(bytes) {
  const m = b.readBinary(bytes);
  const bad = new Set();
  for (let i = 0; i < m.getNumFunctions(); i++) {
    const fi = b.getFunctionInfo(m.getFunctionByIndex(i));
    if (fi.module) continue;
    transform(fi.body, {
      onEnter: (e, id) => {
        const why = forbiddenReason(id, { allowGrow: true });
        if (why) bad.add(why);
        if (id === b.LoadId || id === b.StoreId) {
          const info = b.getExpressionInfo(e);
          if (info.isAtomic) bad.add('atomics');
          if (info.type === b.v128 || info.valueType === b.v128) bad.add('SIMD');
        }
        return !why;
      },
      onUnknown: (id) => bad.add(`unsupported expression kind ${id}`),
    });
  }
  m.dispose();
  return [...bad];
}
