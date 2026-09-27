/*
 * softmmu.c - the software MMU of v.e.r.a WebSwap.
 *
 * WebAssembly has no page faults, so the build step (tools/instrument.mjs)
 * rewrites every load and store of the program:
 *
 *   naturally aligned access  ->  load/store at __vera_tl(addr, n) / __vera_ts(addr, n)
 *   possibly unaligned access ->  call __vera_ld_* / __vera_st_* (byte by byte)
 *   aligned accesses through one base pointer, with nothing that can fault
 *   between them -> one __vera_tlg / __vera_tsg for the whole group
 *   (__vera_tl_peek / __vera_ts_peek, which never fault, when the group's
 *   accesses may all be skipped or come after a side effect)
 *
 * instrument.mjs emits the fast paths of __vera_tl/__vera_ts/__vera_tlg/
 * __vera_tsg (and the peeks) inline itself, in the same shape (so that it
 * can put a software TLB in front and empty it in their slow branch), and
 * calls the functions here only for its out-of-line cases; the slow paths
 * (__vera_tl_slow/__vera_ts_slow) are shared by both.
 *
 * Addresses below VERA_VBASE are identity-mapped (data, stack, this page
 * table, the frame pool). Addresses at or above VERA_VBASE are virtual: the
 * page table maps each 4 KiB virtual page to a frame in the pool, and the JS
 * pager (runtime/pager.mjs) fills and evicts frames on a fault.
 *
 * Page table entry: 0 = not mapped here (fault), otherwise
 *   frame address | 1 (present) | 2 (writable: page is already dirty).
 * A store to a present but non-writable page faults once so the pager can
 * mark the page dirty; clean pages are later evicted without any write.
 *
 * Every function here is named __vera_* so the instrumentation pass leaves
 * its own memory accesses alone.
 */
#include "vera.h"

/* JS pager: map virtual page v (write=1 for a store) and return its entry. */
extern u32 __vera_fault(u32 v, u32 write) VERA_IMPORT("vera", "fault");
/* JS: throw a descriptive error (1 = aligned access crossing a page,
 * 2 = shadow-stack overflow; the check for 2 is inserted by instrument.mjs).
 * It never returns. noreturn puts an `unreachable` after every call, so the
 * engine sees each check as a branch to a dead end: without it, V8 kept values
 * alive across the (never taken) call and spilled them on the hot path. */
extern void __vera_trap(u32 code, u32 addr) VERA_IMPORT("vera", "trap") __attribute__((noreturn));

u32 __vera_pt[VERA_NVP];

#define OFFSET_MASK (VERA_PAGE_SIZE - 1u)

/* Entry of virtual address a (a >= VERA_VBASE), indexed by a >> 12 from a
 * page table base moved down by VBASE / 4096 entries instead of by
 * (a - VBASE) >> 12: one instruction less per access. Computed in u32 so it
 * wraps back into the table even if that moved-down base would be negative.
 * The build step folds the constant into the load's offset (foldLoadOffsets()
 * in instrument.mjs), leaving shift, mask and load. */
#define PT_BIAS ((u32)__vera_pt - (VERA_VBASE >> (VERA_PAGE_SHIFT - 2)))
#define PTE(a) (*(u32 *)((((a) >> VERA_PAGE_SHIFT) << 2) + PT_BIAS))

/* The rare cases of __vera_tl/__vera_ts, kept out of line (instrument.mjs
 * stops binaryen from inlining them): the page is not mapped here (for a
 * store: not yet writable), or the access crosses a page boundary. Returns
 * the entry to use.
 *
 * Why this shape: the engines cannot tell that a call in the inlined fast
 * path is rare, so every value that is live across it gets spilled to the
 * stack on the fast path too, and each call site splits the code into more
 * blocks. So there is exactly one call per access, and it yields the entry,
 * not the address: both paths meet before the address is formed, and the
 * translated address is not a value that has to survive a call. (Returning
 * the address instead left extra register moves at every join in V8's
 * optimizing tier and was slower than the old fault-call-plus-trap-call.) */
