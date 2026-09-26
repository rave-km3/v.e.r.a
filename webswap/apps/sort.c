/*
 * sort.c - LSD radix sort of mbytes MiB of random u32 keys (needs 2x that in
 * heap: keys + scratch). Streaming access: the friendly case for paging.
 * Returns a checksum of the sorted keys; status 2 if not sorted.
 */
#include "vera.h"

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    (void)ops;
    u32 n = (mbytes << 20) / 4;
    u32 *a = malloc((size_t)n * 4), *t = malloc((size_t)n * 4);
    if (!a || !t) { vera_app_status = 1; return 0; }
    u64 s = seed;
    for (u32 i = 0; i < n; i++) a[i] = (u32)vera_rng(&s);
    for (u32 shift = 0; shift < 32; shift += 8) {
        u32 count[257];
        for (u32 d = 0; d < 257; d++) count[d] = 0;
        for (u32 i = 0; i < n; i++) count[((a[i] >> shift) & 255) + 1]++;
        for (u32 d = 0; d < 256; d++) count[d + 1] += count[d];
        for (u32 i = 0; i < n; i++) t[count[(a[i] >> shift) & 255]++] = a[i];
        u32 *x = a; a = t; t = x;
    }
    u64 h = 0;
    for (u32 i = 0; i < n; i++) {
        if (i && a[i - 1] > a[i]) { vera_app_status = 2; return 0; }
        h = vera_mix(h, a[i]);
    }
    return h;
}
