/*
 * mmap_fault.c - "storage that looks like memory": page-fault cost of mmap.
 *
 * The test file is mapped read-only (MAP_SHARED), so to the program it is
 * just an array in memory. Touching a page that is not in RAM makes the CPU
 * trap into the kernel, which reads the page from storage (a MAJOR fault)
 * and maps it. This is exactly the mechanism behind swap / "virtual RAM".
 *
 * For N random, distinct pages we measure three passes, each touch timed
 * individually (read one byte of the page):
 *   1. cold  : file evicted from the page cache -> major fault, disk read
 *   2. warm  : same pages again; they are now in RAM and mapped -> an
 *              ordinary DRAM load (plus TLB miss). CPU caches are scrubbed
 *              first by streaming through a 1 GiB buffer, so this really is
 *              DRAM and not L2/L3.
 *   3. minor : unmap + remap, then same pages again; the data is still in
 *              the page cache, but the page tables are empty -> MINOR fault
 *              (kernel entry + page-table update, no I/O)
 *
 * Read-ahead policy (-a):
 *   random  MADV_RANDOM: exactly one 4 KiB page is read per major fault.
 *   normal  default policy: every major fault also reads the surrounding
 *           read-ahead window (read_ahead_kb of the device), which is great
 *           for sequential access and wasteful for random access. The
 *           number of pages brought into RAM per fault is reported.
 *
 * Usage: mmap_fault -f FILE [-n pages] [-r reps] [-a random|normal]
 *   -n  distinct random pages touched per repetition (default 20000)
 *   -r  repetitions, median reported (default 3)
 *
 * Build: gcc -O2 -o mmap_fault mmap_fault.c
 */
#include "common.h"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>

static long g_page;
static volatile uint64_t g_sink;

/* Number of pages of [p, p+len) that are resident in the page cache. */
static uint64_t resident_pages(void *p, size_t len)
{
    size_t n = (len + g_page - 1) / g_page;
    unsigned char *vec = malloc(n);
    if (!vec || mincore(p, len, vec) != 0)
        die("mincore");
    uint64_t c = 0;
    for (size_t i = 0; i < n; i++)
        c += vec[i] & 1;
    free(vec);
    return c;
}

/* Stream through a buffer larger than the last-level cache so that the
 * lines we touched earlier are no longer cached. */
static void scrub_caches(const uint64_t *scrub, size_t words)
{
    uint64_t s = 0;
    for (size_t i = 0; i < words; i += 8) /* one load per 64-byte line */
        s += scrub[i];
    g_sink += s;
}

/* Touch one byte in each listed page; lat[i] = ns for the i-th touch. */
static void touch_pages(const volatile uint8_t *base, const uint32_t *pages,
                        size_t n, uint64_t *lat)
{
    uint64_t sum = 0;
    for (size_t i = 0; i < n; i++) {
        const volatile uint8_t *addr = base + (size_t)pages[i] * g_page;
        uint64_t t0 = now_ns();
        sum += *addr; /* may page-fault; the timer after it waits for the load */
        uint64_t t1 = now_ns();
        lat[i] = t1 - t0;
    }
    g_sink += sum;
}

static void *map_file(int fd, size_t size, int advice)
{
    void *p = mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED)
        die("mmap");
    if (madvise(p, size, advice) != 0)
        die("madvise");
    return p;
}

