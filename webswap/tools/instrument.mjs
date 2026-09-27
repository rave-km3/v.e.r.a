// instrument.mjs - rewrite every load/store of a wasm32 module so it goes
// through the WebSwap software MMU (runtime/softmmu.c).
//
//   aligned load   (align >= size)  : T.load  offset=0 (translate(ptr + offset, size))
//   aligned store                   : T.store offset=0 (translate(ptr + offset, size)) value
//   possibly unaligned load / store : call __vera_ld_T / __vera_st_T (byte-wise, page-crossing safe)
//   aligned accesses sharing a base : one translation for the group (see "Same-base merging")
//
// translate() is the fast path of __vera_tl/__vera_ts, emitted inline (see
// "Inline translation"), with a software TLB in front of it for accesses
// that stream through memory inside a loop. Functions with very many
// accesses call out-of-line copies of __vera_tl/__vera_ts instead (see
// OUT_OF_LINE_SITES).
//
// Ordering rule for stores: a translated address is only valid until the next
// page fault, because the fault may evict that frame. So when the stored value
// itself may touch memory (and therefore fault), we evaluate pointer and value
// into fresh locals first and translate the pointer last:
//
//   (local.set $p ptr+offset) (local.set $v value) (T.store (translate $p) $v)
//
// This keeps wasm's evaluation order (pointer, then value) intact.
//
// Stack check: the shadow stack sits at [0, STACK_TOP) (wasm-ld --stack-first).
// An overflow makes __stack_pointer wrap to a huge value, which in the
// ordinary build traps as out of bounds but here would be a valid *virtual*
// address. So every `global.set $__stack_pointer` is checked and traps if the
// new value is above STACK_TOP.
//
// Same-base merging: code often makes several accesses through one base
// pointer - struct fields p->a, p->b; an unrolled loop's a[i], a[i+1], ...;
// the read-modify-write x[i] += y. When a run of block children makes no
// call, has no loop, makes no other translated access, and does not change
// the base's locals before an access reads them, nothing can fault between
// the first and the last of those accesses except their own translations.
// So one translation of the whole byte range, done before the run, serves
// all of them (with a store in the group it is a write translation, which
// serves the loads too). The range may cross a page even when no single
// access does (a struct straddling two pages), so:
//
//   (if (local.tee $ph (translate-group base+min span))   ;; 0 = crosses a page
//     (then  the run, each access at (local.get $ph) offset=(its offset - min))
//     (else  a copy of the run, translated per access, out of line))
//
// (translate-group is __vera_tlg/__vera_tsg, emitted inline like translate.)
// If every access in the group has the same address and size (the
// read-modify-write case), the range crosses a page only when each access
// does, and the first one traps anyway: then a plain translate() is used
// and there is no copy. Forward branches are allowed in a group of loads
// only (see mergeBlock).
// The translation is done before the run, where the program has not
// touched the group's page yet. That is only the same as translating at the
// first access if that access is sure to run and nothing observable (a
// store below VBASE, a global.set, a possible trap) happens before it.
// Otherwise (a branch or a side effect comes first) the group uses a peek
// (__vera_tl_peek/__vera_ts_peek): it never faults or traps, and gives 0,
// so the fallback copy runs, also when the page is not mapped (for a store:
// not writable). Else the program could fault a page it never touches, on
// every call (`if (mode == 1) t = p->a; ...`), or fail in a fault (a storage
// error) before a side effect that comes first in program order.
// Merging runs first; the TLB below then treats a group's translation like
// one access at the group's address.
//
// Inline translation: the same shape as __vera_tl/__vera_ts in softmmu.c
// (and the same code after optimization): the entry is read with the biased
// page-table index ((a >> 10) & 0x3ffffc) + (pt - VBASE / 1024), and one rare
// branch (entry missing / not writable, or the access crosses a page) calls
// the no-inline __vera_tl_slow/__vera_ts_slow, which faults or traps and
// returns the entry:
//
//   a < VBASE ? a : (e = PTE(a); if (rare) e = slow(a, n); (e & ~0xfff) | (a & 0xfff))
//
// Software TLB: inside a loop, accesses whose address moves by constant steps
// (a[i], *p++, row + x) and look alike (same base, different constant offset:
// a[i] and a[i + 1]) share an entry that caches their last translation: one
// i64 local holding the virtual page base vb (low half) and the frame base fb
// (high half):
//
//   d = a - vb;  if (d <u 4097 - n) phys = fb + d   // hit: no page-table load
//   else translate as above and refill the entry
//
// The unsigned compare also proves the access stays inside the page, so a hit
// needs no page-crossing check (for a group, n is its span). 0 is the empty
// entry: it maps page 0 to itself, which is right because low memory is
// identity-mapped, and it is what every wasm local starts as. Identity pages
// (stack, data) are cached as well, with fb = vb.
// A cached translation is only valid until the next page fault: the fault may
// evict or unmap any page (the pager's CLOCK samples references by unmapping
// resident pages). The pager only changes the page table inside a fault, or
// from host code reached through an import call, so a function's entries are
// emptied in the slow branch of every translation in it (each call to a slow
// path, single or group), after every call it makes (a callee, an import, a
// byte-wise helper or the out-of-line translation of a merged group's
// fallback copy may fault), and before each loop that owns entries. No epoch
// is needed: an entry never survives a fault, so the first access after any
// fault walks the current page table again, which also keeps CLOCK's
// reference sampling as it was (hits between two faults are never seen by
// the pager, with or without the TLB). A store entry is only filled from a
// writable (dirty) page table entry; the pager only makes a page clean again
// in flush(), which runs between calls into the program or inside an import
// call (the entries are emptied when the call returns).
//
// Functions named __vera_* are the MMU itself and are not instrumented.
// Traversal is iterative (explicit stack), so deeply nested code such as
// huge switch statements does not overflow the JS stack.

import binaryen from 'binaryen';

const b = binaryen;
const RUNTIME_PREFIX = '__vera_';
const HELPER_EXPORTS = [
  '__vera_tl', '__vera_ts', '__vera_tlg', '__vera_tsg', '__vera_tl_peek', '__vera_ts_peek', '__vera_pt_addr',
  '__vera_ld_i32', '__vera_ld_i64', '__vera_ld_f32', '__vera_ld_f64',
  '__vera_st_i32', '__vera_st_i64', '__vera_st_f32', '__vera_st_f64',
];
const TRANSLATE_HELPERS = ['__vera_tl', '__vera_ts', '__vera_tlg', '__vera_tsg', '__vera_tl_peek', '__vera_ts_peek'];
// Out-of-line rare paths of the helpers above (fault or trap); never inlined.
const SLOW_HELPERS = ['__vera_tl_slow', '__vera_ts_slow'];

// Most TLB entries (i64 locals) one loop gets: entries beyond what the engine
// keeps in registers only add spills. The groups with the most accesses are
// chosen first. The per-function limit bounds the code size (each slow
// branch empties every entry of the function).
const TLB_LOOP_ENTRIES = 4;
const TLB_MAX_ENTRIES = 32;
// Inlining the translation into a function with many hundreds of memory
// accesses makes binaryen's optimizer superlinear (1000 accesses: ~70 s at
// -O3). Such functions call out-of-line copies of the helpers instead; the
// copies are marked no-inline. Correctness is the same, each access costs a
// call. They get no TLB either, and no merged groups (the sites are
// counted after merging; see MAX_MERGED_ACCESSES).
const OUT_OF_LINE_SITES = 400;

