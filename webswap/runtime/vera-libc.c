/*
 * vera-libc.c - the small freestanding libc used by WebSwap programs.
 *
 * VERA_PAGED=1: the heap lives in the virtual region [VERA_VBASE, 4 GiB).
 *               Nothing here knows about paging; the build step rewrites
 *               every load/store (including these) to go through softmmu.c.
 * VERA_PAGED=0: ordinary wasm heap after __heap_base that grows with
 *               memory.grow, used for the baseline build. malloc() returns
 *               NULL when the host refuses to grow memory.
 *
 * Allocator: 16-byte headers; power-of-two size classes up to 2 KiB with
 * free lists; larger blocks are page-rounded, taken first-fit from a free
 * list (split when much larger) or bump-allocated. Good enough for the
 * demo apps; not a general-purpose high-performance allocator.
 */
#include "vera.h"

#ifndef VERA_PAGED
#define VERA_PAGED 1
#endif

u32 vera_app_status;

#define HDR 16u
#define SMALL_MAX 2048u
#define NCLASS 8 /* 16,32,...,2048 */
#define FREE_MAGIC 0xF4EEF4EEu
#define USED_MAGIC 0x05ED05EDu

typedef struct blk {
    u32 size;        /* total size including header */
    u32 magic;
    struct blk *next; /* valid only while free */
    u32 pad;
} blk;

static blk *small_free[NCLASS];
static blk *large_free;
static u32 cur, lim;

#if VERA_PAGED
static void heap_init(void)
{
    cur = VERA_VBASE;
    lim = 0xFFFFF000u; /* keep the last page unused: no u32 overflow */
}
static int heap_more(u32 need)
{
    (void)need;
    return 0; /* the virtual region is fixed */
}
#else
extern unsigned char __heap_base;
static void heap_init(void)
{
    cur = ((u32)&__heap_base + 15u) & ~15u;
    lim = (u32)__builtin_wasm_memory_size(0) * 65536u;
}
static int heap_more(u32 need)
{
    u32 pages = (need + 65535u) / 65536u;
    if (pages < 256) pages = 256; /* grow in >= 16 MiB steps */
    if (__builtin_wasm_memory_grow(0, pages) == (unsigned long)-1) {
        pages = (need + 65535u) / 65536u; /* retry with the exact amount */
        if (__builtin_wasm_memory_grow(0, pages) == (unsigned long)-1)
            return 0;
    }
    lim = (u32)__builtin_wasm_memory_size(0) * 65536u;
    return 1;
}
#endif

static u32 bump(u32 total)
{
    if (!lim) heap_init();
    while (total > lim - cur)
        if (!heap_more(total - (lim - cur))) return 0;
    u32 p = cur;
    cur += total;
    return p;
}

static int class_of(u32 total)
{
    int c = 0;
    u32 s = 16;
    while (s < total) { s <<= 1; c++; }
    return c;
}

void *malloc(size_t n)
{
    if (n == 0) n = 1;
    if (n > 0xF0000000u) return NULL;
    u32 total = (u32)n + HDR;
    blk *b;
    if (total <= SMALL_MAX) {
        int c = class_of(total);
        total = 16u << c;
        b = small_free[c];
        if (b) {
            small_free[c] = b->next;
        } else {
            u32 p = bump(total);
            if (!p) return NULL;
            b = (blk *)p;
        }
    } else {
        total = (total + VERA_PAGE_SIZE - 1) & ~(VERA_PAGE_SIZE - 1);
        blk **pp = &large_free;
        b = NULL;
        while (*pp) {
            if ((*pp)->size >= total) {
                b = *pp;
                if (b->size - total >= 64u * 1024u) { /* split the tail off */
                    blk *rest = (blk *)((u32)b + total);
                    rest->size = b->size - total;
                    rest->magic = FREE_MAGIC;
                    rest->next = b->next;
                    *pp = rest;
                } else {
                    total = b->size;
                    *pp = b->next;
                }
                break;
            }
            pp = &(*pp)->next;
        }
        if (!b) {
            /* Start the payload of a large block on a page boundary; the
             * skipped gap (< 4 KiB) is simply left unused. */
            if (!lim) heap_init();
            u64 start = (((u64)cur + HDR + VERA_PAGE_SIZE - 1) & ~(u64)(VERA_PAGE_SIZE - 1)) - HDR;
            u64 gap = start - cur;
            if (gap + total > 0xFFFFFFFFull) return NULL;
            u32 p = bump((u32)(gap + total));
            if (!p) return NULL;
            b = (blk *)(p + (u32)gap);
        }
    }
    b->size = total;
    b->magic = USED_MAGIC;
    return (void *)((u32)b + HDR);
}

void free(void *p)
{
    if (!p) return;
    blk *b = (blk *)((u32)p - HDR);
    if (b->magic != USED_MAGIC) __builtin_trap(); /* double free / bad pointer */
    b->magic = FREE_MAGIC;
    if (b->size <= SMALL_MAX) {
        int c = class_of(b->size);
        b->next = small_free[c];
        small_free[c] = b;
    } else {
        b->next = large_free;
        large_free = b;
    }
}

void *calloc(size_t n, size_t size)
{
    if (size && n > 0xFFFFFFFFu / size) return NULL;
    void *p = malloc(n * size);
    if (p) memset(p, 0, n * size);
    return p;
}

void *realloc(void *p, size_t n)
{
    if (!p) return malloc(n);
    blk *b = (blk *)((u32)p - HDR);
    u32 have = b->size - HDR;
    if (n <= have) return p;
    void *q = malloc(n);
    if (!q) return NULL;
    memcpy(q, p, have);
    free(p);
    return q;
}

/* ---- mem* / str* --------------------------------------------------------
 * Plain loops (no bulk-memory instructions, which the pager cannot see).
 * -ffreestanding/-fno-builtin keeps clang from turning these loops back into
 * calls to themselves. */

void *memcpy(void *dst, const void *src, size_t n)
{
    u8 *d = dst;
    const u8 *s = src;
    if ((((u32)d | (u32)s) & 7u) == 0) {
        while (n >= 8) {
            *(u64 *)d = *(const u64 *)s;
            d += 8; s += 8; n -= 8;
        }
    }
    while (n--) *d++ = *s++;
    return dst;
}

void *memmove(void *dst, const void *src, size_t n)
{
    u8 *d = dst;
    const u8 *s = src;
    if (d == s || n == 0) return dst;
    if (d < s || d >= s + n) return memcpy(dst, src, n);
    d += n; s += n;
    while (n--) *--d = *--s;
    return dst;
}

void *memset(void *dst, int c, size_t n)
{
    u8 *d = dst;
    u8 v = (u8)c;
    while (n && ((u32)d & 7u)) { *d++ = v; n--; }
    u64 w = v * 0x0101010101010101ull;
    while (n >= 8) { *(u64 *)d = w; d += 8; n -= 8; }
    while (n--) *d++ = v;
    return dst;
}

int memcmp(const void *a, const void *b, size_t n)
{
    const u8 *x = a, *y = b;
    for (; n; n--, x++, y++)
        if (*x != *y) return *x < *y ? -1 : 1;
    return 0;
}

size_t strlen(const char *s)
{
    size_t n = 0;
    while (s[n]) n++;
    return n;
}

VERA_EXPORT("status") u32 vera_status_export(void) { return vera_app_status; }

/* Let the host allocate buffers in the program's heap (e.g. to pass input). */
VERA_EXPORT("vera_malloc") void *vera_malloc_export(u32 n) { return malloc(n); }
VERA_EXPORT("vera_free") void vera_free_export(void *p) { free(p); }
