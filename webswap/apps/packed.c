/*
 * packed.c - array of packed (unaligned) records crossing page boundaries,
 * to exercise the byte-wise slow path of the soft-MMU.
 */
#include "vera.h"

typedef struct __attribute__((packed)) { u8 tag; u64 a; u32 b; u16 c; double d; } rec; /* 23 bytes */

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 n = (mbytes << 20) / sizeof(rec);
    rec *r = malloc((size_t)n * sizeof(rec));
    if (!r) { vera_app_status = 1; return 0; }
    u64 s = seed;
    for (u32 i = 0; i < n; i++) {
        u64 x = vera_rng(&s);
        r[i].tag = (u8)x; r[i].a = x; r[i].b = (u32)(x >> 7); r[i].c = (u16)(x >> 3); r[i].d = (double)(x >> 12);
    }
    u64 h = 0;
    if (!ops) ops = 100000;
    for (u32 i = 0; i < ops; i++) {
        rec *p = &r[(u32)(vera_rng(&s) >> 33) % n];
        p->a += p->b + p->c;
        p->d = p->d * 0.5 + (double)p->tag;
        union { double d; u64 u; } c; c.d = p->d;
        h = vera_mix(h, p->a ^ c.u);
    }
    free(r);
    return h;
}
