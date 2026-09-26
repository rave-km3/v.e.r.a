/*
 * common.h - small helpers shared by all benchmarks.
 *
 * Header-only on purpose: every benchmark is a single .c file that can be
 * compiled on its own with `gcc -O2 -o foo foo.c` (plus -pthread where used).
 */
#ifndef BENCH_COMMON_H
#define BENCH_COMMON_H

#ifndef _GNU_SOURCE
#define _GNU_SOURCE /* O_DIRECT, MAP_POPULATE, madvise flags, ... */
#endif
#include <errno.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* ---- error handling --------------------------------------------------- */

__attribute__((noreturn, format(printf, 1, 2)))
static inline void die(const char *fmt, ...)
{
    va_list ap;
    int saved = errno;
    va_start(ap, fmt);
    fprintf(stderr, "error: ");
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    if (saved)
        fprintf(stderr, " (%s)", strerror(saved));
    fprintf(stderr, "\n");
    exit(1);
}

/* ---- timing ------------------------------------------------------------ */

/* Monotonic wall clock in nanoseconds. On x86 Linux with the TSC clocksource
 * this is a vDSO call (no syscall, ~15-25 ns) and it is ordered (lfence/rdtscp)
 * so it does not complete before earlier loads have finished. */
static inline uint64_t now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

/* Rough cost of one now_ns() call, so per-operation timings can be read
 * with the timer overhead in mind. */
static inline double timer_overhead_ns(void)
{
    const int n = 1000000;
    uint64_t t0 = now_ns();
    for (int i = 0; i < n; i++)
        (void)now_ns();
    return (double)(now_ns() - t0) / n;
}

/* ---- random numbers ---------------------------------------------------- */

/* splitmix64: tiny, fast, good enough for picking random offsets. */
static inline uint64_t rng_next(uint64_t *state)
{
    uint64_t z = (*state += 0x9E3779B97F4A7C15ull);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

/* Uniform integer in [0, n). The modulo bias is negligible for our n. */
static inline uint64_t rng_below(uint64_t *state, uint64_t n)
{
    return rng_next(state) % n;
}

/* Fill a buffer with pseudo-random, non-zero, incompressible bytes. */
static inline void fill_random(void *buf, size_t len, uint64_t seed)
{
    uint64_t *p = buf;
    size_t n = len / sizeof(uint64_t);
    for (size_t i = 0; i < n; i++)
        p[i] = rng_next(&seed) | 0x0101010101010101ull; /* no zero bytes */
    for (size_t i = n * sizeof(uint64_t); i < len; i++)
        ((uint8_t *)buf)[i] = 0xA5;
}

/* ---- statistics -------------------------------------------------------- */

static inline int cmp_u64(const void *a, const void *b)
{
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return (x > y) - (x < y);
}

static inline int cmp_double(const void *a, const void *b)
{
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

/* Median of n doubles (copies the input, does not modify it). */
static inline double median_d(const double *v, int n)
{
    double tmp[64];
    if (n <= 0 || n > 64)
        return 0.0;
    memcpy(tmp, v, n * sizeof(double));
    qsort(tmp, n, sizeof(double), cmp_double);
    return (n & 1) ? tmp[n / 2] : 0.5 * (tmp[n / 2 - 1] + tmp[n / 2]);
}

/* Latency summary of n samples (in ns). Sorts the array in place. */
typedef struct {
    double avg, p50, p90, p99, p999, max;
} lat_stats_t;

static inline lat_stats_t lat_summarize(uint64_t *ns, size_t n)
{
    lat_stats_t s = {0};
    if (n == 0)
        return s;
    long double sum = 0;
    for (size_t i = 0; i < n; i++)
        sum += ns[i];
    qsort(ns, n, sizeof(uint64_t), cmp_u64);
    s.avg = (double)(sum / n);
    s.p50 = (double)ns[(size_t)(0.50 * (n - 1))];
    s.p90 = (double)ns[(size_t)(0.90 * (n - 1))];
    s.p99 = (double)ns[(size_t)(0.99 * (n - 1))];
    s.p999 = (double)ns[(size_t)(0.999 * (n - 1))];
    s.max = (double)ns[n - 1];
    return s;
}

/* ---- argument parsing -------------------------------------------------- */

/* Parse sizes like "16K", "1M", "1G", "4096" (binary units). */
static inline uint64_t parse_size(const char *s)
{
    char *end;
    errno = 0;
    double v = strtod(s, &end);
    if (errno || end == s || v < 0)
        die("bad size '%s'", s);
    switch (*end) {
    case 'k': case 'K': v *= 1024.0; break;
    case 'm': case 'M': v *= 1024.0 * 1024; break;
    case 'g': case 'G': v *= 1024.0 * 1024 * 1024; break;
    case '\0': break;
    default: die("bad size suffix in '%s'", s);
    }
    return (uint64_t)v;
}

static inline const char *fmt_size(uint64_t bytes, char *buf, size_t len)
{
    if (bytes >= (1ull << 30) && bytes % (1ull << 30) == 0)
        snprintf(buf, len, "%lluG", (unsigned long long)(bytes >> 30));
    else if (bytes >= (1ull << 20) && bytes % (1ull << 20) == 0)
        snprintf(buf, len, "%lluM", (unsigned long long)(bytes >> 20));
    else if (bytes >= 1024 && bytes % 1024 == 0)
        snprintf(buf, len, "%lluK", (unsigned long long)(bytes >> 10));
    else
        snprintf(buf, len, "%lluB", (unsigned long long)bytes);
    return buf;
}

#endif /* BENCH_COMMON_H */