// A merged group covers at most this many bytes. The chance that the range
// crosses a page, and the fallback copy runs, is about span / 4096.
const MAX_GROUP_SPAN = 256;
// ... and a run of statements at most this many expression nodes: this
// bounds the fallback copy (and the work spent looking at big statements).
const MAX_RUN_NODES = 1000;
// Merging puts every group's accesses in the function twice (the run and
// its fallback copy), and binaryen's -O3 gets very slow on big merged
// functions (8,000 merged accesses in one function: ~40 s, 7,000: 4 s).
// So a function whose merged form would call out of line anyway (more
// than OUT_OF_LINE_SITES sites after merging), or would merge more than
// this many accesses, is not merged at all.
const MAX_MERGED_ACCESSES = 4096;

// Expression kinds allowed in a run of merged accesses: nothing that can
// fault except the accesses themselves (no calls), and no loops (a later
// iteration could change the base before an access).
const STRAIGHT_LINE = new Set([
  b.ConstId, b.LocalGetId, b.LocalSetId, b.GlobalGetId, b.GlobalSetId, b.UnaryId, b.BinaryId,
  b.SelectId, b.DropId, b.LoadId, b.StoreId, b.NopId, b.BlockId, b.UnreachableId,
]);
// Forward branches are allowed too, in groups of loads only (see mergeBlock).
const BRANCHES = new Set([b.IfId, b.BreakId, b.SwitchId, b.ReturnId]);
// Operators that may trap (MVP: integer division, float-to-int truncation).
const TRAPPING_BINARY = new Set([
  b.DivSInt32, b.DivUInt32, b.RemSInt32, b.RemUInt32, b.DivSInt64, b.DivUInt64, b.RemSInt64, b.RemUInt64,
]);
const TRAPPING_UNARY = new Set([
  b.TruncSFloat32ToInt32, b.TruncSFloat32ToInt64, b.TruncUFloat32ToInt32, b.TruncUFloat32ToInt64,
  b.TruncSFloat64ToInt32, b.TruncSFloat64ToInt64, b.TruncUFloat64ToInt32, b.TruncUFloat64ToInt64,
]);

// i32 operators that cannot trap: an address built from locals, constants
// and these can be evaluated again (or earlier) with the same result.
const PURE_I32_BINARY = new Set([
  b.AddInt32, b.SubInt32, b.MulInt32, b.AndInt32, b.OrInt32, b.XorInt32,
  b.ShlInt32, b.ShrUInt32, b.ShrSInt32, b.RotLInt32, b.RotRInt32,
]);

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

// Peephole for the inlined translation, run after binaryen's optimizer:
//   load (i32.add (i32.and x M) (i32.const C)) -> load offset=C (i32.and x M)
// when M + C < 2^32. The sum cannot wrap then, so the address is the same,
// and the engine adds the offset inside the addressing mode instead of with
// an extra instruction. This is the shape of every inlined page-table lookup
// (PTE() in softmmu.c: ((a >> 10) & 0x3ffffc) + (pt - VBASE / 1024)), which
// binaryen does not fold by itself because in general an i32.add wraps and
// a load offset does not.
function foldLoadOffsets(m) {
  const constOf = (e) => (b.getExpressionId(e) === b.ConstId && b.getExpressionType(e) === b.i32
    ? b.getExpressionInfo(e).value >>> 0 : null);
  const isBin = (e, op) => b.getExpressionId(e) === b.BinaryId && b.Binary.getOp(e) === op;
  const hooks = {
    onExit: (e, id) => {
      if (id !== b.LoadId || b.Load.getOffset(e) !== 0 || b.Load.isAtomic(e)) return e;
      const p = b.Load.getPtr(e);
      if (!isBin(p, b.AddInt32)) return e;
      let x = b.Binary.getLeft(p), c = constOf(b.Binary.getRight(p));
      if (c === null) { c = constOf(x); x = b.Binary.getRight(p); }
      if (!c || !isBin(x, b.AndInt32)) return e;
      const mask = constOf(b.Binary.getRight(x)) ?? constOf(b.Binary.getLeft(x));
      if (mask === null || mask + c >= 2 ** 32) return e;
      b.Load.setPtr(e, x);
      b.Load.setOffset(e, c);
      return e;
    },
  };
  for (let i = 0; i < m.getNumFunctions(); i++) {
    const f = m.getFunctionByIndex(i);
    const fi = b.getFunctionInfo(f);
    if (fi.module) continue;
    b.Function.setBody(f, transform(fi.body, hooks));
  }
}

// Key of a pure i32 expression (locals, constants, PURE_I32_BINARY), adding
// the locals it reads to `locals`; null if it is anything else. Equal keys
// mean equal values as long as those locals are unchanged.
function pureKey(e, locals, depth = 0) {
  if (depth > 32) return null;
  switch (b.getExpressionId(e)) {
    case b.LocalGetId: {
      if (b.getExpressionType(e) !== b.i32) return null;
      const i = b.LocalGet.getIndex(e);
      locals.add(i);
      return `$${i}`;
    }
    case b.ConstId:
      return b.getExpressionType(e) === b.i32 ? `${b.Const.getValueI32(e)}` : null;
    case b.BinaryId: {
      const op = b.Binary.getOp(e);
      if (!PURE_I32_BINARY.has(op)) return null;
      const l = pureKey(b.Binary.getLeft(e), locals, depth + 1);
      const r = l === null ? null : pureKey(b.Binary.getRight(e), locals, depth + 1);
      return r === null ? null : `(${op} ${l} ${r})`;
    }
    default:
      return null;
  }
}

// Split a pure address into base terms + constant: ((a + b) + 4) and
// (b + (a - -4)) both give terms [a, b] and k = 4. Accesses whose bases have
// the same key differ only by a constant, known at build time.
function splitAddress(ptr) {
  const terms = [], locals = new Set();
  let k = 0;
  const todo = [ptr];
  while (todo.length) {
    const e = todo.pop();
    const id = b.getExpressionId(e);
    if (id === b.BinaryId && b.Binary.getOp(e) === b.AddInt32) {
      todo.push(b.Binary.getLeft(e), b.Binary.getRight(e));
    } else if (id === b.BinaryId && b.Binary.getOp(e) === b.SubInt32 && b.getExpressionId(b.Binary.getRight(e)) === b.ConstId) {
      k -= b.Const.getValueI32(b.Binary.getRight(e));
      todo.push(b.Binary.getLeft(e));
    } else if (id === b.ConstId && b.getExpressionType(e) === b.i32) {
      k += b.Const.getValueI32(e);
    } else {
      const key = pureKey(e, locals);
      if (key === null) return null;
      terms.push({ e, key });
    }
  }
  if (!terms.length) return null;
  terms.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return { key: terms.map((t) => t.key).join(' + '), terms: terms.map((t) => t.e), k, locals };
}

// The first-evaluated expression of a statement, if it is a local.tee:
// { tee, setter } where setter(x) puts x in the tee's place.
const LEFTMOST_PATH = new Set([b.StoreId, b.LoadId, b.LocalSetId, b.BinaryId, b.UnaryId, b.SelectId, b.DropId, b.GlobalSetId]);
function leftmostTee(stmt) {
  let e = stmt, setter = null;
  for (;;) {
    const id = b.getExpressionId(e);
    if (setter && id === b.LocalSetId && b.LocalSet.isTee(e)) return { tee: e, setter };
    if (!LEFTMOST_PATH.has(id)) return null;
    const [get, set] = childSlots(e, id)[0];
    setter = set;
    e = get();
  }
}

