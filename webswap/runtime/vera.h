/*
 * vera.h - shared definitions for v.e.r.a WebSwap programs.
 *
 * Programs are freestanding C compiled to wasm32 (no libc). This header
 * provides fixed-width types, the small libc subset in vera-libc.c, and
 * helpers the demo apps use (PRNG, checksum).
 *
 * In a paged build (VERA_PAGED=1) malloc() hands out *virtual* addresses at
 * or above VERA_VBASE. Every load/store of the program is rewritten at build
 * time to go through the software MMU in softmmu.c, so those addresses work
 * even though the real WebAssembly.Memory is much smaller.
 */
#ifndef VERA_H
#define VERA_H

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef signed char i8;
typedef short i16;
typedef int i32;
typedef long long i64;
typedef unsigned long size_t;

#define NULL ((void *)0)

/* First virtual address. Everything below is identity-mapped physical memory
 * (data, stack, page table, frame pool). Override with -DVERA_VBASE=... */
#ifndef VERA_VBASE
#define VERA_VBASE 0x10000000u
#endif
#define VERA_PAGE_SHIFT 12u
#define VERA_PAGE_SIZE (1u << VERA_PAGE_SHIFT)
/* Virtual pages from VBASE up to the 4 GiB limit of wasm32. */
#define VERA_NVP ((u32)((0x100000000ull - VERA_VBASE) >> VERA_PAGE_SHIFT))

#define VERA_EXPORT(name) __attribute__((export_name(name)))
#define VERA_IMPORT(mod, name) __attribute__((import_module(mod), import_name(name)))

/* ---- libc subset (vera-libc.c) ---------------------------------------- */
void *malloc(size_t n);
void *calloc(size_t n, size_t size);
void *realloc(void *p, size_t n);
void free(void *p);
void *memcpy(void *dst, const void *src, size_t n);
void *memmove(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);

/* Set by the apps: 0 = ok, 1 = allocation failed. */
extern u32 vera_app_status;

/* ---- helpers for the demo apps ----------------------------------------- */
static inline u64 vera_rng(u64 *s)
{ /* splitmix64 */
    u64 z = (*s += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

static inline u64 vera_mix(u64 h, u64 x)
{ /* order-dependent checksum step */
    h ^= x + 0x9E3779B97F4A7C15ull + (h << 6) + (h >> 2);
    return h * 0x100000001B3ull;
}

#endif
