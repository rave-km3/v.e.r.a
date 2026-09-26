/*
 * hash.c - open-addressing hash table filling mbytes MiB, then `ops` lookups
 * with skewed (roughly Zipf-like) keys. Random access with a hot subset.
 */
#include "vera.h"

typedef struct { u64 key, val; } slot;

static u64 hash64(u64 x) { x ^= x >> 33; x *= 0xff51afd7ed558ccdull; x ^= x >> 33; return x; }

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 cap = 1;
    while ((u64)cap * 2 * sizeof(slot) <= ((u64)mbytes << 20)) cap *= 2;
    slot *tab = malloc((size_t)cap * sizeof(slot));
    if (!tab) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < cap; i++) tab[i].key = 0;
    u32 nkeys = cap / 2; /* load factor 0.5 */
    for (u32 i = 1; i <= nkeys; i++) {
        u32 j = (u32)hash64(i) & (cap - 1);
        while (tab[j].key) j = (j + 1) & (cap - 1);
        tab[j].key = i;
        tab[j].val = (u64)i * 2654435761u;
    }
    u64 s = seed, h = 0;
    if (!ops) ops = 1000000;
    for (u32 q = 0; q < ops; q++) {
        u32 x = (u32)(vera_rng(&s) % nkeys);
        u32 k = 1 + (u32)(vera_rng(&s) % (x + 1)); /* skewed towards small keys */
        u32 j = (u32)hash64(k) & (cap - 1);
        while (tab[j].key != k) j = (j + 1) & (cap - 1);
        h = vera_mix(h, tab[j].val);
    }
    free(tab);
    return h;
}
