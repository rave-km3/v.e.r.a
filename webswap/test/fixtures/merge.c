/* merge.c - accesses that instrument.mjs merges into one translation, under
 * constant eviction.
 *
 * 20-byte records over `npages` pages, a few more than a 64 KiB pool holds,
 * so frames are evicted all the time. Some records straddle a page boundary:
 * their merged groups take the per-access fallback. The operations:
 *   - field reads and writes through one pointer (one group, with fallback)
 *   - a read-modify-write of one field (one write translation, no fallback)
 *   - field reads guarded by branches (a group of loads with branches; it
 *     peeks when the first read may be skipped)
 *   - field updates that read through a second pointer in between: these
 *     must NOT be merged, because translating the second pointer may evict
 *     the first one's page (test/merge.test.mjs checks that a build which
 *     merges them anyway gets a wrong result)
 *
 * guarded() and once() check what the group's translation, done before the
 * run, may not do: fault a page the program does not touch, or fault before
 * a side effect that comes first.
 */
#include "vera.h"

typedef struct { u32 a, b, c, d, e; } rec;

VERA_EXPORT("run") u64 run(u32 npages, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 n = npages * 4096u / (u32)sizeof(rec);
    rec *r = malloc((size_t)n * sizeof(rec));
    if (!r) { vera_app_status = 1; return 0; }
    for (u32 i = 0; i < n; i++) {
        rec *p = &r[i];
        p->a = i; p->b = i * 3u; p->c = ~i; p->d = i ^ 0x55u; p->e = 7;
    }
    u64 s = seed, h = 0;
    for (u32 k = 0; k < ops; k++) {
        u64 x = vera_rng(&s);
        rec *p = &r[(u32)x % n], *q = &r[(u32)(x >> 32) % n];
        switch ((x >> 20) & 3) {
        case 0:
            p->a += p->b + p->c;
            p->d = p->a ^ p->e;
            break;
        case 1:
            p->c = (u32)x / ((u32)(x >> 40) | 1u); /* a possible trap before the first store: the group peeks */
            p->d ^= p->a;
            p->e += 5;
            break;
        case 2: {
            u32 t = 0;
            if (x & (1u << 28)) t = p->b; /* then the other reads may be skipped as well (a peek) */
            if (x & (1u << 25)) t += p->a;
            if (x & (1u << 26)) t += p->c * 3u;
            if (x & (1u << 27)) t ^= p->e;
            h = vera_mix(h, t);
            t = p->d; /* sure to run first (no peek) */
            if (x & (1u << 29)) t += p->a;
            if (x & (1u << 30)) t ^= p->c;
            h = vera_mix(h, t);
            break;
        }
        default:
            p->b += q->d;
            p->d ^= q->a;
            p->a += q->e;
            break;
        }
    }
    for (u32 i = 0; i < n; i++) h = vera_mix(h, r[i].a ^ r[i].b ^ r[i].c ^ r[i].d ^ r[i].e);
    free(r);
    return h;
}

/* guarded(): look() reads fields of a random record only in rare modes (1
 * call in 1024), and its branches test `mode`, not the record. A group
 * translation done before those branches would fault the record's page on
 * every call (test/merge.test.mjs counts the storage reads). */
typedef struct { u32 a, b, c, d; } obj;

__attribute__((noinline)) static u32 look(obj *p, u32 mode)
{
    u32 t = 0;
    if (mode == 1) t += p->a;
    if (mode == 2) t += p->b * 3u;
    if (mode == 3) t ^= p->c;
    return t;
}

VERA_EXPORT("guarded") u64 guarded(u32 npages, u32 ops, u32 seed)
{
    u32 n = npages * 256u;
    obj *o = malloc((size_t)n * sizeof(obj));
    if (!o) return 0;
    for (u32 i = 0; i < n; i += 256u) o[i].a = i; /* each page written once: it lives in storage */
    u64 s = seed, h = 0;
    for (u32 k = 0; k < ops; k++) {
        u64 x = vera_rng(&s);
        u32 mode = ((x >> 40) & 1023u) == 0 ? 1u + (u32)(x >> 50) % 3u : 0u;
        h = vera_mix(h, look(&o[(u32)x % n], mode));
    }
    free(o);
    return h;
}

/* once(): with c even, `progress` is stored before the record is read. If
 * reading the record's page fails (the backend throws), the store has
 * happened, as in program order. */
static rec *A;
u32 progress, result;

__attribute__((noinline)) static void step(rec *p, u32 c)
{
    u32 t = 0;
    if (c & 1) t += p->a;
    progress = 7;
    result = t + p->b;
}

VERA_EXPORT("setup_once") u32 setup_once(u32 npages)
{
    u32 n = npages * 4096u / (u32)sizeof(rec);
    A = malloc((size_t)n * sizeof(rec));
    if (!A) return 1;
    for (u32 i = 0; i < n; i++) A[i].a = A[i].b = i;
    progress = 0;
    return 0;
}

VERA_EXPORT("once") u32 once(u32 idx, u32 c) { step(&A[idx], c); return result; }
VERA_EXPORT("progress") u32 get_progress(void) { return progress; }
