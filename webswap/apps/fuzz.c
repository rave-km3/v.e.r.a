/*
 * fuzz.c - differential test program.
 *
 * Performs a seeded random mix of memory operations over a heap buffer:
 * every access width and type, signed loads, unaligned (packed) accesses
 * including signed and float ones, accesses that straddle page boundaries,
 * memcpy/memmove (both directions)/memset, and read-modify-writes whose
 * stored value comes from another load. Returns a checksum of everything it
 * read plus the final buffer contents. (The eviction-between-translate-and-
 * store hazard is exercised specifically by test/fixtures/rmw.c, whose
 * working set is just larger than the pool.)
 *
 * The paged build (vera) and the baseline build must return the same value
 * for the same arguments.
 */
#include "vera.h"

typedef struct __attribute__((packed)) { u16 v; } pu16;
typedef struct __attribute__((packed)) { u32 v; } pu32;
typedef struct __attribute__((packed)) { u64 v; } pu64;
typedef struct __attribute__((packed)) { float v; } pf32;
typedef struct __attribute__((packed)) { double v; } pf64;
typedef struct __attribute__((packed)) { i16 v; } pi16;
typedef struct __attribute__((packed)) { i32 v; } pi32;

static u64 bits_f64(double d) { union { double d; u64 u; } c; c.d = d; return c.u; }
static u64 bits_f32(float f) { union { float f; u32 u; } c; c.f = f; return c.u; }

VERA_EXPORT("run") u64 run(u32 mbytes, u32 ops, u32 seed)
{
    vera_app_status = 0;
    u32 len = mbytes << 20;
    u8 *buf = malloc(len);
    if (!buf) { vera_app_status = 1; return 0; }
    /* Deliberately leave most of the buffer untouched (zero pages). */
    memset(buf, 0xA5, len / 16);

    u64 s = seed, h = 0;
    for (u32 i = 0; i < ops; i++) {
        u64 r = vera_rng(&s);
        u32 off = (u32)(r >> 20) % (len - 128);
        u8 *p = buf + off;
        u8 *q = buf + (u32)(vera_rng(&s) >> 20) % (len - 128);
        switch (r & 31) {
        case 0: *p = (u8)(r >> 40); break;
        case 1: *(u16 *)((u32)p & ~1u) = (u16)(r >> 32); break;
        case 2: *(u32 *)((u32)p & ~3u) = (u32)(r >> 24); break;
        case 3: *(u64 *)((u32)p & ~7u) = r * 3; break;
        case 4: *(double *)((u32)p & ~7u) = (double)(r >> 11) * 0.5; break;
        case 5: *(float *)((u32)p & ~3u) = (float)(r >> 40); break;
        case 6: h = vera_mix(h, *(u32 *)((u32)p & ~3u)); break;
        case 7: h = vera_mix(h, *(u64 *)((u32)p & ~7u)); break;
        case 8: h = vera_mix(h, (u64)(i64) * (i8 *)p); break;
        case 9: h = vera_mix(h, (u64)(i64) * (i16 *)((u32)p & ~1u)); break;
        case 10: h = vera_mix(h, (u64)(i64) * (i32 *)((u32)p & ~3u)); break;
        case 11: h = vera_mix(h, bits_f64(*(double *)((u32)p & ~7u))); break;
        case 12: h = vera_mix(h, bits_f32(*(float *)((u32)p & ~3u))); break;
        case 13: ((pu16 *)p)->v = (u16)r; break;
        case 14: ((pu32 *)p)->v = (u32)r; break;
        case 15: ((pu64 *)p)->v = r; break;
        case 16: h = vera_mix(h, ((pu16 *)p)->v); break;
        case 17: h = vera_mix(h, ((pu32 *)p)->v); break;
        case 18: h = vera_mix(h, ((pu64 *)p)->v); break;
        case 19: ((pf64 *)p)->v = (double)(r & 0xFFFFF); break;
        case 20: h = vera_mix(h, bits_f64(((pf64 *)p)->v)); break;
        case 21: ((pf32 *)p)->v = (float)(r & 0xFFFF); h = vera_mix(h, bits_f32(((pf32 *)p)->v)); break;
        case 22: { /* unaligned 8-byte store straddling a page boundary */
            u8 *x = (u8 *)(((u32)p & ~4095u) + 4093u);
            if ((u32)x + 8 < (u32)buf + len) ((pu64 *)x)->v = r ^ 0x5555;
            break;
        }
        case 23: { /* unaligned signed 16-bit load straddling a page boundary */
            volatile pi16 *x = (volatile pi16 *)(((u32)p & ~4095u) + 4095u);
            if ((u32)x + 2 < (u32)buf + len) h = vera_mix(h, (u64)(i64)x->v);
            break;
        }
        case 24: memcpy(p, q, (r >> 50) & 127); break;
        case 25: /* overlapping moves in both directions */
            if (r & (1ull << 45)) memmove(p, p + ((r >> 50) & 31), (r >> 40) & 63);
            else memmove(p + ((r >> 50) & 31), p, (r >> 40) & 63);
            break;
        case 26: memset(p, (int)(r >> 33), (r >> 50) & 127); break;
        case 27: /* store whose value is loaded from elsewhere */
            *(u64 *)((u32)p & ~7u) += *(u64 *)((u32)q & ~7u);
            break;
        case 28: *(u32 *)((u32)p & ~3u) = *(u32 *)((u32)q & ~3u) * 7u + *(u32 *)((u32)(q + 64) & ~3u); break;
        case 29: h = vera_mix(h, (u64)memcmp(p, q, (r >> 50) & 15)); break;
        case 30: { /* offset stored in memory, then followed (offsets, not
                    * pointers, so both builds see identical memory contents) */
            u32 *slot = (u32 *)((u32)p & ~3u);
            *slot = (u32)(q - buf) & ~7u;
            h = vera_mix(h, *(buf + *slot));
            break;
        }
        default: /* 31: signed and float loads through packed (unaligned) fields */
            h = vera_mix(h, (u64)(i64)((volatile pi16 *)p)->v);
            h = vera_mix(h, (u64)(i64)((volatile pi32 *)(p + 1))->v);
            h = vera_mix(h, bits_f32(((volatile pf32 *)(p + 3))->v));
            break;
        }
    }
    const u64 *w = (const u64 *)buf;
    for (u32 i = 0; i < len / 8; i++) h = vera_mix(h, w[i]);
    free(buf);
    return h;
}
