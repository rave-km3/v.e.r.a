/* rmw.c - the store-ordering hazard, provoked on purpose.
 *
 * `a[i] += a[j]` evaluates the store's address, then loads a[j] (which may
 * fault and evict a frame), then stores. If the address were translated
 * before the load, the store could land in a frame that now belongs to
 * another page. The working set is only a few pages larger than the pool, so
 * CLOCK really does evict recently translated frames. */
#include "vera.h"

VERA_EXPORT("run") u64 run(u32 npages, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 n = npages * 4096u / 8u;
    u64 *a = malloc((size_t)n * 8);
    if (!a) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < n; i++) a[i] = i;
    u64 s = seed, h = 0;
    for (u32 k = 0; k < ops; k++) {
        u64 r = vera_rng(&s);
        a[(u32)r % n] += a[(u32)(r >> 32) % n] + 1;
    }
    for (u32 i = 0; i < n; i++) h = vera_mix(h, a[i]);
    free(a);
    return h;
}
