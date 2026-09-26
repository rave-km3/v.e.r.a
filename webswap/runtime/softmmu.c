/*
 * softmmu.c - the software MMU of v.e.r.a WebSwap.
 *
 * WebAssembly has no page faults, so the build step (tools/instrument.mjs)
 * rewrites every load and store of the program:
 *
 *   naturally aligned access  ->  load/store at __vera_tl(addr, n) / __vera_ts(addr, n)
 *   possibly unaligned access ->  call __vera_ld_* / __vera_st_* (byte by byte)
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
/* JS: throw a descriptive error (1 = aligned access crossing a page). */
extern void __vera_trap(u32 code, u32 addr) VERA_IMPORT("vera", "trap");

u32 __vera_pt[VERA_NVP];

#define OFFSET_MASK (VERA_PAGE_SIZE - 1u)

VERA_EXPORT("__vera_tl") u32 __vera_tl(u32 a, u32 n)
{
    if (a < VERA_VBASE) return a;
    u32 v = (a - VERA_VBASE) >> VERA_PAGE_SHIFT;
    u32 e = __vera_pt[v];
    if (__builtin_expect(e == 0, 0)) e = __vera_fault(v, 0);
    if (__builtin_expect((a & OFFSET_MASK) + n > VERA_PAGE_SIZE, 0)) __vera_trap(1, a);
    return (e & ~OFFSET_MASK) | (a & OFFSET_MASK);
}

VERA_EXPORT("__vera_ts") u32 __vera_ts(u32 a, u32 n)
{
    if (a < VERA_VBASE) return a;
    u32 v = (a - VERA_VBASE) >> VERA_PAGE_SHIFT;
    u32 e = __vera_pt[v];
    if (__builtin_expect((e & 2u) == 0, 0)) e = __vera_fault(v, 1);
    if (__builtin_expect((a & OFFSET_MASK) + n > VERA_PAGE_SIZE, 0)) __vera_trap(1, a);
    return (e & ~OFFSET_MASK) | (a & OFFSET_MASK);
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