__attribute__((noinline)) u32 __vera_tl_slow(u32 a, u32 n)
{
    u32 v = (a - VERA_VBASE) >> VERA_PAGE_SHIFT;
    u32 e = __vera_pt[v];
    if (e == 0) e = __vera_fault(v, 0);
    if ((a & OFFSET_MASK) + n > VERA_PAGE_SIZE) __vera_trap(1, a);
    return e;
}

__attribute__((noinline)) u32 __vera_ts_slow(u32 a, u32 n)
{
    u32 v = (a - VERA_VBASE) >> VERA_PAGE_SHIFT;
    u32 e = __vera_pt[v];
    if ((e & 2u) == 0) e = __vera_fault(v, 1);
    if ((a & OFFSET_MASK) + n > VERA_PAGE_SIZE) __vera_trap(1, a);
    return e;
}

/* The fast path. instrument.mjs emits this same code inline at every access
 * (n is then a constant, and the page crossing test is a compare of a & 0xfff
 * with 4096 - n, gone for n = 1); these functions serve its out-of-line
 * calls and the byte-wise helpers below. */
VERA_EXPORT("__vera_tl") u32 __vera_tl(u32 a, u32 n)
{
    if (a < VERA_VBASE) return a;
    u32 e = PTE(a);
    if (__builtin_expect(e == 0 || (a & OFFSET_MASK) + n > VERA_PAGE_SIZE, 0)) e = __vera_tl_slow(a, n);
    return (e & ~OFFSET_MASK) | (a & OFFSET_MASK);
}

VERA_EXPORT("__vera_ts") u32 __vera_ts(u32 a, u32 n)
{
    if (a < VERA_VBASE) return a;
    u32 e = PTE(a);
    if (__builtin_expect((e & 2u) == 0 || (a & OFFSET_MASK) + n > VERA_PAGE_SIZE, 0)) e = __vera_ts_slow(a, n);
    return (e & ~OFFSET_MASK) | (a & OFFSET_MASK);
}

/* Group translation: instrument.mjs merges accesses that share one base
 * pointer (struct fields, unrolled loops) into one translation of the whole
 * byte range [a, a + span). The range may legitimately cross a
 * page (a struct that straddles two pages), so instead of trapping these
 * return 0 and the caller runs its per-access fallback code. 0 is never a
 * valid answer otherwise: frames are far above address 0, and an identity
 * address of 0 simply takes the (always correct) fallback. A range that fits
 * in its page is looked up like a single access: the biased PTE() and one
 * rare call to the shared out-of-line slow path (with n = 1, which cannot
 * trap: the range is already known to stay inside the page). */
VERA_EXPORT("__vera_tlg") u32 __vera_tlg(u32 a, u32 span)
{
    if (__builtin_expect((a & OFFSET_MASK) + span > VERA_PAGE_SIZE, 0)) return 0;
    if (a < VERA_VBASE) return a;
    u32 e = PTE(a);
    if (__builtin_expect(e == 0, 0)) e = __vera_tl_slow(a, 1);
    return (e & ~OFFSET_MASK) | (a & OFFSET_MASK);
}

VERA_EXPORT("__vera_tsg") u32 __vera_tsg(u32 a, u32 span)
{
    if (__builtin_expect((a & OFFSET_MASK) + span > VERA_PAGE_SIZE, 0)) return 0;
    if (a < VERA_VBASE) return a;
    u32 e = PTE(a);
    if (__builtin_expect((e & 2u) == 0, 0)) e = __vera_ts_slow(a, 1);
    return (e & ~OFFSET_MASK) | (a & OFFSET_MASK);
}

/* Group translation that never faults (or traps): like __vera_tlg/__vera_tsg,
 * but a page that is not mapped here (for a store: not writable yet) also
 * gives 0, and the per-access fallback then faults where the program would.
 * For groups whose accesses may all be skipped (branches come first), or
 * that come after a side effect: translating those early must not fault a
 * page the program does not touch, or fail before the side effect. */
