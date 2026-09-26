/*
 * chase.c - pointer chase through a random single cycle over mbytes MiB
 * (Sattolo). Every load depends on the previous one: prefetching and
 * parallelism cannot help. The pure-latency worst case.
 */
#include "vera.h"

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    u32 n = (mbytes << 20) / 4;
    u32 *next = malloc((size_t)n * 4);
    if (!next) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < n; i++) next[i] = i;
    u64 s = seed;
    for (u32 i = n - 1; i > 0; i--) { /* Sattolo: one cycle through all */
        u32 j = (u32)(vera_rng(&s) % i);
        u32 t = next[i]; next[i] = next[j]; next[j] = t;
    }
    if (!ops) ops = 1000000;
    u32 p = 0;
    u64 h = 0;
    for (u32 i = 0; i < ops; i++) { p = next[p]; h = vera_mix(h, p); }
    return h;
}
