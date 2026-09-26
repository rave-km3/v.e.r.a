/*
 * rand.c - `ops` uniform random read-modify-writes over an mbytes MiB array.
 * No locality at all: the worst case for any paging system.
 */
#include "vera.h"

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    u32 n = (mbytes << 20) / 8;
    u64 *a = malloc((size_t)n * 8);
    if (!a) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < n; i++) a[i] = i;
    u64 s = seed;
    if (!ops) ops = 1000000;
    for (u32 i = 0; i < ops; i++) {
        u64 r = vera_rng(&s);
        a[(u32)(r >> 32) % n] += r;
    }
    u64 h = 0;
    for (u32 i = 0; i < n; i++) h = vera_mix(h, a[i]);
    return h;
}