VERA_EXPORT("__vera_tl_peek") u32 __vera_tl_peek(u32 a, u32 span)
{
    if ((a & OFFSET_MASK) + span > VERA_PAGE_SIZE) return 0;
    if (a < VERA_VBASE) return a;
    u32 e = PTE(a);
    return e ? (e & ~OFFSET_MASK) | (a & OFFSET_MASK) : 0;
}

VERA_EXPORT("__vera_ts_peek") u32 __vera_ts_peek(u32 a, u32 span)
{
    if ((a & OFFSET_MASK) + span > VERA_PAGE_SIZE) return 0;
    if (a < VERA_VBASE) return a;
    u32 e = PTE(a);
    return (e & 2u) ? (e & ~OFFSET_MASK) | (a & OFFSET_MASK) : 0;
}

/* ---- slow path for accesses that may be unaligned -----------------------
 * Byte by byte, so an access that crosses a page boundary is still correct. */

static inline u8 ld8(u32 a) { return *(volatile u8 *)__vera_tl(a, 1); }
static inline void st8(u32 a, u8 v) { *(volatile u8 *)__vera_ts(a, 1) = v; }

VERA_EXPORT("__vera_ld_i32") u32 __vera_ld_i32(u32 a, u32 n, u32 sgn)
{
    u32 x = 0;
    for (u32 i = 0; i < n; i++) x |= (u32)ld8(a + i) << (8u * i);
    if (sgn && n < 4) {
        u32 sh = 32u - 8u * n;
        x = (u32)((i32)(x << sh) >> sh);
    }
    return x;
}

VERA_EXPORT("__vera_ld_i64") u64 __vera_ld_i64(u32 a, u32 n, u32 sgn)
{
    u64 x = 0;
    for (u32 i = 0; i < n; i++) x |= (u64)ld8(a + i) << (8u * i);
    if (sgn && n < 8) {
        u32 sh = 64u - 8u * n;
        x = (u64)((i64)(x << sh) >> sh);
    }
    return x;
}

VERA_EXPORT("__vera_ld_f32") float __vera_ld_f32(u32 a)
{
    union { u32 u; float f; } c;
    c.u = __vera_ld_i32(a, 4, 0);
    return c.f;
}

VERA_EXPORT("__vera_ld_f64") double __vera_ld_f64(u32 a)
{
    union { u64 u; double f; } c;
    c.u = __vera_ld_i64(a, 8, 0);
    return c.f;
}

VERA_EXPORT("__vera_st_i32") void __vera_st_i32(u32 a, u32 n, u32 v)
{
    for (u32 i = 0; i < n; i++) st8(a + i, (u8)(v >> (8u * i)));
}

VERA_EXPORT("__vera_st_i64") void __vera_st_i64(u32 a, u32 n, u64 v)
{
    for (u32 i = 0; i < n; i++) st8(a + i, (u8)(v >> (8u * i)));
}

VERA_EXPORT("__vera_st_f32") void __vera_st_f32(u32 a, float v)
{
    union { u32 u; float f; } c;
    c.f = v;
    __vera_st_i32(a, 4, c.u);
}

VERA_EXPORT("__vera_st_f64") void __vera_st_f64(u32 a, double v)
{
    union { u64 u; double f; } c;
    c.f = v;
    __vera_st_i64(a, 8, c.u);
}

/* Page table address for tools/instrument.mjs, which emits its own inline
 * copy of the fast paths above (with a software TLB in front of them). It
 * reads the constant from this body and removes the export again. */
VERA_EXPORT("__vera_pt_addr") u32 __vera_pt_addr(void)
{
    return (u32)__vera_pt;
}

/* Layout facts for the JS side: 0 = VBASE, 1 = page table address,
 * 2 = number of virtual pages, 3 = page size. */
VERA_EXPORT("__vera_info") u32 __vera_info(u32 i)
{
    switch (i) {
    case 0: return VERA_VBASE;
    case 1: return (u32)__vera_pt;
    case 2: return VERA_NVP;
    case 3: return VERA_PAGE_SIZE;
    default: return 0;
    }
}