function checkVbase(vbase) {
  if (!Number.isInteger(vbase) || vbase <= 0 || vbase >= 2 ** 32 || vbase % 65536 !== 0) {
    throw new Error(`instrument: vbase must be a non-zero multiple of 64 KiB below 4 GiB (got ${vbase})`);
  }
}

// The i32 constant a function body returns, or null.
function constBody(e) {
  for (let i = 0; i < 4 && e; i++) {
    const id = b.getExpressionId(e);
    if (id === b.ConstId) return b.getExpressionInfo(e).value >>> 0;
    if (id === b.ReturnId) e = b.Return.getValue(e);
    else if (id === b.BlockId && b.Block.getNumChildren(e) === 1) e = b.Block.getChildAt(e, 0);
    else return null;
  }
  return null;
}

// The constant a function without parameters returns (the page table
// address in __vera_pt_addr), or null. Its body is only `return CONST` when
// clang optimizes and does not build position-independent code: -fPIC adds
// the (immutable, 0) __memory_base global, -O0 goes through locals. So
// binaryen evaluates a copy of the body (precompute folds immutable globals
// and locals), and the original is left alone.
function constResult(m, fn) {
  const fi = b.getFunctionInfo(fn);
  const direct = constBody(fi.body);
  if (direct !== null || fi.params !== b.none || fi.results !== b.i32) return direct;
  const probe = '__vera_const_probe';
  m.addFunction(probe, b.none, b.i32, fi.vars, m.copyExpression(fi.body));
  m.runPassesOnFunction(probe, ['precompute-propagate', 'simplify-locals', 'vacuum', 'merge-blocks', 'vacuum']);
  const value = constBody(b.getFunctionInfo(m.getFunction(probe)).body);
  m.removeFunction(probe);
  return value;
}

