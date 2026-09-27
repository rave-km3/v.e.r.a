/* alloc.c - allocator workloads that used to exhaust the heap or write zeros. */
#include "vera.h"

/* Steady state: big scratch buffer + small temporary, repeated. At most
 * mb MiB are live at any time. Returns 0 if every allocation succeeded. */
VERA_EXPORT("frag") u32 frag(u32 mb, u32 iters)
{
    for (u32 i = 0; i < iters; i++) {
        u8 *big = malloc((size_t)mb << 20);
        if (!big) return i + 1;
        big[0] = (u8)i;
        big[((size_t)mb << 20) - 1] = (u8)i;
        free(big);
        u8 *small = malloc(8192);
        if (!small) return i + 1;
        small[0] = 1;
        free(small);
    }
    return 0;
}

/* Grow a buffer by realloc doubling up to maxkb KiB, then free it. */
VERA_EXPORT("regrow") u32 regrow(u32 maxkb, u32 iters)
{
    for (u32 i = 0; i < iters; i++) {
        u32 n = 8192;
        u8 *p = malloc(n);
        if (!p) return i + 1;
        while (n < (maxkb << 10)) {
            u8 *q = realloc(p, n * 2);
            if (!q) return i + 1;
            p = q;
            p[n] = (u8)n;
            n *= 2;
        }
        free(p);
    }
    return 0;
}

/* calloc fresh memory and only read it. Returns the sum (must be 0). */
VERA_EXPORT("czero_fresh") u64 czero_fresh(u32 mb)
{
    u64 *p = calloc((size_t)mb << 17, 8);
    if (!p) return ~0ull;
    u64 s = 0;
    for (u32 i = 0; i < ((u32)mb << 17); i++) s += p[i];
    free(p);
    return s;
}

/* Dirty a block, free it, calloc it again: reused memory must be zeroed. */
VERA_EXPORT("czero_reuse") u64 czero_reuse(u32 mb)
{
    u8 *q = malloc((size_t)mb << 20);
    if (!q) return ~0ull;
    for (u32 i = 0; i < ((u32)mb << 20); i += 4096) q[i] = 0xAB;
    free(q);
    u64 *r = calloc((size_t)mb << 17, 8);
    if (!r) return ~0ull;
    u64 s = 0;
    for (u32 i = 0; i < ((u32)mb << 17); i++) s += r[i];
    free(r);
    return s;
}

VERA_EXPORT("run") u64 run(u32 a, u32 b, u32 c) { (void)a; (void)b; (void)c; return 0; }
