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
 * free lists; larger blocks are page-rounded and their payload starts on a
 * page boundary. Free large blocks are kept in address order and merged
 * with free neighbours; a free block that ends at the top of the heap is
 * given back to it. Allocation is best-fit. Memory above the heap's
 * high-water mark has never been handed out and is known to be zero, so
 * calloc() skips the memset there (in a paged build that avoids writing
 * zeros to storage). Good enough for the demo apps; not a general-purpose
 * high-performance allocator.
 */
#include "vera.h"

#ifndef VERA_PAGED
#define VERA_PAGED 1
#endif

u32 vera_app_status;

#define HDR 16u
#define SMALL_MAX 2048u
#define NCLASS 8 /* 16,32,...,2048 */
#define SPLIT_MIN (64u * 1024u)
#define FREE_MAGIC 0xF4EEF4EEu
#define USED_MAGIC 0x05ED05EDu

typedef struct blk {
    u32 size;         /* total size including header */
    u32 magic;
    struct blk *next; /* valid only while free */
    u32 pad;
} blk;

static blk *small_free[NCLASS];
static blk *large_free; /* address-ordered, no two adjacent */
static u32 cur, lim, hwm;
static int inited;

#if VERA_PAGED
static void heap_init(void)
{
    cur = hwm = VERA_VBASE;
    lim = 0xFFFFF000u; /* keep the last page unused: no u32 overflow */
    inited = 1;
}
static int heap_more(u32 need)
{
    (void)need;
    return 0; /* the virtual region is fixed */
}
#else
extern unsigned char __heap_base;
static u32 mem_limit(void)
{
    u32 pages = (u32)__builtin_wasm_memory_size(0);
    return pages >= 65536u ? 0xFFFFF000u : pages * 65536u; /* 4 GiB would wrap to 0 */
}
static void heap_init(void)
{
    cur = hwm = ((u32)&__heap_base + 15u) & ~15u;
    lim = mem_limit();
    inited = 1;
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
    lim = mem_limit();
    return 1;
}
#endif

/* Take `total` bytes from the top of the heap. *fresh = 1 if that memory
 * was never handed out before (so it is still zero). */
static u32 bump(u32 total, int *fresh)
{
    if (!inited) heap_init();
    while (total > lim - cur)
        if (!heap_more(total - (lim - cur))) return 0;
    u32 p = cur;
    cur += total;
    if (fresh) *fresh = p >= hwm;
    if (cur > hwm) hwm = cur;
    return p;
}

static int class_of(u32 total)
{
    int c = 0;
    u32 s = 16;
    while (s < total) { s <<= 1; c++; }
    return c;
}

/* Insert a free large block, merging it with adjacent free blocks. */
static void large_insert(blk *b)
{
    blk *prev = NULL, *nx = large_free;
    while (nx && (u32)nx < (u32)b) { prev = nx; nx = nx->next; }
    b->magic = FREE_MAGIC;
    b->next = nx;
    if (prev) prev->next = b; else large_free = b;
    if (nx && (u32)b + b->size == (u32)nx) { /* merge with the next block */
        b->size += nx->size;
        b->next = nx->next;
    }
    if (prev && (u32)prev + prev->size == (u32)b) { /* merge with the previous one */
        prev->size += b->size;
        prev->next = b->next;
        b = prev;
    }
    if ((u32)b + b->size == cur && b->next == NULL) { /* last block: give it back */
        blk **pp = &large_free;
        while (*pp != b) pp = &(*pp)->next;
        *pp = NULL;
        cur = (u32)b;
    }
}

static void *alloc_impl(size_t n, int *fresh)
{
    *fresh = 0;
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
            u32 p = bump(total, fresh);
            if (!p) return NULL;
            b = (blk *)p;
        }
    } else {
        total = (total + VERA_PAGE_SIZE - 1) & ~(VERA_PAGE_SIZE - 1);
        blk *best = NULL, *best_prev = NULL, *prev = NULL;
        for (blk *x = large_free; x; prev = x, x = x->next) { /* best fit */
            if (x->size >= total && (!best || x->size < best->size)) { best = x; best_prev = prev; }
        }
        if (best) {
            b = best;
            blk *after = b->next;
            if (b->size - total >= SPLIT_MIN) { /* keep the tail free, in place */
                blk *rest = (blk *)((u32)b + total);
                rest->size = b->size - total;
                rest->magic = FREE_MAGIC;
                rest->next = after;
                after = rest;
            } else {
                total = b->size;
            }
            if (best_prev) best_prev->next = after; else large_free = after;
        } else {
            /* Start the payload of a large block on a page boundary; the
             * skipped gap (< 4 KiB) is simply left unused. */
            if (!inited) heap_init();
            u64 start = (((u64)cur + HDR + VERA_PAGE_SIZE - 1) & ~(u64)(VERA_PAGE_SIZE - 1)) - HDR;
            u64 gap = start - cur;
            if (gap + total > 0xFFFFFFFFull) return NULL;
            u32 p = bump((u32)(gap + total), fresh);
            if (!p) return NULL;
            b = (blk *)(p + (u32)gap);
        }
    }
    b->size = total;
    b->magic = USED_MAGIC;
    return (void *)((u32)b + HDR);
}

void *malloc(size_t n)
{
    int fresh;
    return alloc_impl(n, &fresh);
}

void free(void *p)
{
    if (!p) return;
    blk *b = (blk *)((u32)p - HDR);
    if (b->magic != USED_MAGIC) __builtin_trap(); /* double free / bad pointer */
    if (b->size <= SMALL_MAX) {
        b->magic = FREE_MAGIC;
        int c = class_of(b->size);
        b->next = small_free[c];
        small_free[c] = b;
    } else {
        large_insert(b);
    }
}

void *calloc(size_t n, size_t size)
{
    if (size && n > 0xFFFFFFFFu / size) return NULL;
    int fresh;
    void *p = alloc_impl(n * size, &fresh);
    if (p && !fresh) memset(p, 0, n * size); /* fresh memory is already zero */
    return p;
}

void *realloc(void *p, size_t n)
{
    if (!p) return malloc(n);
    blk *b = (blk *)((u32)p - HDR);
    if (b->magic != USED_MAGIC) __builtin_trap();
    u32 have = b->size - HDR;
    if (n <= have) return p;
    if (b->size > SMALL_MAX && n <= 0xF0000000u && (u32)b + b->size == cur) {
        /* last block of the heap: grow it in place */
        u32 want = ((u32)n + HDR + VERA_PAGE_SIZE - 1) & ~(VERA_PAGE_SIZE - 1);
        if (bump(want - b->size, NULL)) { b->size = want; return p; }
    }
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
