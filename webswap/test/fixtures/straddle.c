/* A misaligned pointer used with an aligned (u32) store that crosses a page
 * boundary. Undefined behaviour in C; WebSwap must trap, never corrupt. */
#include "vera.h"
VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    (void)mbytes; (void)ops; (void)seed;
    u8 *b = malloc(3 * 4096);
    u32 *p = (u32 *)(void *)(b + 4094); /* crosses into the next page */
    *p = 0x11223344u;
    return *p;
}
