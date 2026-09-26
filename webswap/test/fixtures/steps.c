/* steps.c - an incremental job for checkpoint/resume tests. All state
 * (pointer, RNG, accumulator, allocator) lives in memory, so a checkpoint
 * taken between step() calls captures it completely. */
#include "vera.h"

static u64 *arr;
static u32 n;
static u64 rng, acc;

VERA_EXPORT("init") u32 init(u32 mbytes, u32 seed)
{
    n = (mbytes << 20) / 8;
    arr = malloc((size_t)n * 8);
    if (!arr) return 1;
    for (u32 i = 0; i < n; i++) arr[i] = i * 0x9E3779B97F4A7C15ull;
    rng = seed;
    acc = 0;
    return 0;
}

VERA_EXPORT("step") void step(u32 ops)
{
    for (u32 i = 0; i < ops; i++) {
        u64 r = vera_rng(&rng);
        arr[(u32)(r >> 32) % n] += r;
        acc = vera_mix(acc, arr[(u32)(r >> 7) % n]);
    }
}

VERA_EXPORT("digest") u64 digest(void)
{
    u64 h = acc;
    for (u32 i = 0; i < n; i++) h = vera_mix(h, arr[i]);
    return h;
}
