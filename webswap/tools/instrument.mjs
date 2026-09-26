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
// Functions named __vera_* are the MMU itself and are not instrumented.

import binaryen from 'binaryen';

const b = binaryen;
const RUNTIME_PREFIX = '__vera_';
const HELPER_EXPORTS = [
  '__vera_tl', '__vera_ts',
  '__vera_ld_i32', '__vera_ld_i64', '__vera_ld_f32', '__vera_ld_f64',
  '__vera_st_i32', '__vera_st_i64', '__vera_st_f32', '__vera_st_f64',
];

// Expression kinds the paged model cannot support, with an explanation.
function forbiddenReason(id) {
  switch (id) {
    case b.MemoryCopyId: case b.MemoryFillId: case b.MemoryInitId: case b.DataDropId:
      return 'bulk-memory instruction (build with -mcpu=mvp or -mno-bulk-memory)';
    case b.MemoryGrowId:
      return 'memory.grow (the paged heap has a fixed physical memory; use malloc from vera-libc)';
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

export function instrument(bytes, { vbase = 0x10000000, optimize = true } = {}) {
  const m = b.readBinary(bytes);
  m.setFeatures(b.Features.MVP | b.Features.MutableGlobals);

  const report = {
    loadsFast: 0, storesFast: 0, storesWithTemps: 0, loadsSlow: 0, storesSlow: 0,
    skippedConst: 0, functions: 0, runtimeFunctions: 0, remainingHelperCalls: 0,
  };

  if (!m.getFunction('__vera_tl') || !m.getFunction('__vera_ts')) {
    throw new Error('instrument: __vera_tl/__vera_ts not found by name. Link runtime/softmmu.c and keep the name section (do not strip).');
  }

  const errors = [];
  let curFunc = null;
  let curName = '';

  const isMemoryFree = (e) => {
    const id = b.getExpressionId(e);
    switch (id) {
      case b.ConstId: case b.LocalGetId: case b.GlobalGetId:
        return true;
      case b.UnaryId:
        return isMemoryFree(b.Unary.getValue(e));
      case b.BinaryId:
        return isMemoryFree(b.Binary.getLeft(e)) && isMemoryFree(b.Binary.getRight(e));
      case b.SelectId:
        return isMemoryFree(b.Select.getIfTrue(e)) && isMemoryFree(b.Select.getIfFalse(e))
          && isMemoryFree(b.Select.getCondition(e));
      case b.LocalSetId: // local.tee
        return isMemoryFree(b.LocalSet.getValue(e));
      default:
        return false;
    }
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
    const tp = b._BinaryenFunctionAddVar(curFunc, b.i32);
    const tv = b._BinaryenFunctionAddVar(curFunc, valueType);
    b.Store.setPtr(e, m.call('__vera_ts', [m.local.get(tp, b.i32), m.i32.const(n)], b.i32));
    b.Store.setValue(e, m.local.get(tv, valueType));
    b.Store.setOffset(e, 0);
    return m.block(null, [m.local.set(tp, addr), m.local.set(tv, value), e], b.none);
  }

  // Post-order walk; returns the (possibly replaced) expression.
  function walk(e) {
    if (!e) return e;
    const id = b.getExpressionId(e);
    const why = forbiddenReason(id);
    if (why) { errors.push(`${curName}: ${why}`); return e; }
    switch (id) {
      case b.BlockId: {
        const n = b.Block.getNumChildren(e);
        for (let i = 0; i < n; i++) b.Block.setChildAt(e, i, walk(b.Block.getChildAt(e, i)));
        return e;
      }
      case b.IfId:
        b.If.setCondition(e, walk(b.If.getCondition(e)));
        b.If.setIfTrue(e, walk(b.If.getIfTrue(e)));
        if (b.If.getIfFalse(e)) b.If.setIfFalse(e, walk(b.If.getIfFalse(e)));
        return e;
      case b.LoopId:
        b.Loop.setBody(e, walk(b.Loop.getBody(e)));
        return e;
      case b.BreakId:
        if (b.Break.getValue(e)) b.Break.setValue(e, walk(b.Break.getValue(e)));
        if (b.Break.getCondition(e)) b.Break.setCondition(e, walk(b.Break.getCondition(e)));
        return e;
      case b.SwitchId:
        if (b.Switch.getValue(e)) b.Switch.setValue(e, walk(b.Switch.getValue(e)));
        b.Switch.setCondition(e, walk(b.Switch.getCondition(e)));
        return e;
      case b.CallId: {
        const n = b.Call.getNumOperands(e);
        for (let i = 0; i < n; i++) b.Call.setOperandAt(e, i, walk(b.Call.getOperandAt(e, i)));
        return e;
      }
      case b.CallIndirectId: {
        const n = b.CallIndirect.getNumOperands(e);
        for (let i = 0; i < n; i++) b.CallIndirect.setOperandAt(e, i, walk(b.CallIndirect.getOperandAt(e, i)));
        b.CallIndirect.setTarget(e, walk(b.CallIndirect.getTarget(e)));
        return e;
      }
      case b.LocalSetId:
        b.LocalSet.setValue(e, walk(b.LocalSet.getValue(e)));
        return e;
      case b.GlobalSetId:
        b.GlobalSet.setValue(e, walk(b.GlobalSet.getValue(e)));
        return e;
      case b.LoadId:
        b.Load.setPtr(e, walk(b.Load.getPtr(e)));
        return rewriteLoad(e);
      case b.StoreId:
        b.Store.setPtr(e, walk(b.Store.getPtr(e)));
        b.Store.setValue(e, walk(b.Store.getValue(e)));
        return rewriteStore(e);
      case b.UnaryId:
        b.Unary.setValue(e, walk(b.Unary.getValue(e)));
        return e;
      case b.BinaryId:
        b.Binary.setLeft(e, walk(b.Binary.getLeft(e)));
        b.Binary.setRight(e, walk(b.Binary.getRight(e)));
        return e;
      case b.SelectId:
        b.Select.setIfTrue(e, walk(b.Select.getIfTrue(e)));
        b.Select.setIfFalse(e, walk(b.Select.getIfFalse(e)));
        b.Select.setCondition(e, walk(b.Select.getCondition(e)));
        return e;
      case b.DropId:
        b.Drop.setValue(e, walk(b.Drop.getValue(e)));
        return e;
      case b.ReturnId:
        if (b.Return.getValue(e)) b.Return.setValue(e, walk(b.Return.getValue(e)));
        return e;
      case b.ConstId: case b.LocalGetId: case b.GlobalGetId: case b.NopId:
      case b.UnreachableId: case b.MemorySizeId:
        return e;
      default:
        errors.push(`${curName}: unsupported expression kind ${id} (only MVP wasm is supported)`);
        return e;
    }
  }

  for (let i = 0; i < m.getNumFunctions(); i++) {
    const f = m.getFunctionByIndex(i);
    const fi = b.getFunctionInfo(f);
    if (fi.module) continue; // imported
    if (fi.name.startsWith(RUNTIME_PREFIX)) { report.runtimeFunctions++; continue; }
    report.functions++;
    curFunc = f;
    curName = fi.name;
    b.Function.setBody(f, walk(fi.body));
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

  // How many translate calls survived inlining (0 is ideal).
  const text = m.emitText();
  report.remainingHelperCalls = (text.match(/\(call \$__vera_t[ls]\b/g) || []).length;

  // Layout facts the runtime needs before instantiation (memory size).
  const heapExport = m.getExport('__heap_base');
  if (!heapExport) throw new Error('instrument: __heap_base is not exported (link with -Wl,--export=__heap_base)');
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

  const binary = m.emitBinary();
  m.dispose();
  return { binary, report };
}

// Validate a baseline (non-paged) module: same restrictions except memory.grow.
export function checkFeatures(bytes) {
  const m = b.readBinary(bytes);
  const text = m.emitText();
  m.dispose();
  const bad = [];
  for (const [re, why] of [
    [/\bmemory\.(copy|fill|init)\b|\bdata\.drop\b/, 'bulk-memory'],
    [/\bv128\./, 'SIMD'],
    [/\.atomic\./, 'atomics'],
  ]) if (re.test(text)) bad.push(why);
  return bad;
}
