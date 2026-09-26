/* stack.c - deep recursion with big frames: overflows the 1 MiB shadow stack.
 * The ordinary build traps (out of bounds); the paged build must trap too
 * instead of silently continuing into the virtual heap. Each call reads its
 * caller's frame, so all frames stay live (clang cannot turn this into a loop). */
#include "vera.h"

static u32 deep(u32 n, volatile u8 *up)
{
    volatile u8 frame[60 * 1024];
    for (u32 i = 0; i < sizeof frame; i += 4096) frame[i] = (u8)(n + i);
    u32 r = up ? up[4096] : 0;
    if (n == 0) return r + frame[0];
    return deep(n - 1, frame) * 3u + r + frame[4096];
}

VERA_EXPORT("run") u64 run(u32 depth, u32 ops, u32 seed)
{
    (void)ops; (void)seed;
    vera_app_status = 0;
    return deep(depth, 0);
}