// merge: translate accesses that share a base pointer once (see the top of
// this file); false instruments every access on its own.
// tlb: false turns the software TLB off (every access walks the page table).
// unsafeTranslateFirstForTesting: deliberately break the store-ordering rule
// (translate the address before evaluating the value).
// unsafeMergeAcrossFaultsForTesting: deliberately let a merged group span
// accesses through other pointers, whose translations may evict the group's
// page.
// unsafeTlbSurvivesFaultsForTesting: deliberately keep TLB entries across
// faults and calls. Only the test suite uses these three, to prove the
// differential tests can detect those bugs.
export function instrument(bytes, {
  vbase = 0x10000000, optimize = true, merge = true, tlb: useTlb = true,
  unsafeTranslateFirstForTesting = false, unsafeMergeAcrossFaultsForTesting = false,
  unsafeTlbSurvivesFaultsForTesting = false,
} = {}) {
  checkVbase(vbase);
  const m = b.readBinary(bytes);
  m.setFeatures(b.Features.MVP | b.Features.MutableGlobals);

  // loads*/stores*/skippedConst count the program's accesses (merged ones
  // included, their fallback copies not); storesWithTemps and sharedTemps
  // count the ordered-store rewrites emitted, in fallback copies too.
  // What merging adds to the report (undone for a function it is taken back from).
  const MERGE_COUNTERS = ['mergedGroups', 'mergedAccesses', 'mergeFallbacks', 'mergePeeks', 'loadsFast', 'storesFast'];
  const report = {
    loadsFast: 0, storesFast: 0, storesWithTemps: 0, loadsSlow: 0, storesSlow: 0,
    skippedConst: 0, stackChecks: 0, functions: 0, runtimeFunctions: 0, remainingHelperCalls: 0,
    sharedTemps: 0, mergedGroups: 0, mergedAccesses: 0, mergeFallbacks: 0, mergePeeks: 0, unmerged: [], outOfLine: [],
    inlineFunctions: 0, tlbFunctions: 0, tlbEntries: 0, tlbSites: 0, tlbGroupSites: 0, tlbPeekSites: 0, warnings: [],
  };

  if (!m.getFunction('__vera_tl') || !m.getFunction('__vera_ts')) {
    throw new Error('instrument: __vera_tl/__vera_ts not found by name. Link runtime/softmmu.c and keep the name section (do not strip).');
  }
  if (!m.getFunction('__vera_trap')) throw new Error('instrument: the __vera_trap import is missing (link runtime/softmmu.c)');
  // Older runtimes (and hand-written test modules) have no group helpers or
  // peeks; without peeks, groups whose first access may not run are not made.
  const canMerge = merge && !!m.getFunction('__vera_tlg') && !!m.getFunction('__vera_tsg');
  const canPeek = canMerge && !!m.getFunction('__vera_tl_peek') && !!m.getFunction('__vera_ts_peek');

  // Shadow stack: with --stack-first it occupies [0, initial __stack_pointer).
  const spGlobal = m.getGlobal('__stack_pointer');
  let spName = null, stackTop = 0;
  if (spGlobal) {
    const gi = b.getGlobalInfo(spGlobal);
    spName = gi.name;
    stackTop = b.getExpressionInfo(gi.init).value >>> 0;
  }
  report.stackTop = stackTop;

  // The inline translation needs the page table's address (a constant in
  // __vera_pt_addr) and the out-of-line slow paths. Page table entry of an
  // address a >= VBASE: pt[(a - VBASE) >> 12], at byte address
  // ((a >> 10) & 0x3ffffc) + ptOff, ptOff = pt - VBASE / 1024 (u32: it may
  // wrap), as PTE() in softmmu.c. Without them (a module not linked with
  // runtime/softmmu.c of this version, e.g. a hand-written test module) every
  // access calls __vera_tl/__vera_ts (and binaryen inlines those). The same
  // happens, with a warning in the report, if the address cannot be read.
  let ptOff = null;
  const ptFn = m.getFunction('__vera_pt_addr');
  if (ptFn && SLOW_HELPERS.every((h) => m.getFunction(h))) {
    const pt = constResult(m, ptFn);
    if (pt !== null) ptOff = (pt - (vbase >>> 10)) >>> 0;
    else report.warnings.push('the page table address in __vera_pt_addr is not a constant: every access calls __vera_tl/__vera_ts (slower, no software TLB)');
  }

  // The helpers instrumented code calls (and the runtime functions they call)
  // must not use the shadow stack: a leaf function keeps its stack frame
  // below __stack_pointer without moving it, and after instrumentation it
  // calls these, whose own frame would then overwrite its locals. clang only
  // gives them a frame without optimization (softmmu.c built with -O0).
  if (spName) {
    const todo = [...HELPER_EXPORTS, ...SLOW_HELPERS].filter((h) => h !== '__vera_pt_addr' && m.getFunction(h));
    const done = new Set(todo);
    while (todo.length) {
      const name = todo.pop();
      const fi = b.getFunctionInfo(m.getFunction(name));
      if (fi.module) continue;
      transform(fi.body, {
        onEnter: (e, id) => {
          if ((id === b.GlobalGetId && b.GlobalGet.getName(e) === spName) || (id === b.GlobalSetId && b.GlobalSet.getName(e) === spName)) {
            throw new Error(`instrument: ${name} uses the shadow stack (__stack_pointer), which would overwrite the stack frames of leaf functions. Compile runtime/softmmu.c with optimization (-O2), as tools/vera-build.mjs does.`);
          }
          if (id === b.CallId) {
            const t = b.Call.getTarget(e);
            if (t.startsWith(RUNTIME_PREFIX) && !done.has(t)) { done.add(t); todo.push(t); }
          }
          return true;
        },
      });
    }
  }

  const errors = [];
  let curFunc = null;
  let curName = '';
  // How the current function translates (planFunction): mode 'inline' (the
  // inline walk, with TLB entries), 'call' (calls to __vera_tl/__vera_ts,
  // which binaryen inlines) or 'outOfLine' (calls to no-inline copies).
  let tlb = null;

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

  // ---- same-base merging (runs on a function before the per-access rewrite)
  let merged = new Set();    // accesses already served by a group translation
  let fallbacks = new Map(); // per-access fallback copy -> { branches }, in this function
  let groupCalls = new Map(); // group translation call -> { write, n (size or span), range, peek }
  let inFallback = null;     // the fallback copy being rewritten ({ branches }), or null
  // The report counts the program's accesses once: not again in the copies.
  const bump = (key) => { if (!inFallback) report[key]++; };

  // A load/store as a member of a group: 'neutral' if it is never translated
  // (constant address below VBASE), null if it cannot be merged (it would
  // translate or call on its own, so it may fault).
  function groupAccess(e, id) {
    const info = b.getExpressionInfo(e);
    const isStore = id === b.StoreId;
    if (info.isAtomic || (isStore ? info.valueType : info.type) === b.v128) return null;
    if (constIdentity(info.ptr, info.offset)) return 'neutral';
    if (info.align < info.bytes) return null; // byte-wise slow path
    const a = splitAddress(info.ptr);
    if (!a) return null;
    return { e, isStore, n: info.bytes, off: a.k + info.offset, key: a.key, locals: a.locals, terms: a.terms };
  }

  // What code does, in evaluation order (events): its groupable accesses (at
  // the point their address is read), its local writes, the points where
  // group stores are translated, its other side effects (stores below
  // VBASE, global.set, possible traps) and its branches (where the code
  // after may be skipped: a br/br_table/return, the start of an if arm).
  // ok = false if it cannot be part of a group: it calls, loops, makes an
  // access that is translated on its own or one with another base, or is
  // too big. branches = some of its accesses may be skipped.
  let blockSummary = new Map(); // per function: every block mergeBlock has done
  const newSummary = () => ({ ok: true, events: [], key: null, branches: false, stores: false, size: 0 });
  const NOT_OK = { ok: false, size: 0 };

  // Append summary t (of code that runs after s's code) to s. A group may
  // not have both a store and a branch, in either order (see mergeBlock).
  function append(s, t) {
    if (!s.ok) return;
    s.size += t.size;
    if (!t.ok || (s.key !== null && t.key !== null && s.key !== t.key) || s.size > MAX_RUN_NODES
      || ((s.branches || t.branches) && (s.stores || t.stores))) {
      s.ok = false;
      return;
    }
    for (const ev of t.events) s.events.push(ev);
    if (t.key !== null) s.key = t.key;
    s.branches ||= t.branches;
    s.stores ||= t.stores;
  }

  function summarize(root) {
    const s = newSummary();
    const groupStores = new Set();
    const arms = new Set(); // if arms: entered after the condition is evaluated
    transform(root, {
      onEnter: (e, id) => {
        if (!s.ok) return false;
        if (arms.has(e)) s.events.push({ branch: true });
        // Blocks are done bottom-up, so a nested block is summarized already:
        // deeply nested code (a huge switch) is not walked again and again.
        if (id === b.BlockId && blockSummary.has(e)) { append(s, blockSummary.get(e)); return false; }
        if (++s.size > MAX_RUN_NODES) { s.ok = false; return false; }
        if (BRANCHES.has(id)) {
          s.branches = true;
          if (s.stores) s.ok = false;
          if (id === b.IfId) {
            arms.add(b.If.getIfTrue(e));
            if (b.If.getIfFalse(e)) arms.add(b.If.getIfFalse(e));
          }
          return s.ok;
        }
        if (!STRAIGHT_LINE.has(id) || (id === b.GlobalSetId && b.GlobalSet.getName(e) === spName)) {
          s.ok = false; // a call, a loop, or the stack check's trap
          return false;
        }
        if (id === b.GlobalSetId || id === b.UnreachableId) s.events.push({ effect: true });
        if (id === b.LoadId || id === b.StoreId) {
          const a = groupAccess(e, id);
          if (a === 'neutral') {
            if (id === b.StoreId) s.events.push({ effect: true });
            return true;
          }
          if (unsafeMergeAcrossFaultsForTesting && (a === null || (s.key !== null && a.key !== s.key))) return true;
          if (a === null || (s.key !== null && a.key !== s.key) || (a.isStore && s.branches)) {
            s.ok = false;
            return false;
          }
          s.events.push(a);
          s.stores ||= a.isStore;
          s.key = a.key;
          if (a.isStore) groupStores.add(e);
        }
        return true;
      },
      onExit: (e, id) => {
        if (!s.ok) return e;
        if (id === b.LocalSetId) s.events.push({ write: b.LocalSet.getIndex(e) });
        // A store's address is read before its value, but it is translated
        // after (the ordering rule).
        if (id === b.StoreId && groupStores.has(e)) s.events.push({ translated: true });
        // Branches and traps happen after their operands are evaluated.
        if (id === b.BreakId || id === b.SwitchId || id === b.ReturnId) s.events.push({ branch: true });
        if ((id === b.BinaryId && TRAPPING_BINARY.has(b.Binary.getOp(e)))
          || (id === b.UnaryId && TRAPPING_UNARY.has(b.Unary.getOp(e)))) s.events.push({ effect: true });
        return e;
      },
    });
    return s;
  }

  // A copy of code with branches must not reuse the original's label names
  // (binaryen requires them to be unique in a function).
  let labelCount = 0;
  function copyWithFreshLabels(e) {
    const copy = m.copyExpression(e);
    const map = new Map();
    const fresh = (n) => (map.has(n) ? map.get(n) : n);
    transform(copy, {
      onEnter: (x, id) => {
        if (id === b.BlockId && b.Block.getName(x)) {
          const n = b.Block.getName(x);
          map.set(n, `${n}.vera${labelCount++}`);
          b.Block.setName(x, map.get(n));
        } else if (id === b.BreakId) {
          b.Break.setName(x, fresh(b.Break.getName(x)));
        } else if (id === b.SwitchId) {
          for (let i = 0; i < b.Switch.getNumNames(x); i++) b.Switch.setNameAt(x, i, fresh(b.Switch.getNameAt(x, i)));
          b.Switch.setDefaultName(x, fresh(b.Switch.getDefaultName(x)));
        }
        return true;
      },
    });
    return copy;
  }

  // Replace the statements 'run' (their accesses are 'group') by the merged
  // form, appended to 'out'. peek = the first access may not run, or comes
  // after a side effect: translate with a peek, which never faults.
  // branches = the run has branches (it may leave the fallback copy early).
  function emitGroup(run, group, peek, branches, out) {
    let lo = Infinity, hi = -Infinity;
    for (const a of group) { lo = Math.min(lo, a.off); hi = Math.max(hi, a.off + a.n); }
    const write = group.some((a) => a.isStore);
    // All accesses alike: the range crosses a page only when each access
    // does, and then the first one traps; so does this translation, at the
    // same address, in its place. No fallback copy is needed.
    const same = !peek && group.every((a) => a.off === group[0].off && a.n === group[0].n);
    const base = group[0].terms.map((t) => m.copyExpression(t)).reduce((x, y) => m.i32.add(x, y));
    const first = lo ? m.i32.add(base, m.i32.const(lo | 0)) : base;
    const fallback = same ? null : run.map(copyWithFreshLabels);
    const ph = sharedTemp('group', b.i32);
    for (const a of group) {
      const kind = a.isStore ? b.Store : b.Load;
      kind.setPtr(a.e, m.local.get(ph, b.i32));
      kind.setOffset(a.e, a.off - lo);
      merged.add(a.e);
      report[a.isStore ? 'storesFast' : 'loadsFast']++;
    }
    report.mergedGroups++;
    report.mergedAccesses += group.length;
    // The group's translation is a call to the C helper for now; the rewrite
    // (translateCall) replaces it with the inline form.
    if (same) {
      const call = m.call(write ? '__vera_ts' : '__vera_tl', [first, m.i32.const(group[0].n)], b.i32);
      groupCalls.set(call, { write, n: group[0].n, range: false });
      out.push(m.local.set(ph, call), ...run);
      return;
    }
    report.mergeFallbacks++;
    if (peek) report.mergePeeks++;
    const slow = m.block(null, fallback, b.none);
    fallbacks.set(slow, { branches });
    const helper = peek ? (write ? '__vera_ts_peek' : '__vera_tl_peek') : (write ? '__vera_tsg' : '__vera_tlg');
    const call = m.call(helper, [first, m.i32.const(hi - lo)], b.i32);
    groupCalls.set(call, { write, n: hi - lo, range: true, peek });
    out.push(m.if(m.local.tee(ph, call, b.i32), m.block(null, run, b.none), slow));
  }

  function mergeBlock(blk) {
    const kids = [];
    let changed = false, emitted = false;
    // '(store (local.tee $p X) (... (load $p) ...))' -> '(local.set $p X)
    // (store $p ...)': the tee is evaluated first, so this changes nothing,
    // but now $p is a plain base the whole statement can share.
    for (const c of b.Block.getChildren(blk)) {
      let t;
      while ((t = leftmostTee(c)) && b.getExpressionType(t.tee) === b.i32) {
        kids.push(m.local.set(b.LocalSet.getIndex(t.tee), b.LocalSet.getValue(t.tee)));
        t.setter(m.local.get(b.LocalSet.getIndex(t.tee), b.i32));
        changed = true;
      }
      kids.push(c);
    }
    const info = kids.map(summarize);
    const stmt = (i) => info[i].ok && b.getExpressionType(kids[i]) === b.none;
    const out = [];
    for (let i = 0; i < kids.length;) {
      const s = info[i];
      if (!stmt(i) || s.key === null) { out.push(kids[i++]); continue; }
      // Extend the run while the statements access only this base, the
      // base's locals are unchanged when an address is read, and the range
      // stays small. Forward branches are allowed in a group of loads (some
      // accesses may be skipped). A store in such a group could mark a page
      // dirty that is never written (a needless write-back), so groups with
      // stores stay straight-line. If a branch or a side effect (a store
      // below VBASE, a global.set, a possible trap) comes before the first
      // access, the group peeks (see the top of this file).
      const written = new Set(), group = [];
      let last = -1, lo = Infinity, hi = -Infinity, size = 0;
      let branches = false, stores = false, seen = false, peek = false;
      for (let j = i; j < kids.length; j++) {
        const t = info[j];
        if (!stmt(j) || (t.key !== null && t.key !== s.key) || (size += t.size) > MAX_RUN_NODES) break;
        if ((branches || t.branches) && (stores || t.stores)) break;
        let ok = true, tlo = lo, thi = hi;
        for (const ev of t.events) {
          if (ev.write !== undefined) { written.add(ev.write); continue; }
          if (ev.effect || ev.branch) {
            if (!seen) { if (canPeek) peek = true; else ok = false; }
            continue;
          }
          if (ev.translated) { seen = true; continue; }
          seen ||= !ev.isStore;
          for (const l of ev.locals) if (written.has(l)) ok = false;
          tlo = Math.min(tlo, ev.off);
          thi = Math.max(thi, ev.off + ev.n);
        }
        if (!ok || thi - tlo > MAX_GROUP_SPAN) break;
        branches ||= t.branches;
        stores ||= t.stores;
        if (t.key !== null) {
          last = j; lo = tlo; hi = thi;
          for (const ev of t.events) if (ev.e) group.push(ev);
        }
      }
      if (last < 0) { out.push(kids[i++]); continue; }
      const run = kids.slice(i, last + 1);
      if (group.length < 2) out.push(...run);
      else { emitGroup(run, group, peek, branches, out); changed = emitted = true; }
      i = last + 1;
    }
    if (changed) b.Block.setChildren(blk, out);
    // For the enclosing blocks: a block with a group now calls a translation.
    let sum = NOT_OK;
    if (!emitted) {
      sum = newSummary();
      sum.size = 1;
      for (const t of info) append(sum, t);
    }
    blockSummary.set(blk, sum);
    return changed;
  }

  // A statement that is not a block (a function body, an if arm or a loop
  // body that is one read-modify-write) is looked at as a block of one.
  function mergeStatement(e) {
    if (b.getExpressionId(e) === b.BlockId || b.getExpressionType(e) !== b.none) return e;
    const blk = m.block(null, [e], b.none);
    return mergeBlock(blk) ? blk : e;
  }

  function mergeGroups(body) {
    return mergeStatement(transform(body, {
      onExit: (e, id) => {
        if (id === b.BlockId) mergeBlock(e);
        else if (id === b.IfId) {
          b.If.setIfTrue(e, mergeStatement(b.If.getIfTrue(e)));
          if (b.If.getIfFalse(e)) b.If.setIfFalse(e, mergeStatement(b.If.getIfFalse(e)));
        } else if (id === b.LoopId) b.Loop.setBody(e, mergeStatement(b.Loop.getBody(e)));
        return e;
      },
    }));
  }

  // ---- inline translation and software TLB ------------------------------
  const isFastSite = (info, n) => !info.isAtomic && info.type !== b.v128 && info.valueType !== b.v128
    && info.align >= n && !constIdentity(info.ptr, info.offset);

  // Accesses of a function that would be translated inline (before merging).
  function countSites(body) {
    let n = 0;
    transform(body, {
      onEnter: (e, id) => {
        if (id === b.LoadId || id === b.StoreId) {
          const info = b.getExpressionInfo(e);
          if (isFastSite(info, info.bytes)) n++;
        }
        return true;
      },
    });
    return n;
  }

  // Plan one function (after merging, before the per-access rewrite): how it
  // translates (the mode, see `tlb` above), and in the inline mode which
  // translation sites share a TLB entry and which entries exist. Sites are
  // the accesses translated on their own and the merged groups' translations
  // (a group counts as one access at its first byte, of its span); the
  // per-access fallback copies call out of line and have no sites.
  // Entries belong to the innermost loop around their sites and are
  // emptied just before that loop starts, so an entry is dead outside its
  // loop: the engine keeps only the current loop's entries in registers,
  // instead of spilling every entry of the function in every loop. Sites
  // outside loops get no entry (it could never hit).
  // Within a loop, sites are grouped by a key describing the address
  // expression: its shape with constant offsets removed, a local.tee standing
  // for its local. So `p->key` and `p->val`, or `a[i]` and `a[i + 1]` share an
  // entry, while two row pointers of a stencil get one each. This is only a
  // heuristic for the hit rate: any grouping is correct, since a hit is
  // checked against the actual address.
  function planFunction(body) {
    let uniq = 0, fastSites = 0;
    const isConst = (x) => b.getExpressionId(x) === b.ConstId;
    const keyOf = (e, lim = 6) => {
      if (lim === 0) return `#${uniq++}`;
      switch (b.getExpressionId(e)) {
        case b.LocalGetId: return `L${b.LocalGet.getIndex(e)}`;
        case b.LocalSetId: return `L${b.LocalSet.getIndex(e)}`; // local.tee
        case b.GlobalGetId: return `G${b.GlobalGet.getName(e)}`;
        case b.ConstId: return `C${String(b.getExpressionInfo(e).value)}`;
        case b.BinaryId: {
          const op = b.Binary.getOp(e), l = b.Binary.getLeft(e), r = b.Binary.getRight(e);
          if ((op === b.AddInt32 || op === b.SubInt32) && isConst(r)) return keyOf(l, lim - 1);
          if (op === b.AddInt32 && isConst(l)) return keyOf(r, lim - 1);
          return `(${op} ${keyOf(l, lim - 1)} ${keyOf(r, lim - 1)})`;
        }
        case b.UnaryId: return `(u${b.Unary.getOp(e)} ${keyOf(b.Unary.getValue(e), lim - 1)})`;
        case b.LoadId: return `(ld${b.Load.getBytes(e)}.${b.Load.getOffset(e)} ${keyOf(b.Load.getPtr(e), lim - 1)})`;
        default: return `#${uniq++}`;
      }
    };
    // Which locals each loop changes: true = only by constant steps
    // (x = x + c: an induction variable), false = otherwise.
    const loops = []; // enclosing loops, innermost last
    const setsIn = new Map(); // loop -> Map(local index -> induction?)
    const stepOf = (e, i) => {
      if (b.getExpressionId(e) !== b.BinaryId) return false;
      const op = b.Binary.getOp(e), l = b.Binary.getLeft(e), r = b.Binary.getRight(e);
      const isX = (x) => b.getExpressionId(x) === b.LocalGetId && b.LocalGet.getIndex(x) === i;
      return (op === b.AddInt32 && ((isX(l) && isConst(r)) || (isConst(l) && isX(r)))) || (op === b.SubInt32 && isX(l) && isConst(r));
    };
    if (useTlb) transform(body, {
      onEnter: (e, id) => {
        if (id === b.LoopId) { loops.push(e); setsIn.set(e, new Map()); }
        if (id === b.LocalSetId) {
          const i = b.LocalSet.getIndex(e), step = stepOf(b.LocalSet.getValue(e), i);
          for (const l of loops) { const s = setsIn.get(l); s.set(i, (s.get(i) ?? true) && step); }
        }
        return true;
      },
      onExit: (e, id) => { if (id === b.LoopId) loops.pop(); return e; },
    });
    // Does the address move by constant steps per iteration of `loop` (or not
    // at all)? Only such sites get an entry: a[i], p++, row + x. Random
    // accesses (a[b[i]], hash probes, pointer chasing) would almost never
    // hit, and every entry costs a register across the whole loop.
    const streams = (e, loop, lim = 6) => {
      if (lim === 0) return false;
      switch (b.getExpressionId(e)) {
        case b.LocalGetId: return setsIn.get(loop).get(b.LocalGet.getIndex(e)) ?? true;
        case b.LocalSetId: return streams(b.LocalSet.getValue(e), loop, lim - 1); // local.tee
        case b.ConstId: return true;
        case b.BinaryId: {
          const op = b.Binary.getOp(e), l = b.Binary.getLeft(e), r = b.Binary.getRight(e);
          if (op === b.AddInt32 || op === b.SubInt32) return streams(l, loop, lim - 1) && streams(r, loop, lim - 1);
          if (op === b.ShlInt32 || op === b.MulInt32) return isConst(r) && streams(l, loop, lim - 1);
          return false;
        }
        default: return false;
      }
    };
    const sites = new Map(); // site (Load/Store or group translation call) -> group
    const groups = new Map(); // group -> { loop, weight }
    transform(body, {
      onEnter: (e, id) => {
        if (id === b.BlockId && fallbacks.has(e)) return false; // translated out of line
        if (id === b.LoopId) loops.push(e);
        let ptr, write;
        if (id === b.LoadId || id === b.StoreId) {
          const info = b.getExpressionInfo(e);
          if (merged.has(e) || !isFastSite(info, info.bytes)) return true;
          ptr = info.ptr;
          write = id === b.StoreId;
        } else if (id === b.CallId && groupCalls.has(e)) {
          ptr = b.Call.getOperandAt(e, 0);
          write = groupCalls.get(e).write;
        } else {
          return true;
        }
        fastSites++;
        if (!useTlb || !loops.length) return true;
        const loop = loops[loops.length - 1];
        if (!streams(ptr, loop)) return true;
        const g = `${write ? 's' : 'l'} ${loop} ${keyOf(ptr)}`;
        sites.set(e, g);
        if (!groups.has(g)) groups.set(g, { loop, weight: 0 });
        groups.get(g).weight += 16 ** Math.min(loops.length, 4);
        return true;
      },
      onExit: (e, id) => {
        if (id === b.LoopId) loops.pop();
        return e;
      },
    });
    const none = { entries: new Map(), perLoop: new Map(), all: [] };
    if (fastSites > OUT_OF_LINE_SITES) return { mode: optimize ? 'outOfLine' : 'call', ...none };
    if (ptOff === null) return { mode: 'call', ...none };
    const i32 = () => b._BinaryenFunctionAddVar(curFunc, b.i32);
    const entries = new Map(); // group -> entry (newEntry), with .sib
    const perLoop = new Map(); // loop -> its entries
    for (const [g, { loop }] of [...groups].sort((x, y) => y[1].weight - x[1].weight)) {
      const mine = perLoop.get(loop) || [];
      if (mine.length >= TLB_LOOP_ENTRIES || entries.size >= TLB_MAX_ENTRIES) continue;
      const ent = newEntry();
      entries.set(g, ent);
      mine.push(ent);
      perLoop.set(loop, mine);
    }
    // A load and a store entry of the same group fill each other on a miss
    // (a writable page is readable; a readable page may already be writable).
    for (const [g, ent] of entries) ent.sib = entries.get(`${g[0] === 's' ? 'l' : 's'}${g.slice(1)}`) || null;
    return { mode: 'inline', sites, entries, perLoop, all: [...entries.values()], a: i32(), d: i32(), e: i32() };
  }

  // One TLB entry: an i64 local, virtual page base in the low half and frame
  // base in the high half. One register per entry instead of two: loops with
  // several streams otherwise ran out of registers and spilled.
  function newEntry() {
    const x = b._BinaryenFunctionAddVar(curFunc, b.i64);
    const X = () => m.local.get(x, b.i64);
    return {
      vb: () => m.i32.wrap(X()),
      fb: () => m.i32.wrap(m.i64.shr_u(X(), m.i64.const(32n))),
      set: (vb, fb) => [m.local.set(x, m.i64.or(m.i64.extend_u(vb), m.i64.shl(m.i64.extend_u(fb), m.i64.const(32n))))],
      copyTo: (o) => [m.local.set(o.index, X())],
      reset: () => [m.local.set(x, m.i64.const(0n))],
      index: x,
    };
  }

  // Empty TLB entries: after a fault, or a call that may have faulted, no
  // cached translation can be trusted. Only the entries of the loops around
  // the current point need it: an entry is read only inside its loop, and
  // emptied before the loop starts, so another loop's entries are emptied
  // anyway before they are read again (wasm enters a loop only at its top).
  // That keeps the number of resets small (binaryen's optimizer slows down
  // with every one of them, even the dead ones it drops).
  const tlbReset = (list) => list.flatMap((x) => x.reset());
  const tlbInvalidate = () => (unsafeTlbSurvivesFaultsForTesting ? []
    : tlbReset(loopStack.flatMap((l) => tlb.perLoop.get(l) || [])));
  let loopStack = []; // loops around the expression being rewritten, per function

  // Run a call, then empty the TLB (the call may fault, or reach host code
  // that flushes pages).
  function afterCall(call, type) {
    if (!tlb.all.length || type === b.unreachable) return call;
    if (type === b.none) return m.block(null, [call, ...tlbInvalidate()], b.none);
    const t = sharedTemp(`call ${type}`, type);
    return m.block(null, [m.local.set(t, call), ...tlbInvalidate(), m.local.get(t, type)], type);
  }

  // The inline walk for the address in $a (at or above VBASE), leaving its
  // entry in $e: the fast path of __vera_tl/__vera_ts (softmmu.c) in the
  // shape clang gives it: if the access stays in its page (a test that is
  // left out for n = 1) and the entry is present (for a store: writable),
  // done; else one call to the out-of-line slow path, which faults or traps
  // and returns the entry - and after which no TLB entry can be trusted.
  let labelNo = 0;
  // The page table entry of the address in $a (at or above VBASE).
  function pte() {
    const idx = m.i32.and(m.i32.shr_u(m.local.get(tlb.a, b.i32), m.i32.const(10)), m.i32.const(0x3ffffc));
    return ptOff + 0x3ffffc < 2 ** 32 ? m.i32.load(ptOff, 4, idx) : m.i32.load(0, 4, m.i32.add(idx, m.i32.const(ptOff | 0)));
  }

  function walk(n, write) {
    const A = () => m.local.get(tlb.a, b.i32);
    const e = m.local.tee(tlb.e, pte(), b.i32);
    const ok = `vera.pte${labelNo++}`;
    const done = m.br(ok, write ? m.i32.and(e, m.i32.const(2)) : e);
    return m.block(ok, [
      n > 1 ? m.if(m.i32.le_u(m.i32.and(A(), m.i32.const(4095)), m.i32.const(4096 - n)), done) : done,
      m.local.set(tlb.e, m.call(write ? '__vera_ts_slow' : '__vera_tl_slow', [A(), m.i32.const(n)], b.i32)),
      ...tlbInvalidate(),
    ], b.none);
  }

  // A peek's lookup for the address in $a: its entry in $e if that is
  // present (for a store: writable), else leave block `label` with 0.
  function peekWalk(write, label) {
    const e = m.local.tee(tlb.e, pte(), b.i32);
    return m.drop(m.br(label, m.i32.eqz(write ? m.i32.and(e, m.i32.const(2)) : e), m.i32.const(0)));
  }

  // Physical address for an access of n bytes at `addr`: the inline form of
  // __vera_tl/__vera_ts (range = false), or of __vera_tlg/__vera_tsg
  // (range = true: n is the span of a merged group, and a range that crosses
  // a page gives 0, the group's cue to run its per-access fallback), or of
  // __vera_tl_peek/__vera_ts_peek (range and peek: 0 also where the others
  // would fault; no fault, so no TLB entry is emptied). site = the original
  // Load/Store or group call (its TLB group). $a, $d and $e are shared by
  // all translations of the function: a translation never starts another
  // one between setting and using them (addr is evaluated first).
  function translate(addr, n, write, site, range = false, peek = false) {
    if (tlb.mode !== 'inline' || inFallback) { // (fallback copies: out of line, see outOfLine)
      const helper = peek ? (write ? '__vera_ts_peek' : '__vera_tl_peek')
        : write ? (range ? '__vera_tsg' : '__vera_ts') : (range ? '__vera_tlg' : '__vera_tl');
      const call = m.call(helper, [addr, m.i32.const(n)], b.i32);
      // A fallback copy reads no TLB entry (it has no sites, calls and loops),
      // so one reset when it ends serves all its translations, unless a
      // branch may leave it early: then every translation is followed by one.
      return inFallback && inFallback.branches ? afterCall(call, b.i32) : call;
    }
    const A = () => m.local.get(tlb.a, b.i32), E = () => m.local.get(tlb.e, b.i32);
    const vb = m.i32.const(vbase | 0);
    const phys = () => m.i32.or(m.i32.and(E(), m.i32.const(-4096)), m.i32.and(A(), m.i32.const(4095)));
    // A group's range is known to stay in its page past this test, so its
    // walk checks a 1-byte access (no page-crossing test).
    const crosses = (otherwise) => (range
      ? m.if(m.i32.gt_u(m.i32.and(A(), m.i32.const(4095)), m.i32.const(4096 - n)), m.i32.const(0), otherwise)
      : otherwise);
    const wn = range ? 1 : n;
    const label = peek ? `vera.peek${labelNo++}` : null;
    const lookup = () => (peek ? peekWalk(write, label) : walk(wn, write));
    const ent = tlb.entries.get(tlb.sites.get(site));
    if (!ent) {
      return m.block(null, [
        m.local.set(tlb.a, addr),
        crosses(m.if(m.i32.lt_u(A(), vb), A(), m.block(label, [lookup(), phys()], b.i32))),
      ], b.i32);
    }
    report.tlbSites++;
    if (b.getExpressionId(site) === b.CallId) report.tlbGroupSites++; // a merged group's translation
    if (peek) report.tlbPeekSites++;
    const frame = () => m.i32.and(E(), m.i32.const(-4096));
    const miss = crosses(m.block(label, [
      // Identity pages are cached too (always writable: bit 1 set in $e).
      m.if(m.i32.lt_u(A(), vb), m.local.set(tlb.e, m.i32.or(A(), m.i32.const(2))), lookup()),
      ...ent.set(m.i32.and(A(), m.i32.const(-4096)), frame()),
      ...(!ent.sib ? [] : write ? ent.copyTo(ent.sib) : [m.if(m.i32.and(E(), m.i32.const(2)), m.block(null, ent.copyTo(ent.sib), b.none))]),
      phys(),
    ], b.i32));
    return m.block(null, [
      m.local.set(tlb.a, addr),
      m.if(m.i32.lt_u(m.local.tee(tlb.d, m.i32.sub(A(), ent.vb()), b.i32), m.i32.const(4097 - n)),
        m.i32.add(ent.fb(), m.local.get(tlb.d, b.i32)),
        miss),
    ], b.i32);
  }

  // A merged group's translation (a call emitted by emitGroup).
  function translateCall(call) {
    const { write, n, range, peek } = groupCalls.get(call);
    return translate(b.Call.getOperandAt(call, 0), n, write, call, range, peek);
  }

  function rewriteLoad(e) {
    if (merged.has(e)) return e;
    const info = b.getExpressionInfo(e);
    if (info.isAtomic) { errors.push(`${curName}: atomics/threads are not supported yet`); return e; }
    if (info.type === b.v128) { errors.push(`${curName}: SIMD is not supported yet (build with -mno-simd128)`); return e; }
    const { ptr, offset, bytes: n, align, isSigned, type } = info;
    if (constIdentity(ptr, offset)) { bump('skippedConst'); return e; }
    const addr = addrOf(ptr, offset);
    if (align >= n) {
      b.Load.setPtr(e, translate(addr, n, false, e));
      b.Load.setOffset(e, 0);
      bump('loadsFast');
      return e;
    }
    bump('loadsSlow');
    if (type === b.i32) return afterCall(m.call('__vera_ld_i32', [addr, m.i32.const(n), m.i32.const(isSigned ? 1 : 0)], b.i32), b.i32);
    if (type === b.i64) return afterCall(m.call('__vera_ld_i64', [addr, m.i32.const(n), m.i32.const(isSigned ? 1 : 0)], b.i64), b.i64);
    if (type === b.f32) return afterCall(m.call('__vera_ld_f32', [addr], b.f32), b.f32);
    if (type === b.f64) return afterCall(m.call('__vera_ld_f64', [addr], b.f64), b.f64);
    errors.push(`${curName}: unsupported load type ${typeName(type)}`);
    return e;
  }

  function rewriteStore(e) {
    if (merged.has(e)) return e;
    const info = b.getExpressionInfo(e);
    if (info.isAtomic) { errors.push(`${curName}: atomics/threads are not supported yet`); return e; }
    if (info.valueType === b.v128) { errors.push(`${curName}: SIMD is not supported yet (build with -mno-simd128)`); return e; }
    const { ptr, value, offset, bytes: n, align, valueType } = info;
    if (constIdentity(ptr, offset)) { bump('skippedConst'); return e; }
    const addr = addrOf(ptr, offset);
    if (align < n) {
      bump('storesSlow');
      if (valueType === b.i32) return afterCall(m.call('__vera_st_i32', [addr, m.i32.const(n), value], b.none), b.none);
      if (valueType === b.i64) return afterCall(m.call('__vera_st_i64', [addr, m.i32.const(n), value], b.none), b.none);
      if (valueType === b.f32) return afterCall(m.call('__vera_st_f32', [addr, value], b.none), b.none);
      if (valueType === b.f64) return afterCall(m.call('__vera_st_f64', [addr, value], b.none), b.none);
      errors.push(`${curName}: unsupported store type ${typeName(valueType)}`);
      return e;
    }
    bump('storesFast');
    if (isMemoryFree(value)) {
      // Value cannot fault: translate while evaluating the pointer operand.
      b.Store.setPtr(e, translate(addr, n, true, e));
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
      return m.block(null, [m.local.set(tp, translate(addr, n, true, e)), m.local.set(tv, value), e], b.none);
    }
    b.Store.setPtr(e, translate(m.local.get(tp, b.i32), n, true, e));
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
        // __vera_trap throws; the unreachable tells the engine (see softmmu.c)
        m.block(null, [m.call('__vera_trap', [m.i32.const(2), m.local.get(t, b.i32)], b.none), m.unreachable()], b.unreachable)),
      m.global.set(spName, m.local.get(t, b.i32)),
    ], b.none);
  }

  const hooks = {
    onEnter: (e, id) => {
      const why = forbiddenReason(id);
      if (why) { errors.push(`${curName}: ${why}`); return false; }
      if (id === b.BlockId && fallbacks.has(e)) inFallback = fallbacks.get(e); // (never nested)
      if (id === b.LoopId) loopStack.push(e);
      return true;
    },
    onExit: (e, id) => {
      if (id === b.LoopId) loopStack.pop();
      if (id === b.BlockId && fallbacks.has(e)) {
        const { branches } = inFallback;
        inFallback = null;
        const reset = branches ? [] : tlbInvalidate(); // see translate()
        return reset.length ? m.block(null, [e, ...reset], b.none) : e;
      }
      if (id === b.LoadId) return rewriteLoad(e);
      if (id === b.StoreId) return rewriteStore(e);
      if (id === b.GlobalSetId && spName && b.GlobalSet.getName(e) === spName) return stackCheck(e);
      if (id === b.CallId && groupCalls.has(e)) return translateCall(e);
      if (id === b.CallIndirectId || (id === b.CallId && b.Call.getTarget(e) !== '__vera_trap')) {
        return afterCall(e, b.getExpressionType(e));
      }
      if (id === b.LoopId && tlb.perLoop.has(e)) { // a loop's entries start empty
        return m.block(null, [...tlbReset(tlb.perLoop.get(e)), e], b.getExpressionType(e));
      }
      return e;
    },
    onUnknown: (id) => errors.push(`${curName}: unsupported expression kind ${id} (only MVP wasm is supported)`),
  };

  // Functions with very many accesses (OUT_OF_LINE_SITES) call out-of-line
  // copies of the helpers. The per-access fallback copies of merged groups
  // run only when a group's range crosses a page, so they call the
  // out-of-line copies too: that keeps the duplicated code small.
  const needCall = new Set();
  const outOfLine = { onExit: (e, id) => {
    if (id === b.CallId) {
      const t = b.Call.getTarget(e);
      if (TRANSLATE_HELPERS.includes(t)) { b.Call.setTarget(e, `${t}_call`); needCall.add(t); }
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
    merged = new Set();
    fallbacks = new Map();
    loopStack = [];
    groupCalls = new Map();
    blockSummary = new Map();
    let body = fi.body;
    if (canMerge) {
      // Merging changes the body in place: keep a copy of a function it may
      // make too big (at most OUT_OF_LINE_SITES sites cannot), see
      // MAX_MERGED_ACCESSES.
      const original = countSites(body) > OUT_OF_LINE_SITES ? m.copyExpression(body) : null;
      const before = Object.fromEntries(MERGE_COUNTERS.map((k) => [k, report[k]]));
      body = mergeGroups(body);
      tlb = planFunction(body);
      if (original && (tlb.mode === 'outOfLine' || report.mergedAccesses - before.mergedAccesses > MAX_MERGED_ACCESSES)) {
        Object.assign(report, before);
        report.unmerged.push(fi.name);
        body = original;
        merged = new Set();
        fallbacks = new Map();
        groupCalls = new Map();
        tlb = null;
      }
    }
    tlb ||= planFunction(body);
    if (tlb.mode === 'inline') report.inlineFunctions++;
    if (tlb.all.length) {
      report.tlbFunctions++;
      report.tlbEntries += tlb.all.length;
    }
    body = transform(body, hooks);
    if (tlb.mode === 'outOfLine') {
      body = transform(body, outOfLine);
      report.outOfLine.push(fi.name);
    } else if (optimize) {
      for (const slow of fallbacks.keys()) transform(slow, outOfLine);
    }
    tlb = null;
    b.Function.setBody(f, body);
  }
  // The slow paths stay out of line: inlined at every access they would put
  // calls (and the register spills around them) into the fast path.
  const noInline = SLOW_HELPERS.filter((h) => m.getFunction(h));
  if (needCall.size) {
    const params = b.createType([b.i32, b.i32]);
    const used = TRANSLATE_HELPERS.filter((h) => needCall.has(h)); // fixed order: reproducible builds
    for (const h of used) {
      m.addFunction(`${h}_call`, params, b.i32, [], m.call(h, [m.local.get(0, b.i32), m.local.get(1, b.i32)], b.i32));
      noInline.push(`${h}_call`);
    }
  }
  for (const h of noInline) {
    b.setPassArgument('no-inline', h); // exact names (a '?' pattern did not match)
    m.runPasses(['no-inline']);
  }
  b.setPassArgument('no-inline', null);

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
    foldLoadOffsets(m);
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
          if (TRANSLATE_HELPERS.includes(t)) remaining++;
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
