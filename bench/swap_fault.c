/*
 * swap_fault.c - what "virtual RAM" (swap) feels like to a program.
 *
 * Allocates SIZE bytes of ordinary anonymous memory, fills it with
 * incompressible non-zero data (so neither zswap/zram nor the kernel's
 * zero-page shortcut can cheat), then reads one byte from N random pages,
 * timing each touch.
 *
 * Run it normally and every touch is a plain RAM access. Run it inside a
 * memory cgroup whose limit is smaller than SIZE, with swap enabled, and a
 * large fraction of the touches become swap-ins from storage (plus the
 * reclaim/swap-out work needed to make room). swap_try.sh does exactly that.
 *
 * Usage: swap_fault [-s size] [-n touches] [-r reps] [-w]
 *   -s  anonymous memory to allocate (default 768M)
 *   -n  random page touches per repetition (default 20000)
 *   -r  repetitions, median reported (default 3)
 *   -w  write to the page instead of reading it (dirties it again)
 *
 * Build: gcc -O2 -o swap_fault swap_fault.c
 */
#include "common.h"

#include <sys/mman.h>
#include <sys/resource.h>

/* Resident and swapped-out size of this process in MiB (from /proc). */
static void mem_status(long *rss_mb, long *swap_mb)
{
    char line[256];
    FILE *f = fopen("/proc/self/status", "r");
    *rss_mb = *swap_mb = -1;
    if (!f)
        return;
    while (fgets(line, sizeof line, f)) {
        long kb;
        if (sscanf(line, "VmRSS: %ld kB", &kb) == 1) *rss_mb = kb / 1024;
        if (sscanf(line, "VmSwap: %ld kB", &kb) == 1) *swap_mb = kb / 1024;
    }
    fclose(f);
}

int main(int argc, char **argv)
{
    size_t size = 768ull << 20, n = 20000;
    int reps = 3, do_write = 0, opt;
    while ((opt = getopt(argc, argv, "s:n:r:w")) != -1) {
        switch (opt) {
        case 's': size = parse_size(optarg); break;
        case 'n': n = strtoull(optarg, NULL, 0); break;
        case 'r': reps = atoi(optarg); break;
        case 'w': do_write = 1; break;
        default:
            fprintf(stderr, "usage: %s [-s size] [-n touches] [-r reps] [-w]\n", argv[0]);
            return 2;
        }
    }
    if (reps < 1 || reps > 64 || n == 0)
        die("bad arguments");
    long page = sysconf(_SC_PAGESIZE);
    size_t npages = size / page;

    uint8_t *mem = mmap(NULL, size, PROT_READ | PROT_WRITE,
                        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mem == MAP_FAILED)
        die("mmap");
    madvise(mem, size, MADV_NOHUGEPAGE); /* swap works on 4 KiB pages */
    long rss, swp;
    uint64_t t0 = now_ns();
    fill_random(mem, size, 1234);
    double fill_s = (now_ns() - t0) / 1e9;
    mem_status(&rss, &swp);
    printf("swap_fault size=%zuM fill_s=%.2f rss=%ldM swapped_out=%ldM\n",
           size >> 20, fill_s, rss, swp);

    uint64_t *lat = malloc(n * sizeof(uint64_t));
    if (!lat)
        die("malloc");
    uint64_t seed = 777;
    volatile uint64_t sink = 0;
    double avg[64], p50[64], p99[64], slow[64], slow_avg[64];

    for (int r = 0; r < reps; r++) {
        struct rusage ru0, ru1;
        getrusage(RUSAGE_SELF, &ru0);
        size_t nslow = 0;
        uint64_t slow_ns = 0; /* total time of the slow (> 5 us) touches */
        for (size_t i = 0; i < n; i++) {
            volatile uint8_t *a = mem + rng_below(&seed, npages) * page
                                      + rng_below(&seed, page);
            uint64_t s = now_ns();
            if (do_write)
                *a += 1;
            else
                sink += *a;
            lat[i] = now_ns() - s;
            if (lat[i] > 5000) { /* > 5 us: certainly not a RAM hit */
                nslow++;
                slow_ns += lat[i];
            }
        }
        getrusage(RUSAGE_SELF, &ru1);
        lat_stats_t st = lat_summarize(lat, n);
        avg[r] = st.avg; p50[r] = st.p50; p99[r] = st.p99;
        slow[r] = 100.0 * nslow / n;
        slow_avg[r] = nslow ? (double)slow_ns / nslow : 0;
        mem_status(&rss, &swp);
        printf("swap_fault rep=%d op=%s avg_ns=%.0f p50_ns=%.0f p90_ns=%.0f p99_ns=%.0f "
               "max_ns=%.0f touches_over_5us=%.1f%% avg_of_those_ns=%.0f major_faults=%ld "
               "rss=%ldM swapped_out=%ldM\n", r + 1, do_write ? "write" : "read", st.avg,
               st.p50, st.p90, st.p99, st.max, slow[r], slow_avg[r],
               ru1.ru_majflt - ru0.ru_majflt, rss, swp);
        fflush(stdout);
    }
    printf("RESULT swap_fault size=%zuM op=%s median_avg_ns=%.0f median_p50_ns=%.0f "
           "median_p99_ns=%.0f median_touches_over_5us=%.1f%% median_avg_slow_touch_ns=%.0f\n",
           size >> 20, do_write ? "write" : "read", median_d(avg, reps), median_d(p50, reps),
           median_d(p99, reps), median_d(slow, reps), median_d(slow_avg, reps));
    munmap(mem, size);
    free(lat);
    return 0;
}
