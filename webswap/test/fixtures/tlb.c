/* tlb.c - streaming loops for the software TLB of tools/instrument.mjs.
 *
 * run(): `a[i] += b[random]` walks a[] page by page (its translation is
 * cached in a TLB entry) while the random loads of b[] fault and, with a
 * pool smaller than the working set, evict or unmap the page a[] is in. A
 * TLB entry that survived such a fault would read or write a frame that now
 * holds another page, and the checksum would differ from the ordinary build.
 *
 * hooked(): a streaming store loop that calls the host every `every`
 * elements; the test's host flushes all pages there (they become clean and
 * read-only in the page table). A store entry that survived the call would
 * keep writing without marking the page dirty again, and those writes would
 * be lost when the page is evicted.
 *
 * stack_sum(): a streaming loop over a stack array (identity pages cached in
 * the TLB).
 *
 * straddle(): an aligned-claimed u32 stream through a misaligned pointer that
 * runs into the next page must trap, also when the page is already cached.
 *
 * fields(): like run(), but the streaming side is a record whose fields are
 * read and written through one pointer: those accesses are merged into one
 * group translation (tools/instrument.mjs), and that translation is what
 * the TLB entry caches, while the random loads in between fault. The
 * second group's first read may be skipped, so it peeks (never faults) and
 * fills its entry only from a mapped page.
 *
 * straddlers(): merged groups whose range crosses a page (their per-access
 * fallback copies fault) next to a streaming TLB entry.
 */
#include "vera.h"

extern void host_hook(u32 i) __attribute__((import_module("env"), import_name("hook")));

VERA_EXPORT("run") u64 run(u32 npages, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 n = npages * 4096u / 8u;
    u64 *a = malloc((size_t)n * 8), *b = malloc((size_t)n * 8);
    if (!a || !b) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < n; i++) {
        a[i] = i;
        b[i] = (u64)i * 0x9E3779B97F4A7C15ull;
    }
    u64 s = seed, h = 0;
    for (u32 k = 0; k < ops; k++) {
        for (u32 i = 0; i < n; i++) {
            u64 r = vera_rng(&s);
            a[i] += b[(u32)r % n];                          /* store entry across a fault */
            h = vera_mix(h, a[i] ^ b[(u32)(r >> 32) % n]);  /* load entry across a fault */
        }
    }
    for (u32 i = 0; i < n; i++) h = vera_mix(h, a[i] + b[i]);
    free(a);
    free(b);
    return h;
}

VERA_EXPORT("hooked") u64 hooked(u32 npages, u32 every)
{
    vera_app_status = 0;
    u32 n = npages * 1024u;
    u32 *a = malloc((size_t)n * 4), *junk = malloc((size_t)n * 16);
    if (!a || !junk) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < n; i++) {
        a[i] = i * 7u + 1u;
        if (i % every == 0) host_hook(i);
    }
    /* Push a[] out of a small pool, then read it back. */
    for (u32 i = 0; i < n * 4; i++) junk[i] = i;
    u64 h = 0;
    for (u32 i = 0; i < n; i++) h = vera_mix(h, a[i]);
    free(a);
    free(junk);
    return h;
}

VERA_EXPORT("stack_sum") u64 stack_sum(u32 rounds, u32 seed)
{
    volatile u32 buf[3000]; /* ~12 KiB: spans identity pages of the stack */
    u64 s = seed, h = 0;
    for (u32 i = 0; i < 3000; i++) buf[i] = (u32)vera_rng(&s);
    for (u32 k = 0; k < rounds; k++)
        for (u32 i = 0; i < 3000; i++) buf[i] = buf[i] * 3u + k;
    for (u32 i = 0; i < 3000; i++) h = vera_mix(h, buf[i]);
    return h;
}

VERA_EXPORT("straddle") u64 straddle(u32 start, u32 count)
{
    u8 *raw = malloc(4 * 4096);
    u8 *page = (u8 *)(((u32)raw + 4095u) & ~4095u);
    u32 *p = (u32 *)(void *)(page + start);
    u64 h = 0;
    for (u32 i = 0; i < count; i++) {
        p[i] = i;
        h += p[i];
    }
    free(raw);
    return h;
}

typedef struct { u32 a, b, c, d; } rec4;

VERA_EXPORT("fields") u64 fields(u32 npages, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 n = npages * 4096u / (u32)sizeof(rec4), nb = npages * 1024u;
    rec4 *r = malloc((size_t)n * sizeof(rec4));
    u32 *b = malloc((size_t)nb * 4);
    if (!r || !b) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < n; i++) { r[i].a = i; r[i].b = ~i; r[i].c = i * 5u; r[i].d = 1; }
    for (u32 i = 0; i < nb; i++) b[i] = i * 0x9E3779B9u;
    u64 s = seed, h = 0;
    for (u32 k = 0; k < ops; k++) {
        for (u32 i = 0; i < n; i++) {
            u32 t = b[(u32)vera_rng(&s) % nb]; /* faults, may evict r[i]'s page */
            rec4 *p = &r[i];
            if (t & 1) h ^= t;
            if (t & 2) h += p->d; /* a group that peeks (a branch comes first) */
            if (t & 4) h ^= p->c;
            p->a += t;
            p->b ^= p->a;
        }
    }
    for (u32 i = 0; i < n; i++) h = vera_mix(h, r[i].a ^ r[i].b ^ r[i].c ^ r[i].d);
    free(r);
    free(b);
    return h;
}

/* straddlers(): a streaming loop (a TLB entry for a[i]) that also updates
 * two fields 252 bytes apart of a random 256-byte record: one merged group.
 * The records start 128 bytes into a page, so 1 in 16 crosses a page: then
 * the group's per-access fallback runs, and its faults may evict a[i]'s
 * page. The TLB entries are emptied once after such a fallback, not after
 * each of its translations. */
typedef struct { u32 f[64]; } rec64;

VERA_EXPORT("straddlers") u64 straddlers(u32 npages, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 n = npages * 512u, nr = npages * 64u; /* a: npages pages, r: 4 * npages */
    u64 *a = malloc((size_t)n * 8);
    u8 *raw = malloc((size_t)nr * sizeof(rec64) + 4096);
    if (!a || !raw) { vera_app_status = 1; return 0; }
    rec64 *r = (rec64 *)(void *)((((u32)raw + 4095u) & ~4095u) + 128u);
    for (u32 i = 0; i < n; i++) a[i] = i;
    for (u32 i = 0; i < nr; i++) { r[i].f[0] = i; r[i].f[63] = ~i; }
    u64 s = seed, h = 0;
    for (u32 k = 0; k < ops; k++) {
        for (u32 i = 0; i < n; i++) {
            u64 x = vera_rng(&s);
            rec64 *p = &r[(u32)x % nr];
            p->f[0] += (u32)x;
            p->f[63] ^= p->f[0];
            a[i] += p->f[63];
        }
    }
    for (u32 i = 0; i < n; i++) h = vera_mix(h, a[i]);
    for (u32 i = 0; i < nr; i++) h = vera_mix(h, r[i].f[0] ^ r[i].f[63]);
    free(a);
    free(raw);
    return h;
}