int main(int argc, char **argv)
{
    const char *path = NULL, *adv = "random";
    size_t n = 20000;
    int reps = 3, opt;
    while ((opt = getopt(argc, argv, "f:n:r:a:")) != -1) {
        switch (opt) {
        case 'f': path = optarg; break;
        case 'n': n = strtoull(optarg, NULL, 0); break;
        case 'r': reps = atoi(optarg); break;
        case 'a': adv = optarg; break;
        default: path = NULL; optind = argc; break;
        }
    }
    int advice = !strcmp(adv, "random") ? MADV_RANDOM
               : !strcmp(adv, "normal") ? MADV_NORMAL : -1;
    if (!path || advice < 0 || n == 0 || reps < 1 || reps > 64) {
        fprintf(stderr, "usage: %s -f FILE [-n pages] [-r reps] [-a random|normal]\n",
                argv[0]);
        return 2;
    }

    g_page = sysconf(_SC_PAGESIZE);
    int fd = open(path, O_RDONLY);
    if (fd < 0)
        die("open %s", path);
    struct stat st;
    if (fstat(fd, &st) != 0)
        die("fstat");
    size_t size = (size_t)st.st_size;
    size_t npages = size / g_page;
    if (n > npages)
        n = npages;

    /* 1 GiB scrub buffer (> the 260 MiB L3 seen on typical servers). */
    size_t scrub_bytes = 1ull << 30;
    uint64_t *scrub = malloc(scrub_bytes);
    if (!scrub)
        die("malloc scrub");
    memset(scrub, 1, scrub_bytes);

    uint32_t *all = malloc(npages * sizeof(uint32_t));
    uint64_t *lat = malloc(n * sizeof(uint64_t));
    if (!all || !lat)
        die("malloc");

    printf("mmap_fault file_pages=%zu page=%ld touches=%zu advice=%s timer_overhead_ns=%.1f\n",
           npages, g_page, n, adv, timer_overhead_ns());

    double cold_avg[64], cold_p50[64], cold_p99[64], warm_avg[64], warm_p50[64],
           minor_avg[64], minor_p50[64], ra[64];
    for (int r = 0; r < reps; r++) {
        /* Pick n distinct random pages (partial Fisher-Yates shuffle). */
        uint64_t seed = 0xFA017 + (uint64_t)r;
        for (size_t i = 0; i < npages; i++)
            all[i] = (uint32_t)i;
        for (size_t i = 0; i < n; i++) {
            size_t j = i + rng_below(&seed, npages - i);
            uint32_t t = all[i]; all[i] = all[j]; all[j] = t;
        }

        /* Evict the file from the page cache (nothing is mapped right now). */
        int rc = posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
        if (rc != 0)
            fprintf(stderr, "warning: fadvise DONTNEED: %s\n", strerror(rc));

        uint8_t *p = map_file(fd, size, advice);
        uint64_t res0 = resident_pages(p, size);

        /* Pass 1: cold -> major faults served from storage. */
        touch_pages(p, all, n, lat);
        uint64_t res1 = resident_pages(p, size);
        lat_stats_t c = lat_summarize(lat, n);

        /* Pass 2: warm -> pages are in RAM and mapped. */
        scrub_caches(scrub, scrub_bytes / 8);
        touch_pages(p, all, n, lat);
        lat_stats_t w = lat_summarize(lat, n);

        /* Pass 3: remap -> minor faults (in page cache, not in page table). */
        munmap(p, size);
        p = map_file(fd, size, advice);
        scrub_caches(scrub, scrub_bytes / 8);
        touch_pages(p, all, n, lat);
        lat_stats_t m = lat_summarize(lat, n);
        munmap(p, size);

        ra[r] = (double)(res1 - res0) / (double)n;
        cold_avg[r] = c.avg; cold_p50[r] = c.p50; cold_p99[r] = c.p99;
        warm_avg[r] = w.avg; warm_p50[r] = w.p50;
        minor_avg[r] = m.avg; minor_p50[r] = m.p50;
        printf("mmap_fault rep=%d resident_before=%llu resident_after_cold=%llu "
               "pages_read_per_fault=%.1f\n", r + 1, (unsigned long long)res0,
               (unsigned long long)res1, ra[r]);
        printf("  cold  (major fault) avg_ns=%.0f p50_ns=%.0f p99_ns=%.0f max_ns=%.0f\n",
               c.avg, c.p50, c.p99, c.max);
        printf("  warm  (in RAM)      avg_ns=%.0f p50_ns=%.0f p99_ns=%.0f max_ns=%.0f\n",
               w.avg, w.p50, w.p99, w.max);
        printf("  minor (page cache)  avg_ns=%.0f p50_ns=%.0f p99_ns=%.0f max_ns=%.0f\n",
               m.avg, m.p50, m.p99, m.max);
        fflush(stdout);
    }
    posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);

    double ca = median_d(cold_avg, reps), wa = median_d(warm_avg, reps);
    printf("RESULT mmap_fault advice=%s cold_major_avg_ns=%.0f cold_p50_ns=%.0f "
           "cold_p99_ns=%.0f warm_avg_ns=%.0f warm_p50_ns=%.0f minor_avg_ns=%.0f "
           "minor_p50_ns=%.0f pages_read_per_fault=%.1f cold/warm=%.0fx\n",
           adv, ca, median_d(cold_p50, reps), median_d(cold_p99, reps), wa,
           median_d(warm_p50, reps), median_d(minor_avg, reps),
           median_d(minor_p50, reps), median_d(ra, reps), ca / wa);
    free(all); free(lat); free(scrub);
    close(fd);
    return 0;
}
