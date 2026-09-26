/*
 * ram_latency.c - DRAM (and cache) load-to-use latency via pointer chasing.
 *
 * The buffer is split into 64-byte elements (one cache line each). Every
 * element holds a pointer to the next element of a single random cycle
 * (Sattolo's algorithm), so:
 *   - each load depends on the previous one (no memory-level parallelism),
 *   - the access order is random (hardware prefetchers cannot help),
 *   - with a buffer much larger than the last-level cache, nearly every
 *     load is a cache miss (and, with 4 KiB pages, usually a TLB miss too).
 * The result is the average time of one dependent load, in ns.
 *
 * Usage: ram_latency [-r reps] [-n steps] [-H] SIZE [SIZE...]
 *   SIZE   buffer size, e.g. 16K 1G 4G           (default: 16K 1G)
 *   -r     repetitions per size, median reported (default 3)
 *   -n     loads per repetition                  (default: auto)
 *   -H     ask for transparent huge pages (MADV_HUGEPAGE): removes most
 *          TLB-miss cost, showing "pure" DRAM latency
 *
 * Build: gcc -O2 -o ram_latency ram_latency.c
 */
#include "common.h"

#include <sys/mman.h>

#define LINE 64

typedef struct node {
    struct node *next;
    char pad[LINE - sizeof(struct node *)];
} node_t;

_Static_assert(sizeof(node_t) == LINE, "node must be one cache line");

/* Keeps the compiler from deleting the chase loop. */
static volatile uintptr_t g_sink;

/* Follow the chain `steps` times. Unrolled 8x; each load still depends on
 * the previous one, so unrolling only removes loop overhead. */
static node_t *chase(node_t *p, uint64_t steps)
{
    while (steps >= 8) {
        p = p->next; p = p->next; p = p->next; p = p->next;
        p = p->next; p = p->next; p = p->next; p = p->next;
        steps -= 8;
    }
    while (steps--)
        p = p->next;
    return p;
}

static node_t *build_cycle(uint64_t bytes, int hugepages, uint64_t seed)
{
    uint64_t n = bytes / LINE;
    if (n < 2)
        die("size too small");
    if (n > UINT32_MAX)
        die("size too large for 32-bit indices");

    /* Anonymous mmap: page-aligned, and 2 MiB aligned in practice for large
     * sizes, which lets THP back it if requested. */
    node_t *buf = mmap(NULL, n * LINE, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (buf == MAP_FAILED)
        die("mmap %llu bytes", (unsigned long long)bytes);
    if (hugepages && madvise(buf, n * LINE, MADV_HUGEPAGE) != 0)
        fprintf(stderr, "warning: MADV_HUGEPAGE failed (%s)\n", strerror(errno));
    if (!hugepages)
        madvise(buf, n * LINE, MADV_NOHUGEPAGE);
    memset(buf, 0, n * LINE); /* fault everything in before timing */

    /* Sattolo's algorithm: a uniformly random permutation consisting of ONE
     * cycle through all n elements (i -> idx[i]). */
    uint32_t *idx = malloc(n * sizeof(uint32_t));
    if (!idx)
        die("malloc index array");
    for (uint64_t i = 0; i < n; i++)
        idx[i] = (uint32_t)i;
    for (uint64_t i = n - 1; i > 0; i--) {
        uint64_t j = rng_below(&seed, i); /* j in [0, i) -> single cycle */
        uint32_t t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    for (uint64_t i = 0; i < n; i++)
        buf[i].next = &buf[idx[i]];
    free(idx);
    return buf;
}

static void run_size(uint64_t bytes, int reps, uint64_t steps_opt, int huge)
{
    char sz[32];
    uint64_t n = bytes / LINE;
    /* Enough loads for ~0.5-2 s per repetition. */
    uint64_t steps = steps_opt ? steps_opt
                   : (bytes <= (64ull << 20) ? 200000000ull : 20000000ull);

    node_t *buf = build_cycle(bytes, huge, 0x1234abcdull + bytes);

    /* Warm-up: walk the whole cycle once (or `steps` loads if smaller) so the
     * caches/TLB reach steady state before timing. */
    node_t *p = chase(buf, n < steps ? n : steps);

    double ns[64];
    if (reps > 64)
        reps = 64;
    for (int r = 0; r < reps; r++) {
        uint64_t t0 = now_ns();
        p = chase(p, steps);
        uint64_t t1 = now_ns();
        ns[r] = (double)(t1 - t0) / (double)steps;
        printf("ram_latency size=%s hugepages=%s rep=%d ns_per_load=%.2f\n",
               fmt_size(bytes, sz, sizeof sz), huge ? "yes" : "no", r + 1, ns[r]);
        fflush(stdout);
    }
    g_sink = (uintptr_t)p;
    printf("RESULT ram_latency size=%s hugepages=%s median_ns_per_load=%.2f\n",
           fmt_size(bytes, sz, sizeof sz), huge ? "yes" : "no", median_d(ns, reps));
    munmap(buf, n * LINE);
}

int main(int argc, char **argv)
{
    int reps = 3, huge = 0, opt;
    uint64_t steps = 0;
    while ((opt = getopt(argc, argv, "r:n:H")) != -1) {
        switch (opt) {
        case 'r': reps = atoi(optarg); break;
        case 'n': steps = strtoull(optarg, NULL, 0); break;
        case 'H': huge = 1; break;
        default:
            fprintf(stderr, "usage: %s [-r reps] [-n steps] [-H] SIZE...\n", argv[0]);
            return 2;
        }
    }
    if (optind == argc) {
        run_size(16ull << 10, reps, steps, huge);
        run_size(1ull << 30, reps, steps, huge);
    } else {
        for (int i = optind; i < argc; i++)
            run_size(parse_size(argv[i]), reps, steps, huge);
    }
    return 0;
}
